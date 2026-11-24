$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.Kind -notin @('Directory', 'Password', 'Inspect')) { throw 'Invalid sync kind.' }
    Import-Module (Join-Path $PSScriptRoot 'AcmEntraSync.psm1') -Force -ErrorAction Stop
    if ($request.Kind -eq 'Inspect') {
        $result = Get-AcmEntraSyncInspection -DistinguishedName $request.DistinguishedName
        [Console]::WriteLine(($result | ConvertTo-Json -Compress))
    } else {
        Request-AcmEntraSync -Kind $request.Kind -DistinguishedName $request.DistinguishedName
    }
    exit 0
} catch {
    # No raw errors or command output cross back into the API.
    [Console]::Error.WriteLine('Entra synchronization request failed.')
    $code = $_.Exception.Data['AcmSyncExitCode']
    if ($code -in (10..17)) { exit $code }
    if ($request.Kind -eq 'Inspect') { exit 18 }
    exit 1
}
