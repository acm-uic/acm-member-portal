function Request-AcmEntraSync {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('Directory', 'Password')][string]$Kind,
        [AllowNull()][AllowEmptyString()][string]$DistinguishedName
    )
    $ErrorActionPreference = 'Stop'
    # Admin-owned configuration on the Connect host; API callers cannot select a connector or OU.
    $settingsPath = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'ACM\EntraSync\settings.json'
    $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($settings.ConnectorName) -or [string]::IsNullOrWhiteSpace($settings.UsersOu)) {
        throw 'Entra synchronization settings are incomplete.'
    }
    Import-Module ADSync -ErrorAction Stop
    $scheduler = Get-ADSyncScheduler -ErrorAction Stop
    if ($scheduler.StagingModeEnabled -or $scheduler.SchedulerSuspended) {
        throw 'Entra synchronization is disabled or suspended.'
    }
    if ($Kind -eq 'Directory') {
        if (-not $scheduler.SyncCycleEnabled) { throw 'Directory synchronization is disabled.' }
        if ($scheduler.SyncCycleInProgress) { throw 'A directory sync cycle is already running.' }
        $result = Start-ADSyncSyncCycle -PolicyType Delta -InteractiveMode:$false -ErrorAction Stop
        if ($result.Result -ne 'Success') { throw 'Directory synchronization request was not accepted.' }
    } else {
        if ([string]::IsNullOrWhiteSpace($DistinguishedName) -or $DistinguishedName.Length -gt 4096 `
            -or $DistinguishedName.IndexOf([char]0) -ge 0 `
            -or -not $DistinguishedName.EndsWith(',' + $settings.UsersOu, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The account is outside the managed OU.'
        }
        Invoke-ADSyncCSObjectPasswordHashSync -ConnectorName $settings.ConnectorName `
            -DistinguishedName $DistinguishedName -ErrorAction Stop | Out-Null
    }
}
Export-ModuleMember -Function Request-AcmEntraSync
