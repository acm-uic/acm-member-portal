#Requires -Version 5.1
# Run in a fresh PowerShell process. Host operations are mocked; no elevation,
# .NET SDK, AD credentials, or service changes are needed. A temporary Windows script
# exercises the real native-command helper before the mocked scenarios.
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'deploy.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
Add-Type -AssemblyName System.ServiceProcess
Add-Type -AssemblyName System.Net.Http

$native = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-NativeCommand'
}, $true)
Invoke-Expression $native.Extent.Text
$realNativeCommand = (Get-Item Function:Invoke-NativeCommand).ScriptBlock
# The round-trip checks invoke the captured block directly. Deployment scenarios
# must resolve the mock, regardless of the scope used to launch this test script.
Remove-Item Function:Invoke-NativeCommand
$source = Get-Content $sourcePath -Raw
$sidResolver = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-AccountSid'
}, $true)
Invoke-Expression $sidResolver.Extent.Text
$realSidResolver = (Get-Item Function:Resolve-AccountSid).ScriptBlock
Remove-Item Function:Resolve-AccountSid
$healthRequester = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-HealthRequest'
}, $true)
Invoke-Expression $healthRequester.Extent.Text
$realHealthRequester = (Get-Item Function:Invoke-HealthRequest).ScriptBlock
Remove-Item Function:Invoke-HealthRequest
foreach ($definition in @($native, $sidResolver, $healthRequester) | Sort-Object { $_.Extent.StartOffset } -Descending) {
    $source = $source.Remove($definition.Extent.StartOffset, $definition.Extent.EndOffset - $definition.Extent.StartOffset)
}
$source = $source -replace '(?m)^#Requires.*\r?\n', ''
$temp = Join-Path $env:TEMP ('deploy-test-' + [guid]::NewGuid())
New-Item -ItemType Directory $temp | Out-Null
$mockSource = Join-Path $temp 'source'
New-Item -ItemType Directory $mockSource | Out-Null
$mockScript = Join-Path $mockSource 'deploy.ps1'
Set-Content $mockScript $source

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
function global:Get-Command {
    param($Name, $ErrorAction)
    [pscustomobject]@{ Source = "mock-$Name" }
}
function global:mock-dotnet.exe {
    param($Option)
    $global:LASTEXITCODE = 0
    if ($Option -eq '--list-sdks') {
        if (-not $global:NoSdk) { '10.0.100 [mock]' }
    }
    else { 'Microsoft.AspNetCore.App 10.0.1 [mock]' }
}
function global:Invoke-NativeCommand {
    param($FilePath, [string[]]$Arguments)
    Assert-True (-not (($Arguments -join '|').Contains($global:TestPassword))) 'Password exposed in a native command'
    $global:Calls.Add((@($FilePath) + $Arguments) -join '|')
    if ($Arguments[0] -eq 'publish') {
        if ($global:FailBuild) { throw 'Mock publish failed' }
        $stage = $Arguments[5]
        $global:Stages.Add($stage)
        New-Item -ItemType Directory $stage | Out-Null
        Set-Content (Join-Path $stage 'AcmProvisioning.exe') 'mock binary'
        if ($global:InvalidLogDuringPublish) {
            New-Item -ItemType Directory -Path (Join-Path $global:Install 'service-boot.log') -Force | Out-Null
        }
    }
}
function global:Get-Service {
    param($Name, $ErrorAction)
    if ($global:ExistingService -or ($global:Calls -match 'mock-sc.exe\|start')) {
        $service = New-Object PSObject
        $service | Add-Member ScriptMethod WaitForStatus {
            param($Status, $Timeout)
            $global:Calls.Add("wait|$Status")
        }
        $service
    }
}
function global:Stop-Service {
    param($Name, $ErrorAction)
    $global:Calls.Add("stop|$Name")
}
function global:Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    Assert-True ($ClassName -eq 'Win32_Service' -and $Filter -eq "Name='AcmProvisioning'") 'Incorrect CIM service query'
    [pscustomobject]@{ Name = 'AcmProvisioning'; StartName = $global:PreviousAccount }
}
function global:Resolve-AccountSid {
    param($AccountName)
    switch ($AccountName) {
        'ACMUIC\acmmemberportal' { 'S-1-5-21-100-100-100-1101' }
        'acmmemberportal@acmuic.org' { 'S-1-5-21-100-100-100-1101' }
        'ACMUIC\formeraccount' { 'S-1-5-21-100-100-100-1100' }
        'LocalSystem' { 'S-1-5-18' }
        'NT AUTHORITY\LocalService' { 'S-1-5-19' }
        'NT AUTHORITY\NetworkService' { 'S-1-5-20' }
        default { throw 'Account SID lookup failed' }
    }
}
function global:Invoke-CimMethod {
    param($ClassName, $InputObject, $MethodName, $Arguments, $ErrorAction)
    Assert-True ($Arguments.StartPassword -ceq $global:TestPassword) 'Incorrect password passed to CIM'
    Assert-True ($Arguments.StartName -eq 'ACMUIC\acmmemberportal') 'Incorrect service account'
    Assert-True ($Arguments.StartMode -eq 'Automatic') 'Incorrect startup mode'
    Assert-True ($Arguments.PathName -ceq ('"' + (Join-Path $global:Install 'AcmProvisioning.exe') + '" --windows-service')) 'Incorrect binary path'
    if ($MethodName -eq 'Create') {
        Assert-True ($ClassName -eq 'Win32_Service') 'Incorrect CIM create target'
        Assert-True ($Arguments.Name -eq 'AcmProvisioning' -and $Arguments.ServiceType -eq 16 -and $Arguments.ErrorControl -eq 1) 'Incorrect create settings'
    }
    else {
        Assert-True ($MethodName -eq 'Change' -and $InputObject.Name -eq 'AcmProvisioning') 'Incorrect CIM change target'
        Assert-True ($Arguments.Count -eq 4) 'Change overrides unrelated settings'
    }
    $global:Calls.Add("cim|$MethodName")
    $global:LastCimArguments = $Arguments
    @{ ReturnValue = $global:CimReturnCode }
}
function global:Invoke-HealthRequest {
    param($Uri, $TimeoutMilliseconds)
    Assert-True ($TimeoutMilliseconds -gt 0 -and $TimeoutMilliseconds -le 5000) 'Invalid health request timeout'
    $global:HealthTimeouts.Add([int]$TimeoutMilliseconds)
    if ($global:FailHealth) { throw 'Mock unhealthy' }
    @{ status = 'ok' }
}

try {
    $listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        $stalledUri = [uri]("http://127.0.0.1:$($listener.LocalEndpoint.Port)/healthz")
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $timedOut = $false
        try { & $realHealthRequester -Uri $stalledUri -TimeoutMilliseconds 150 | Out-Null }
        catch {
            $failure = $_.Exception
            while ($failure.InnerException) { $failure = $failure.InnerException }
            Assert-True ($failure -is [TimeoutException] -or $failure -is [OperationCanceledException]) 'Stalled HTTP request failed for a reason other than timeout'
            $timedOut = $true
        }
        Assert-True $timedOut 'Stalled HTTP request did not time out'
        Assert-True ($timer.Elapsed.TotalMilliseconds -ge 100) 'HTTP request failed before exercising the timeout'
        Assert-True ($timer.Elapsed.TotalMilliseconds -lt 1500) 'HTTP request exceeded its bounded wait'
    }
    finally { $listener.Stop() }
    Write-Host 'PASS: Real stalled HTTP request uses a bounded wait'
    $caller = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        Assert-True ((& $realSidResolver $caller.Name) -eq $caller.User.Value) 'Real account SID resolution did not match the caller token'
    }
    finally { $caller.Dispose() }
    Assert-True ((& $realSidResolver 'LocalSystem') -eq 'S-1-5-18') 'SCM SYSTEM alias did not resolve'
    Assert-True ((& $realSidResolver 'NT AUTHORITY\LocalService') -eq 'S-1-5-19') 'SCM LocalService alias did not resolve'
    Assert-True ((& $realSidResolver 'NT AUTHORITY\NetworkService') -eq 'S-1-5-20') 'SCM NetworkService alias did not resolve'
    Write-Host 'PASS: Real account SID resolution and SCM built-in aliases'
    $scriptHost = Join-Path $PSHOME 'powershell.exe'
    $argumentScript = Join-Path $temp 'native arguments.ps1'
    Set-Content $argumentScript @'
if ($args.Count -eq 1 -and $args[0] -eq 'fail') { exit 7 }
$outputPath = $args[0]
[IO.File]::WriteAllLines($outputPath, [string[]]$args[1..($args.Count - 1)])
'@
    $argFile = Join-Path $temp 'arguments.txt'
    $expected = @('path with spaces', '"embedded quotes"', '', '$(literal)` & | <> chars', 'trailing slash\', 'two trailing slashes\\', 'slash before quote\"')
    & $realNativeCommand $scriptHost (@('-NoProfile', '-NonInteractive', '-File', $argumentScript, $argFile) + $expected)
    $actual = @(Get-Content $argFile)
    Assert-True ($actual.Count -eq $expected.Count) 'Native argument count mismatch'
    for ($i = 0; $i -lt $expected.Count; $i++) {
        Assert-True ($actual[$i] -ceq $expected[$i]) "Native argument mismatch at $i"
    }
    try { & $realNativeCommand $scriptHost @('-NoProfile', '-NonInteractive', '-File', $argumentScript, 'fail'); throw 'Expected child process failure' }
    catch { if ($_.Exception.Message -notlike '*failed with exit code 7.') { throw } }
    Write-Host 'PASS: Real native helper argument round-trip and nonzero exit handling'

    $global:TestPassword = 'test password with "quotes" & symbols'
    $credential = New-Object System.Management.Automation.PSCredential('ACMUIC\acmmemberportal', (ConvertTo-SecureString $global:TestPassword -AsPlainText -Force))
    $global:Calls = New-Object 'System.Collections.Generic.List[string]'
    $global:Stages = New-Object 'System.Collections.Generic.List[string]'
    $global:HealthTimeouts = New-Object 'System.Collections.Generic.List[int]'
    $global:Install = Join-Path $temp 'install with spaces'
    $global:NoSdk = $false
    $global:FailBuild = $false
    $global:FailHealth = $false
    $global:CimReturnCode = 0
    $global:PreviousAccount = 'ACMUIC\acmmemberportal'
    $global:InvalidLogDuringPublish = $false
    # Missing-SDK fallback keeps these checks harmless if a path guard regresses.
    $global:NoSdk = $true
    foreach ($unsafePath in @([IO.Path]::GetPathRoot($temp), $temp, $env:TEMP, $mockSource, (Join-Path $mockSource 'bin\Release'), '\\deployment-test.invalid\share', '\\deployment-test.invalid\share\')) {
        try { & $mockScript -InstallPath $unsafePath -ServiceCredential $credential; throw 'Expected unsafe path rejection' }
        catch { if ($_.Exception.Message -notlike 'InstallPath must be a dedicated application directory*') { throw } }
        Assert-True ($global:Calls.Count -eq 0) 'Unsafe installation path reached host operations'
    }
    foreach ($devicePrefix in @('\\?\', '\\.\', '//?/', '//./', '\\?/', '\\./', '/\?\', '\/?\')) {
        try { & $mockScript -InstallPath ($devicePrefix + $mockSource) -ServiceCredential $credential; throw 'Expected device path rejection' }
        catch { if ($_.Exception.Message -ne 'InstallPath must use a regular filesystem path, without a device prefix.') { throw } }
    }
    foreach ($relativePath in @('C:', 'C:relative', 'relative', '\relative', '/relative')) {
        try { & $mockScript -InstallPath $relativePath -ServiceCredential $credential; throw 'Expected relative path rejection' }
        catch { if ($_.Exception.Message -ne 'InstallPath must be an absolute drive or UNC path.') { throw } }
        Assert-True ($global:Calls.Count -eq 0) 'Relative installation path reached host operations'
    }
    foreach ($invalidHealthUri in @($null, '', 'relative/healthz', 'ftp://localhost/healthz', 'file:///C:/Windows')) {
        try { & $mockScript -InstallPath $global:Install -ServiceCredential $credential -HealthUri $invalidHealthUri; throw 'Expected health URI validation failure' }
        catch { if ($_.FullyQualifiedErrorId -notlike 'ParameterArgumentValidationError*') { throw } }
        Assert-True ($global:Calls.Count -eq 0) 'Invalid health URI reached host operations'
    }
    Write-Host 'PASS: Relative, empty, and non-HTTP health URIs fail at parameter binding'
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class DeploymentShortPathTest {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetShortPathName(string path, StringBuilder output, uint length);
}
'@
    $shortBuffer = New-Object Text.StringBuilder 32768
    $shortLength = [DeploymentShortPathTest]::GetShortPathName($mockSource, $shortBuffer, 32768)
    Assert-True ($shortLength -gt 0 -and $shortLength -lt 32768) 'Could not query the project short path'
    $shortSource = $shortBuffer.ToString()
    Assert-True ([AcmDeploymentPaths]::Canonicalize($shortSource) -eq [AcmDeploymentPaths]::Canonicalize($mockSource)) 'Short path canonicalization mismatch'
    foreach ($unsafePath in @($shortSource, (Join-Path $shortSource 'bin\Release'))) {
        try { & $mockScript -InstallPath $unsafePath -ServiceCredential $credential; throw 'Expected aliased project path rejection' }
        catch { if ($_.Exception.Message -notlike 'InstallPath must be a dedicated application directory*') { throw } }
    }
    if ($shortSource -eq $mockSource) {
        Write-Host 'INFO: This volume returned the long path; it did not generate an 8.3 alias for the fixture.'
    }
    $sourceJunction = Join-Path $temp 'linked source'
    New-Item -ItemType Junction -Path $sourceJunction -Target $mockSource | Out-Null
    try {
        $aliasedScript = Join-Path $sourceJunction 'deploy.ps1'
        try { & $aliasedScript -InstallPath $mockSource -ServiceCredential $credential; throw 'Expected aliased source overlap rejection' }
        catch { if ($_.Exception.Message -notlike 'InstallPath must be a dedicated application directory*') { throw } }
    }
    finally { [IO.Directory]::Delete($sourceJunction) }
    Assert-True ($global:Calls.Count -eq 0) 'Aliased path reached host operations'
    Write-Host 'PASS: Filesystem-backed aliases resolve consistently and overlapping aliases are rejected'
    $filePath = Join-Path $temp 'not a directory.txt'
    Set-Content $filePath 'preserve this file'
    try { & $mockScript -InstallPath $filePath -ServiceCredential $credential; throw 'Expected file path rejection' }
    catch { if ($_.Exception.Message -ne 'InstallPath must be a directory.') { throw } }

    $protected = Join-Path $temp 'protected target'
    New-Item -ItemType Directory -Path (Join-Path $protected 'child') -Force | Out-Null
    $sentinel = Join-Path $protected 'must survive.txt'
    Set-Content $sentinel 'protected data'
    $junction = Join-Path $temp 'linked install'
    New-Item -ItemType Junction -Path $junction -Target $protected | Out-Null
    try {
        foreach ($unsafePath in @($junction, (Join-Path $junction 'child'))) {
            try { & $mockScript -InstallPath $unsafePath -ServiceCredential $credential; throw 'Expected junction rejection' }
            catch { if ($_.Exception.Message -notlike 'InstallPath contains a reparse point:*') { throw } }
        }
    }
    finally { [IO.Directory]::Delete($junction) }
    New-Item -ItemType Directory -Path $global:Install | Out-Null
    foreach ($logName in @('service-boot.log', 'startup-error.log')) {
        $logPath = Join-Path $global:Install $logName
        New-Item -ItemType Directory -Path $logPath | Out-Null
        try { & $mockScript -InstallPath $global:Install -ServiceCredential $credential; throw 'Expected log directory rejection' }
        catch { if ($_.Exception.Message -notlike 'Diagnostic log path must be a regular file:*') { throw } }
        Remove-Item -LiteralPath $logPath
        New-Item -ItemType Junction -Path $logPath -Target $protected | Out-Null
        try {
            try { & $mockScript -InstallPath $global:Install -ServiceCredential $credential; throw 'Expected log junction rejection' }
            catch { if ($_.Exception.Message -notlike 'Installation contains a reparse point:*') { throw } }
        }
        finally { [IO.Directory]::Delete($logPath) }
    }
    $nested = Join-Path $global:Install 'nested'
    New-Item -ItemType Directory $nested | Out-Null
    $junction = Join-Path $nested 'linked content'
    New-Item -ItemType Junction -Path $junction -Target $protected | Out-Null
    try {
        try { & $mockScript -InstallPath $global:Install -ServiceCredential $credential; throw 'Expected nested junction rejection' }
        catch { if ($_.Exception.Message -notlike 'Installation contains a reparse point:*') { throw } }
    }
    finally { [IO.Directory]::Delete($junction) }
    Assert-True ($global:Calls.Count -eq 0) 'Invalid target reached host operations'
    Assert-True ((Get-Content $sentinel -Raw).Trim() -eq 'protected data') 'Junction target was modified'
    $global:NoSdk = $false
    Write-Host 'PASS: Unsafe paths, junctions, and invalid diagnostic log paths fail before deployment'

    $global:ExistingService = $true
    $global:InvalidLogDuringPublish = $true
    try { & $mockScript -InstallPath $global:Install -ServiceCredential $credential; throw 'Expected post-publish validation failure' }
    catch { if ($_.Exception.Message -notlike 'Diagnostic log path must be a regular file:*') { throw } }
    Assert-True (-not ($global:Calls -match '^stop\|')) 'Stopped service before post-publish target validation'
    Remove-Item -LiteralPath (Join-Path $global:Install 'service-boot.log')
    $global:InvalidLogDuringPublish = $false
    Write-Host 'PASS: Target is revalidated after publishing before stopping the service'
    foreach ($existing in @($false, $true)) {
        $global:Calls.Clear()
        $global:ExistingService = $existing
        if ($existing) {
            Set-Content (Join-Path $global:Install 'obsolete.json') 'obsolete config'
            $obsoleteDirectory = Join-Path $global:Install 'obsolete content'
            New-Item -ItemType Directory $obsoleteDirectory | Out-Null
            Set-Content (Join-Path $obsoleteDirectory 'old.txt') 'obsolete content'
        }
        & $mockScript -InstallPath $global:Install -ServiceCredential $credential
        Assert-True (-not (Test-Path (Join-Path $global:Install 'obsolete.json'))) 'Obsolete file survived deployment'
        Assert-True (-not (Test-Path (Join-Path $global:Install 'obsolete content'))) 'Obsolete directory survived deployment'
        $operation = if ($existing) { 'Change' } else { 'Create' }
        Assert-True ($global:Calls.Contains("cim|$operation")) 'Missing CIM registration'
        Assert-True (-not $global:LastCimArguments.ContainsKey('StartPassword')) 'Password retained after CIM call'
        Assert-True ($global:Calls.Contains('wait|Running')) 'Did not wait for startup'
        Assert-True (-not ($global:Calls -match 'mock-sc.exe\|(config|create)')) 'Registration used sc.exe'
        if ($existing) { Assert-True ($global:Calls.Contains('stop|AcmProvisioning')) 'Did not stop existing service' }
        $aclCalls = @($global:Calls | Where-Object { $_ -like 'mock-icacls.exe|*' })
        Assert-True ($aclCalls.Count -eq 3) 'Unexpected permission grants'
        Assert-True ($aclCalls[0] -ceq "mock-icacls.exe|$global:Install|/grant:r|ACMUIC\acmmemberportal:(OI)(CI)RX|/T") 'Install directory explicit permissions are not replaced with RX'
        foreach ($logName in @('service-boot.log', 'startup-error.log')) {
            $log = Join-Path $global:Install $logName
            Assert-True (Test-Path -LiteralPath $log -PathType Leaf) 'Diagnostic log was not pre-created'
            Assert-True ($aclCalls -contains "mock-icacls.exe|$log|/grant:r|ACMUIC\acmmemberportal:W") 'Missing replacement file-only log write permission'
            if ($existing) { Assert-True ((Get-Content $log -Raw).Trim() -eq 'existing diagnostic') 'Redeployment erased logs' }
            Set-Content $log 'existing diagnostic'
        }
        Write-Host "PASS: $operation registration, credential handling, and log permissions"
    }
    $formerSids = @{
        'ACMUIC\formeraccount' = 'S-1-5-21-100-100-100-1100'
        'NT AUTHORITY\LocalService' = 'S-1-5-19'
        'NT AUTHORITY\NetworkService' = 'S-1-5-20'
    }
    foreach ($previousAccount in @('ACMUIC\formeraccount', 'acmmemberportal@acmuic.org', 'LocalSystem', 'NT AUTHORITY\LocalService', 'NT AUTHORITY\NetworkService')) {
        $global:PreviousAccount = $previousAccount
        $global:Calls.Clear()
        & $mockScript -InstallPath $global:Install -ServiceCredential $credential
        $removals = @($global:Calls | Where-Object { $_ -like 'mock-icacls.exe|*|/remove:g|*' })
        if ($formerSids.ContainsKey($previousAccount)) {
            $formerSid = $formerSids[$previousAccount]
            Assert-True ($removals.Count -eq 1 -and $removals[0] -ceq "mock-icacls.exe|$global:Install|/remove:g|*$formerSid|/T") 'Former service account permissions were not removed recursively by SID'
        }
        else { Assert-True ($removals.Count -eq 0) 'Removed grants for an alias of the current account or a built-in identity' }
    }
    $global:PreviousAccount = 'ACMUIC\unknownaccount'
    $global:Calls.Clear()
    try { & $mockScript -InstallPath $global:Install -ServiceCredential $credential; throw 'Expected SID lookup failure' }
    catch { if ($_.Exception.Message -ne 'Account SID lookup failed') { throw } }
    Assert-True (-not ($global:Calls -match '^stop\|')) 'Stopped service before resolving its previous account SID'
    $global:PreviousAccount = 'ACMUIC\acmmemberportal'
    Write-Host 'PASS: Former account grants removed by SID; current-account aliases and SYSTEM preserved; lookup failures precede service stop'

    $global:CimReturnCode = 22
    $global:Calls.Clear()
    try { & $mockScript -InstallPath $global:Install -ServiceCredential $credential; throw 'Expected CIM failure' }
    catch { if ($_.Exception.Message -ne 'Win32_Service.Change failed with return code 22.') { throw } }
    Assert-True (-not ($global:Calls -match 'mock-sc.exe\|start')) 'Started service after failed registration'
    Assert-True (-not $global:LastCimArguments.ContainsKey('StartPassword')) 'Password retained after CIM failure'
    Write-Host 'PASS: Nonzero CIM result stops deployment and clears password'
    $global:CimReturnCode = 0
    $global:FailBuild = $true
    $global:Calls.Clear()
    try { & $mockScript -InstallPath $global:Install -ServiceCredential $credential; throw 'Expected publish failure' }
    catch { if ($_.Exception.Message -ne 'Mock publish failed') { throw } }
    Assert-True (-not ($global:Calls -match '^stop\|')) 'Stopped service on build failure'
    Write-Host 'PASS: Build failure leaves service running'
    $global:FailBuild = $false
    $global:NoSdk = $true
    $global:Calls.Clear()
    try { & $mockScript -InstallPath $global:Install -ServiceCredential $credential; throw 'Expected SDK failure' }
    catch { if ($_.Exception.Message -notlike '*Install a .NET 10 SDK*') { throw } }
    Assert-True ($global:Calls.Count -eq 0) 'Host modified without SDK'
    Write-Host 'PASS: Missing SDK fails before modifying host'
    $global:NoSdk = $false
    $global:FailHealth = $true
    $global:HealthTimeouts.Clear()
    try { & $mockScript -InstallPath $global:Install -ServiceCredential $credential -TimeoutSeconds 1; throw 'Expected health failure' }
    catch { if ($_.Exception.Message -notlike 'Health check failed*') { throw } }
    Assert-True ($global:HealthTimeouts.Count -gt 0 -and -not ($global:HealthTimeouts | Where-Object { $_ -gt 1000 })) 'Health requests exceeded the one-second remaining budget'
    foreach ($stage in $global:Stages) { Assert-True (-not (Test-Path $stage)) 'Staging files left behind' }
    Write-Host 'PASS: Failed health check fails deployment; staging directories are cleaned'
}
finally { Remove-Item $temp -Recurse -Force }
