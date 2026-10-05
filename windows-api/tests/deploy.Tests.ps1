#Requires -Version 5.1
# Run in a fresh PowerShell process. Host operations are mocked; no elevation,
# .NET SDK, AD credentials, or service changes are needed.
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'deploy.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
Add-Type -AssemblyName System.ServiceProcess

$native = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-NativeCommand'
}, $true)
$source = Get-Content $sourcePath -Raw
$source = $source.Remove($native.Extent.StartOffset, $native.Extent.EndOffset - $native.Extent.StartOffset)
$source = $source -replace '(?m)^#Requires.*\r?\n', ''
$temp = Join-Path $env:TEMP ('deploy-test-' + [guid]::NewGuid())
New-Item -ItemType Directory $temp | Out-Null
$mockScript = Join-Path $temp 'deploy.ps1'
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
    [pscustomobject]@{ Name = 'AcmProvisioning' }
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
function global:Invoke-RestMethod {
    param($Uri, $Method, $TimeoutSec)
    if ($global:FailHealth) { throw 'Mock unhealthy' }
    @{ status = 'ok' }
}

try {
    $global:TestPassword = 'test password with "quotes" & symbols'
    $credential = New-Object System.Management.Automation.PSCredential('ACMUIC\acmmemberportal', (ConvertTo-SecureString $global:TestPassword -AsPlainText -Force))
    $global:Calls = New-Object 'System.Collections.Generic.List[string]'
    $global:Stages = New-Object 'System.Collections.Generic.List[string]'
    $global:Install = Join-Path $temp 'install with spaces'
    $global:NoSdk = $false
    $global:FailBuild = $false
    $global:FailHealth = $false
    $global:CimReturnCode = 0
    foreach ($existing in @($false, $true)) {
        $global:Calls.Clear()
        $global:ExistingService = $existing
        & $mockScript -InstallPath $global:Install -ServiceCredential $credential
        $operation = if ($existing) { 'Change' } else { 'Create' }
        Assert-True ($global:Calls.Contains("cim|$operation")) 'Missing CIM registration'
        Assert-True (-not $global:LastCimArguments.ContainsKey('StartPassword')) 'Password retained after CIM call'
        Assert-True ($global:Calls.Contains('wait|Running')) 'Did not wait for startup'
        Assert-True (-not ($global:Calls -match 'mock-sc.exe\|(config|create)')) 'Registration used sc.exe'
        if ($existing) { Assert-True ($global:Calls.Contains('stop|AcmProvisioning')) 'Did not stop existing service' }
        $aclCalls = @($global:Calls | Where-Object { $_ -like 'mock-icacls.exe|*' })
        Assert-True ($aclCalls.Count -eq 3) 'Unexpected permission grants'
        Assert-True ($aclCalls[0] -ceq "mock-icacls.exe|$global:Install|/grant|ACMUIC\acmmemberportal:(OI)(CI)RX|/T") 'Install directory permissions exceed RX'
        foreach ($logName in @('service-boot.log', 'startup-error.log')) {
            $log = Join-Path $global:Install $logName
            Assert-True (Test-Path -LiteralPath $log -PathType Leaf) 'Diagnostic log was not pre-created'
            Assert-True ($aclCalls -contains "mock-icacls.exe|$log|/grant|ACMUIC\acmmemberportal:W") 'Missing file-only log write permission'
            if ($existing) { Assert-True ((Get-Content $log -Raw).Trim() -eq 'existing diagnostic') 'Redeployment erased logs' }
            Set-Content $log 'existing diagnostic'
        }
        Write-Host "PASS: $operation registration, credential handling, and log permissions"
    }
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
    try { & $mockScript -InstallPath $global:Install -ServiceCredential $credential -TimeoutSeconds 1; throw 'Expected health failure' }
    catch { if ($_.Exception.Message -notlike 'Health check failed*') { throw } }
    foreach ($stage in $global:Stages) { Assert-True (-not (Test-Path $stage)) 'Staging files left behind' }
    Write-Host 'PASS: Failed health check fails deployment; staging directories are cleaned'
}
finally { Remove-Item $temp -Recurse -Force }
