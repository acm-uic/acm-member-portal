function Stop-AcmEntraSync([int]$Code) {
    $failure = [InvalidOperationException]::new('Entra synchronization command failed.')
    $failure.Data['AcmSyncExitCode'] = $Code
    throw $failure
}

function Get-AcmEntraSyncSettings {
    # Admin-owned configuration. API callers cannot select a connector or OU.
    $path = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'ACM\EntraSync\settings.json'
    try {
        $settings = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
    } catch { Stop-AcmEntraSync 10 }
    if ([string]::IsNullOrWhiteSpace($settings.ConnectorName) -or [string]::IsNullOrWhiteSpace($settings.UsersOu)) {
        Stop-AcmEntraSync 10
    }
    return $settings
}

function Assert-AcmSyncUser([string]$DistinguishedName, [string]$UsersOu) {
    if ([string]::IsNullOrWhiteSpace($DistinguishedName) -or $DistinguishedName.Length -gt 4096 `
        -or $DistinguishedName.IndexOf([char]0) -ge 0 `
        -or -not $DistinguishedName.EndsWith(',' + $UsersOu, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-AcmEntraSync 16
    }
}

function Request-AcmEntraSync {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('Directory', 'Password')][string]$Kind,
        [AllowNull()][AllowEmptyString()][string]$DistinguishedName
    )
    $ErrorActionPreference = 'Stop'
    $settings = Get-AcmEntraSyncSettings
    try { Import-Module ADSync -ErrorAction Stop } catch { Stop-AcmEntraSync 11 }
    try { $scheduler = Get-ADSyncScheduler -ErrorAction Stop } catch { Stop-AcmEntraSync 12 }
    if ($scheduler.StagingModeEnabled -or $scheduler.SchedulerSuspended) {
        Stop-AcmEntraSync 13
    }
    if ($Kind -eq 'Directory') {
        if (-not $scheduler.SyncCycleEnabled) { Stop-AcmEntraSync 14 }
        if ($scheduler.SyncCycleInProgress) { Stop-AcmEntraSync 15 }
        try { $result = Start-ADSyncSyncCycle -PolicyType Delta -InteractiveMode:$false -ErrorAction Stop }
        catch { Stop-AcmEntraSync 17 }
        if ($result.Result -ne 'Success') { Stop-AcmEntraSync 17 }
    } else {
        Assert-AcmSyncUser $DistinguishedName $settings.UsersOu
        try {
            Invoke-ADSyncCSObjectPasswordHashSync -ConnectorName $settings.ConnectorName `
                -DistinguishedName $DistinguishedName -ErrorAction Stop | Out-Null
        } catch { Stop-AcmEntraSync 17 }
    }
}

function Get-AcmExportMessage([string]$Literal) {
    # Keep the vendor message. Additional diagnostic JSON is handled as structured fields.
    $detailsStart = $Literal.IndexOf('ExtraErrorDetails:', [StringComparison]::OrdinalIgnoreCase)
    if ($detailsStart -ge 0) { $Literal = $Literal.Substring(0, $detailsStart) }
    $message = $Literal -replace '</?pii>', '' -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', ''
    $message = $message -replace '\bBearer\s+[^\s"''\\,}]+', 'Bearer [redacted]'
    $message = $message -replace '(\b(?:unicodePwd|userPassword|currentPassword|newPassword|oneTimePassword|passwordHash|password|clientSecret|token)\b["'']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|''[^'']*''|[^\s,;}]+)', '$1[redacted]'
    $message = $message.Trim()
    if ($message.Length -gt 2000) { return $message.Substring(0, 1999) + [char]0x2026 }
    if ($message) { return $message }
}

function Add-AcmExportError($Result, $ExportError) {
    # ADSync returns an ExportError object. Its string conversion does not include the vendor details.
    $literal = if ($ExportError -is [string]) { $ExportError } else { [string]$ExportError.ErrorLiteral }
    $Result.TechnicalMessage = Get-AcmExportMessage $literal
    $Result.ErrorCode = @($ExportError.ErrorName, $ExportError.ErrorCode, $ExportError.ErrorType) |
        Where-Object { $_ -match '^[a-z0-9][a-z0-9._-]{0,79}$' } | Select-Object -First 1
    if (-not $Result.ErrorCode -and $literal -match '\b(QuarantinedAttributeValueMustBeUnique|AttributeValueMustBeUnique|InvalidSoftMatch|ObjectTypeMismatch|InvalidHardMatch|InvalidAttributeValue|LargeObject|permission-issue)\b') {
        $Result.ErrorCode = $Matches[1]
    }

    $conflict = @{}
    $extra = [string]$ExportError.ErrorExtraDetails
    if ($extra -and $extra.Length -le 65536) {
        try {
            foreach ($entry in ($extra | ConvertFrom-Json -ErrorAction Stop)) {
                if ($entry.Key -in @('AttributeConflictName', 'AttributeConflictValues', 'ObjectIdInConflict')) {
                    $conflict[$entry.Key] = [string](@($entry.Value)[0])
                }
            }
        } catch { } # The vendor can return non-JSON details. Keep the technical message.
    }

    $attribute = '(ProxyAddresses|UserPrincipalName|OnPremises?SecurityIdentifier|mail)'
    if ($conflict.AttributeConflictName -match ('^' + $attribute + '$')) {
        $Result.ConflictAttribute = $Matches[1]
    } elseif ($literal -match ('(?:AttributeConflictName[^\r\n]{0,100}|\[)\b' + $attribute + '\b')) {
        $Result.ConflictAttribute = $Matches[1]
    }
    if ($Result.ConflictAttribute -and -not $Result.ErrorCode) { $Result.ErrorCode = 'duplicate-attribute' }

    $objectId = '([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})'
    if ($conflict.ObjectIdInConflict -match ('^' + $objectId + '$') `
        -or $literal -match ('ObjectIdInConflict[^\r\n]{0,80}?' + $objectId + '\b')) {
        $Result.ConflictObjectId = $Matches[1]
    }
    if ($Result.ConflictAttribute -in @('ProxyAddresses', 'UserPrincipalName', 'mail')) {
        $address = '([a-z0-9.!#$%&*+/=?^_{|}~\-]+@[a-z0-9.\-]+\.[a-z0-9\-]+)'
        if ($conflict.AttributeConflictValues -match ('^(?:SMTP:)?' + $address + '$') `
            -or $literal -match ('AttributeConflictValues[^\r\n]{0,100}?(?:SMTP:|["\x27])' + $address) `
            -or ($Result.ConflictAttribute -eq 'ProxyAddresses' -and $literal -match ('ProxyAddresses[^\r\n]{0,80}?SMTP:' + $address))) {
            if ($Matches[1].Length -le 254) { $Result.ConflictValue = $Matches[1] }
        }
    }
}

function Get-AcmEntraSyncInspection([string]$DistinguishedName) {
    $ErrorActionPreference = 'Stop'
    $settings = Get-AcmEntraSyncSettings
    Assert-AcmSyncUser $DistinguishedName $settings.UsersOu
    try { Import-Module ADSync -ErrorAction Stop } catch { Stop-AcmEntraSync 11 }

    $result = @{
        State = 'ad-not-imported'; TargetDn = $null; ErrorCode = $null; TechnicalMessage = $null
        ConflictAttribute = $null; ConflictValue = $null; ConflictObjectId = $null
        PasswordStatus = $null; PasswordCheckedAt = $null
    }
    $source = Get-ADSyncCSObject -ConnectorName $settings.ConnectorName -DistinguishedName $DistinguishedName -ErrorAction Stop
    if (-not $source) { return $result }

    try {
        $event = Get-ADSyncCSObjectLog -Identifier $source.ObjectId -Count 20 -ErrorAction Stop |
            Where-Object { $_.Type -eq 'PasswordSync' } | Sort-Object TimeStamp -Descending | Select-Object -First 1
        if ($event) {
            $status = [string]$event.Status
            $result.PasswordStatus = if ($status -in @('Success', 'FilteredByTarget', 'NoTargetConnection',
                'SourceConnectorNotPresent', 'TargetNotExportedToDirectory', 'Error', 'Unknown',
                'MissingAttribute', 'RetryRequestedByTarget', 'MigratedCheckDetailsForMoreInfo')) { $status } else { 'Unknown' }
            if ($event.TimeStamp) { $result.PasswordCheckedAt = ([DateTimeOffset]$event.TimeStamp).ToString('o') }
        }
    } catch { $result.PasswordStatus = 'unavailable' }

    if ($source.HasSyncError) {
        $result.State = 'source-sync-error'
        return $result
    }
    if (-not $source.ConnectedMVObjectId -or $source.ConnectedMVObjectId -eq [Guid]::Empty) {
        $result.State = 'metaverse-link-missing'
        return $result
    }

    $cloudConnectors = @(Get-ADSyncConnector -ErrorAction Stop |
        Where-Object { $_.SubType -eq 'Windows Azure Active Directory (Microsoft)' })
    if ($cloudConnectors.Count -ne 1) {
        $result.State = 'target-unavailable'
        return $result
    }
    $metaverse = Get-ADSyncMVObject -Identifier $source.ConnectedMVObjectId -ErrorAction Stop
    $cloudName = $cloudConnectors[0].Name
    $targetDns = @($metaverse.Lineage | Where-Object { $_.ConnectorName -eq $cloudName } |
        Select-Object -ExpandProperty ConnectedCsObjectDN -Unique | Where-Object { $_ })
    if ($targetDns.Count -ne 1) {
        $result.State = if ($targetDns.Count -eq 0) { 'target-link-missing' } else { 'target-unavailable' }
        return $result
    }

    $target = Get-ADSyncCSObject -ConnectorName $cloudName -DistinguishedName $targetDns[0] -SkipDNValidation -ErrorAction Stop
    $result.TargetDn = $targetDns[0]
    $result.State = if (-not $target) { 'target-unavailable' }
        elseif ($target.HasExportError) { 'export-error' }
        elseif ($target.HasSyncError) { 'target-sync-error' }
        else { 'target-linked' }
    if ($result.State -eq 'export-error') { Add-AcmExportError $result $target.ExportError }
    return $result
}
Export-ModuleMember -Function Request-AcmEntraSync, Get-AcmEntraSyncInspection
