#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
Rebuild and deploy the provisioning API on its Windows service host.
.DESCRIPTION
Requires a .NET 10 SDK and ASP.NET Core 10 runtime, a provisioned domain
service account, OU delegation, and Log on as a service. Prompts for the
service account password unless ServiceCredential is supplied.
.EXAMPLE
.\deploy.ps1
.EXAMPLE
.\deploy.ps1 -InstallPath 'D:\ACM Services\provisioning' -ServiceCredential (Get-Credential 'ACMUIC\acmmemberportal')
#>
[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$InstallPath = 'C:\srv\acm-provisioning',

    [System.Management.Automation.PSCredential]$ServiceCredential,

    [uri]$HealthUri = 'http://localhost:2433/healthz',

    [ValidateRange(1, 600)]
    [int]$TimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$serviceName = 'AcmProvisioning'
$projectPath = Join-Path $PSScriptRoot 'AcmProvisioning.csproj'
$stagePath = Join-Path ([IO.Path]::GetTempPath()) ('acm-provisioning-' + [guid]::NewGuid())

# ProcessStartInfo uses the Windows command-line quoting rules on both
# Windows PowerShell 5.1 and PowerShell 7, including paths with spaces.
function Invoke-NativeCommand {
    param([string]$FilePath, [string[]]$Arguments)

    $quotedArguments = foreach ($argument in $Arguments) {
        '"' + [regex]::Replace(
            [regex]::Replace($argument, '(\\*)"', '$1$1\"'),
            '(\\+)$', '$1$1'
        ) + '"'
    }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = $quotedArguments -join ' '
    $startInfo.UseShellExecute = $false
    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "$FilePath failed with exit code $($process.ExitCode)."
        }
    }
    finally {
        $process.Dispose()
        $startInfo.Arguments = ''
    }
}

function Assert-DeploymentTarget {
    param([string]$DirectoryPath)

    # Lexical path comparisons do not resolve junctions or symbolic links.
    # Reject them in existing ancestors and throughout the installation tree.
    $component = $DirectoryPath
    while ($component) {
        if (Test-Path -LiteralPath $component) {
            $item = Get-Item -LiteralPath $component -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "InstallPath contains a reparse point: $component"
            }
        }
        $parent = [IO.Directory]::GetParent($component)
        $component = if ($parent) { $parent.FullName } else { $null }
    }

    if (-not (Test-Path -LiteralPath $DirectoryPath -PathType Container)) {
        return
    }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($DirectoryPath)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Installation contains a reparse point: $($item.FullName)"
            }
            if ($directory -eq $DirectoryPath -and $item.Name -in @('service-boot.log', 'startup-error.log') -and $item.PSIsContainer) {
                throw "Diagnostic log path must be a regular file: $($item.FullName)"
            }
            if ($item.PSIsContainer) {
                $pending.Push($item.FullName)
            }
        }
    }
}

if ($env:OS -ne 'Windows_NT') {
    throw 'Run this script on the Windows service host.'
}
$InstallPath = [IO.Path]::GetFullPath($InstallPath)
$installPrefix = $InstallPath.TrimEnd('\') + '\'
if ($InstallPath.TrimEnd('\') -eq ([IO.Path]::GetPathRoot($InstallPath)).TrimEnd('\') -or
    ([IO.Path]::GetFullPath($projectPath)).StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    $stagePath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'InstallPath must be a dedicated application directory, not a drive root or a parent of the project or staging directory.'
}
if (Test-Path -LiteralPath $InstallPath -PathType Leaf) {
    throw 'InstallPath must be a directory.'
}
Assert-DeploymentTarget $InstallPath
$dotnet = (Get-Command dotnet.exe -ErrorAction Stop).Source
$sc = (Get-Command sc.exe -ErrorAction Stop).Source
$icacls = (Get-Command icacls.exe -ErrorAction Stop).Source

$sdks = & $dotnet --list-sdks
if ($LASTEXITCODE -ne 0 -or -not ($sdks -match '^10\.')) {
    throw 'Install a .NET 10 SDK before deploying.'
}
$runtimes = & $dotnet --list-runtimes
if ($LASTEXITCODE -ne 0 -or -not ($runtimes -match '^Microsoft\.AspNetCore\.App 10\.')) {
    throw 'Install the ASP.NET Core 10 runtime before deploying.'
}

if (-not $ServiceCredential) {
    $ServiceCredential = Get-Credential -UserName 'ACMUIC\acmmemberportal' -Message 'Windows service account password'
}
if (-not $ServiceCredential -or $ServiceCredential.Password.Length -eq 0) {
    throw 'A service account credential with a password is required.'
}
$serviceAccount = $ServiceCredential.UserName
if ($serviceAccount -notmatch '^[^\\]+\\[^\\]+$' -and $serviceAccount -notmatch '^[^@]+@[^@]+$') {
    throw 'Use a domain account in DOMAIN\user or user@domain form.'
}

try {
    Write-Host 'Rebuilding and publishing the application...'
    Invoke-NativeCommand $dotnet @('clean', $projectPath, '-c', 'Release')
    Invoke-NativeCommand $dotnet @('publish', $projectPath, '-c', 'Release', '-o', $stagePath, '--self-contained', 'false')
    if (-not (Test-Path (Join-Path $stagePath 'AcmProvisioning.exe'))) {
        throw 'Publish did not produce AcmProvisioning.exe.'
    }
    Assert-DeploymentTarget $InstallPath

    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($service) {
        Write-Host "Stopping $serviceName..."
        Stop-Service -Name $serviceName -ErrorAction Stop
        $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds($TimeoutSeconds))
    }

    Write-Host "Installing application files in $InstallPath..."
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
    # Remove obsolete publish output without erasing diagnostic history.
    Get-ChildItem -LiteralPath $InstallPath -Force |
        Where-Object { $_.Name -notin @('service-boot.log', 'startup-error.log') } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
    Copy-Item -Path (Join-Path $stagePath '*') -Destination $InstallPath -Recurse -Force
    Invoke-NativeCommand $icacls @($InstallPath, '/grant:r', "${serviceAccount}:(OI)(CI)RX", '/T')
    foreach ($logName in @('service-boot.log', 'startup-error.log')) {
        $logPath = Join-Path $InstallPath $logName
        if (-not (Test-Path -LiteralPath $logPath)) {
            New-Item -ItemType File -Path $logPath | Out-Null
        }
        Invoke-NativeCommand $icacls @($logPath, '/grant:r', "${serviceAccount}:W")
    }

    # Configuring an existing service preserves service-specific environment
    # variables and other registration settings. SCM needs the explicit flag.
    $operation = if ($service) { 'Change' } else { 'Create' }
    $binaryPath = '"' + (Join-Path $InstallPath 'AcmProvisioning.exe') + '" --windows-service'
    Write-Host "$operation $serviceName as $serviceAccount..."
    $serviceArguments = @{
        PathName = $binaryPath
        StartMode = 'Automatic'
        StartName = $serviceAccount
    }
    if ($service) {
        $serviceInstance = Get-CimInstance -ClassName Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop
        if (-not $serviceInstance) {
            throw "$serviceName disappeared before its configuration could be updated."
        }
    }
    else {
        $serviceArguments.Name = $serviceName
        $serviceArguments.DisplayName = $serviceName
        $serviceArguments.ServiceType = [byte]16 # Own process
        $serviceArguments.ErrorControl = [byte]1 # Normal
    }

    # Pass the password directly to the local service API, never to a child
    # process command line where process-creation auditing could record it.
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ServiceCredential.Password)
    try {
        $serviceArguments.StartPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
        if ($service) {
            $result = Invoke-CimMethod -InputObject $serviceInstance -MethodName Change -Arguments $serviceArguments -ErrorAction Stop
        }
        else {
            $result = Invoke-CimMethod -ClassName Win32_Service -MethodName Create -Arguments $serviceArguments -ErrorAction Stop
        }
        if ($result.ReturnValue -ne 0) {
            throw "Win32_Service.$operation failed with return code $($result.ReturnValue)."
        }
    }
    finally {
        $serviceArguments.Remove('StartPassword')
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }

    Write-Host "Starting $serviceName..."
    Invoke-NativeCommand $sc @('start', $serviceName)
    $service = Get-Service -Name $serviceName
    $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds($TimeoutSeconds))
    Invoke-NativeCommand $sc @('qc', $serviceName)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $health = Invoke-RestMethod -Uri $HealthUri -Method Get -TimeoutSec 5
            if ($health.status -eq 'ok') {
                Write-Host "Deployment complete. $serviceName is running and $HealthUri reports ok."
                return
            }
        }
        catch {
            Write-Verbose $_.Exception.Message
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Health check failed at $HealthUri after $TimeoutSeconds seconds."
}
catch {
    Write-Warning "Deployment failed. Check $InstallPath\service-boot.log, startup-error.log, and the Application log in Event Viewer. The service may be stopped or partially updated."
    throw
}
finally {
    if (Test-Path $stagePath) {
        Remove-Item -LiteralPath $stagePath -Recurse -Force
    }
}
