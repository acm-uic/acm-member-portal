$ErrorActionPreference = 'Stop'
try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.Kind -notin @('Directory', 'Password')) { throw 'Invalid sync kind.' }
    Import-Module (Join-Path $PSScriptRoot 'AcmEntraSync.psm1') -Force -ErrorAction Stop
    Request-AcmEntraSync -Kind $request.Kind -DistinguishedName $request.DistinguishedName
    exit 0
} catch {
    # No raw errors or command output cross back into the API.
    [Console]::Error.WriteLine('Entra synchronization request failed.')
    exit 1
}
