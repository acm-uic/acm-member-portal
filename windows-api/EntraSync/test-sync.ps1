# Run with Windows PowerShell 5.1. No ADSync module, AD connection, privileges, or Pester required.
$ErrorActionPreference = 'Stop'
$tests = 0
function Assert-True($condition, [string]$message) {
    if (-not $condition) { throw $message }
    $script:tests++
}
function Assert-Rejected([scriptblock]$action, [string]$message) {
    $rejected = $false
    try { & $action } catch { $rejected = $true }
    Assert-True $rejected $message
}
foreach ($path in @('AcmEntraSync.psm1', 'Invoke-EntraSync.ps1')) {
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $path), [ref]$null, [ref]$parseErrors)
    Assert-True ($parseErrors.Count -eq 0) "Syntax errors in $path"
}
$module = Import-Module (Join-Path $PSScriptRoot 'AcmEntraSync.psm1') -Force -PassThru
try {
    # Mocks are private to this module instance, never installed on the machine.
    & $module {
        $script:state = @{
            DirectoryCalls = 0; PasswordCalls = 0; Result = 'Success'; Fail = $false
            Scheduler = [pscustomobject]@{
                StagingModeEnabled = $false; SchedulerSuspended = $false
                SyncCycleEnabled = $true; SyncCycleInProgress = $false
            }
        }
        function script:Get-Content { param($LiteralPath, [switch]$Raw, $Encoding, $ErrorAction)
            '{"ConnectorName":"acmuic.org","UsersOu":"OU=ACMUsers,DC=acmuic,DC=org"}'
        }
        function script:Import-Module { param($Name, $ErrorAction) }
        function script:Get-ADSyncScheduler { param($ErrorAction) $script:state.Scheduler }
        function script:Start-ADSyncSyncCycle { param($PolicyType, $InteractiveMode, $ErrorAction)
            if ($script:state.Fail) { throw 'simulated ADSync failure' }
            $script:state.DirectoryCalls++
            $script:state.PolicyType = $PolicyType
            $script:state.InteractiveMode = $InteractiveMode
            [pscustomobject]@{ Result = $script:state.Result }
        }
        function script:Invoke-ADSyncCSObjectPasswordHashSync { param($ConnectorName, $DistinguishedName, $ErrorAction)
            if ($script:state.Fail) { throw 'simulated ADSync failure' }
            $script:state.PasswordCalls++
            $script:state.Connector = $ConnectorName
            $script:state.Dn = $DistinguishedName
        }
    }
    $state = & $module { $script:state }
    Request-AcmEntraSync -Kind Directory
    Assert-True ($state.DirectoryCalls -eq 1 -and $state.PasswordCalls -eq 0) 'Directory sync must run once without password sync.'
    Assert-True ($state.PolicyType -eq 'Delta' -and $state.InteractiveMode -eq $false) 'Use non-interactive delta sync.'

    $dn = 'CN=literal $(& whoami) ''quoted'' user,OU=10,OU=2026,OU=ACMUsers,DC=acmuic,DC=org'
    Request-AcmEntraSync -Kind Password -DistinguishedName $dn
    Assert-True ($state.PasswordCalls -eq 1 -and $state.Dn -ceq $dn -and $state.Connector -eq 'acmuic.org') 'DN must be passed literally to the configured connector.'
    foreach ($invalidDn in @('', 'CN=outside,DC=example,DC=org', ('CN=bad' + [char]0 + ',OU=ACMUsers,DC=acmuic,DC=org'), ('x' * 4097))) {
        Assert-Rejected { Request-AcmEntraSync -Kind Password -DistinguishedName $invalidDn } 'Invalid DN must be rejected.'
    }
    Assert-True ($state.PasswordCalls -eq 1) 'Rejected input must not call ADSync.'

    $state.Scheduler.SyncCycleInProgress = $true
    Assert-Rejected { Request-AcmEntraSync -Kind Directory } 'Running directory cycle must defer the request.'
    # Password synchronization is independent of the object scheduler.
    $state.Scheduler.SyncCycleEnabled = $false
    Request-AcmEntraSync -Kind Password -DistinguishedName $dn
    Assert-True ($state.PasswordCalls -eq 2) 'A disabled/busy object scheduler must not suppress password sync.'
    Assert-Rejected { Request-AcmEntraSync -Kind Directory } 'Disabled directory scheduler must not be overridden.'
    $state.Scheduler.SyncCycleInProgress = $false
    $state.Scheduler.SyncCycleEnabled = $true
    foreach ($flag in @('StagingModeEnabled', 'SchedulerSuspended')) {
        $state.Scheduler.$flag = $true
        Assert-Rejected { Request-AcmEntraSync -Kind Directory } 'Staging/suspended server must reject sync.'
        Assert-Rejected { Request-AcmEntraSync -Kind Password -DistinguishedName $dn } 'Staging/suspended server must reject password sync.'
        $state.Scheduler.$flag = $false
    }
    $state.Result = 'NotAccepted'
    Assert-Rejected { Request-AcmEntraSync -Kind Directory } 'Non-success scheduler result must be retried.'
    $state.Fail = $true
    Assert-Rejected { Request-AcmEntraSync -Kind Password -DistinguishedName $dn } 'ADSync errors must propagate for retry.'
    Assert-Rejected { Request-AcmEntraSync -Kind Directory } 'ADSync directory errors must propagate for retry.'
    Write-Output "Passed $tests Entra sync PowerShell checks (all ADSync calls mocked)."
} finally {
    Remove-Module $module -Force
}

# Exercise the actual stdin/exit-code wrapper with an inert module in an isolated directory.
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('acm-sync-transport-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($fixture)
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Invoke-EntraSync.ps1') -Destination $fixture
    $stub = @'
function Request-AcmEntraSync {
    param($Kind, $DistinguishedName)
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'received.json'), (@{Kind=$Kind; Dn=$DistinguishedName} | ConvertTo-Json))
}
Export-ModuleMember -Function Request-AcmEntraSync
'@
    [IO.File]::WriteAllText((Join-Path $fixture 'AcmEntraSync.psm1'), $stub)
    function Invoke-TransportFixture([string]$payload) {
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo.FileName = Join-Path $PSHOME 'powershell.exe'
        $process.StartInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + (Join-Path $fixture 'Invoke-EntraSync.ps1') + '"'
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardInput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.RedirectStandardOutput = $true
        try {
            [void]$process.Start()
            $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
            $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
            $process.StandardInput.BaseStream.Flush()
            $process.StandardInput.Close()
            $errorText = $process.StandardError.ReadToEnd()
            $outputText = $process.StandardOutput.ReadToEnd()
            if (-not $process.WaitForExit(10000)) { $process.Kill(); throw 'Transport fixture timed out.' }
            @{ ExitCode = $process.ExitCode; ErrorText = $errorText; OutputText = $outputText }
        } finally { $process.Dispose() }
    }
    $unicodeDn = 'CN=Zo' + [char]0x00EB + ' $(& whoami) ''quoted'',OU=ACMUsers,DC=acmuic,DC=org'
    $result = Invoke-TransportFixture (@{Kind='Password'; DistinguishedName=$unicodeDn} | ConvertTo-Json)
    Assert-True ($result.ExitCode -eq 0) 'Valid stdin JSON must execute the local module.'
    $received = Get-Content -LiteralPath (Join-Path $fixture 'received.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($received.Dn -ceq $unicodeDn -and $received.Kind -eq 'Password') 'Unicode and shell-like text must survive as literal data.'
    foreach ($payload in @('not json', '{"Kind":"AnythingElse"}')) {
        $result = Invoke-TransportFixture $payload
        Assert-True ($result.ExitCode -ne 0 -and $result.ErrorText.Trim() -eq 'Entra synchronization request failed.') 'Invalid input must fail with a fixed error.'
    }
    Write-Output "Passed $tests total Entra sync PowerShell checks including subprocess transport."
} finally {
    # Known files only; no recursive cleanup of a computed Windows path.
    foreach ($name in @('received.json', 'AcmEntraSync.psm1', 'Invoke-EntraSync.ps1')) {
        [IO.File]::Delete((Join-Path $fixture $name))
    }
    [IO.Directory]::Delete($fixture)
}
