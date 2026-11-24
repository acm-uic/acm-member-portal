using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace AcmProvisioning;

public interface IEntraSyncRunner
{
    Task RunAsync(EntraSyncJob job, CancellationToken cancellationToken);
}

internal sealed class EntraSyncFailure(string code) : Exception("Entra sync request failed.")
{
    public string Code { get; } = code;

    internal static string FromExitCode(int exitCode) => exitCode switch
    {
        10 => "settings-unavailable",
        11 => "module-unavailable",
        12 => "scheduler-unavailable",
        13 => "scheduler-suspended",
        14 => "directory-disabled",
        15 => "directory-busy",
        16 => "outside-managed-ou",
        17 => "adsync-command-failed",
        18 => "connect-read-failed",
        _ => "request-failed"
    };

    internal static string? SafeCode(string? code) => code switch
    {
        "settings-unavailable" or "module-unavailable" or "scheduler-unavailable"
            or "scheduler-suspended" or "directory-disabled" or "directory-busy" or "outside-managed-ou"
            or "adsync-command-failed" or "connect-read-failed" or "request-failed" or "timeout" => code,
        _ => null
    };
}

public sealed record EntraConnectorInspection(string State, string? TargetDn = null,
    string? ErrorCode = null, string? ConflictAttribute = null, string? ConflictValue = null, Guid? ConflictObjectId = null,
    string? PasswordStatus = null, DateTimeOffset? PasswordCheckedAt = null, string? TechnicalMessage = null);

public sealed class PowerShellEntraSyncRunner(EntraSyncOptions options) : IEntraSyncRunner
{
    internal static string RequestPayload(EntraSyncJob job) => JsonSerializer.Serialize(new
    {
        // Preserve the existing PowerShell protocol independently of the C# operation labels.
        Kind = job.Kind switch
        {
            EntraSyncKind.Directory => "Directory",
            EntraSyncKind.UserHash => "Password",
            _ => throw new ArgumentException("Invalid sync operation.")
        },
        job.DistinguishedName
    });

    internal static ProcessStartInfo StartInfo(string systemRoot, string scriptPath) => new()
    {
        FileName = Path.Combine(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardInput = true,
        StandardInputEncoding = new UTF8Encoding(false),
        RedirectStandardOutput = true,
        StandardOutputEncoding = new UTF8Encoding(false),
        RedirectStandardError = true,
        ArgumentList = { "-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath }
    };

    public async Task RunAsync(EntraSyncJob job, CancellationToken cancellationToken)
    {
        await InvokeAsync(RequestPayload(job), options.TimeoutSeconds, inspect: false, cancellationToken);
    }

    internal async Task<EntraConnectorInspection> InspectAsync(string distinguishedName, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.Serialize(new { Kind = "Inspect", DistinguishedName = distinguishedName });
        var output = await InvokeAsync(payload, 7, inspect: true, cancellationToken);
        return JsonSerializer.Deserialize<EntraConnectorInspection>(output)
            ?? throw new InvalidDataException("Missing Entra sync diagnostics.");
    }

    private static async Task<string> InvokeAsync(string payload, int timeoutSeconds, bool inspect,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var systemRoot = Environment.GetEnvironmentVariable("SystemRoot")
            ?? throw new InvalidOperationException("SystemRoot is unavailable.");
        using var process = new Process
        {
            StartInfo = StartInfo(systemRoot, Path.Combine(AppContext.BaseDirectory, "EntraSync", "Invoke-EntraSync.ps1"))
        };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
        process.Start();
        // Inspection returns a bounded projection of the connector record. Process errors stay private.
        var stdout = ReadOutputAsync(process, inspect, timeout.Token);
        var stderr = process.StandardError.BaseStream.CopyToAsync(Stream.Null);
        try
        {
            // Data travels on stdin, never interpolated into commands or command-line arguments.
            await process.StandardInput.WriteLineAsync(payload.AsMemory(), timeout.Token);
            process.StandardInput.Close();
            await process.WaitForExitAsync(timeout.Token);
            await Task.WhenAll(stdout, stderr).WaitAsync(timeout.Token);
            if (process.ExitCode != 0) throw new EntraSyncFailure(EntraSyncFailure.FromExitCode(process.ExitCode));
            return await stdout;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new EntraSyncFailure("timeout");
        }
        finally
        {
            if (!process.HasExited)
            {
                try { process.Kill(entireProcessTree: true); } catch { /* best effort */ }
                try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
                catch { /* Do not block service shutdown indefinitely. */ }
            }
            try { await Task.WhenAll(stdout, stderr).WaitAsync(TimeSpan.FromSeconds(5)); }
            catch { /* Pipes may close during timeout/shutdown. */ }
        }
    }

    private static async Task<string> ReadOutputAsync(Process process, bool inspect, CancellationToken cancellationToken)
    {
        if (!inspect)
        {
            await process.StandardOutput.BaseStream.CopyToAsync(Stream.Null, cancellationToken);
            return "";
        }

        var buffer = new char[32769];
        var count = await process.StandardOutput.ReadBlockAsync(buffer.AsMemory(), cancellationToken);
        if (count == buffer.Length)
            throw new InvalidDataException("Entra sync diagnostics exceeded the response limit.");
        return new string(buffer, 0, count);
    }
}

public sealed class EntraSyncWorker(EntraSyncOptions options, EntraSyncQueue queue,
    IEntraSyncRunner runner, ILogger<EntraSyncWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Enabled) return;
        logger.LogInformation("Entra synchronization worker enabled. Sync requests do not confirm cloud sign-in readiness.");
        while (!stoppingToken.IsCancellationRequested)
        {
            var job = queue.Due(DateTimeOffset.UtcNow);
            if (job is null)
            {
                await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
                continue;
            }
            await ProcessAsync(job, stoppingToken);
        }
    }

    internal async Task ProcessAsync(EntraSyncJob job, CancellationToken stoppingToken)
    {
        var succeeded = false;
        string? failureCode = null;
        try
        {
            await runner.RunAsync(job, stoppingToken);
            succeeded = true;
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
        catch (Exception ex)
        {
            failureCode = ex is EntraSyncFailure failure ? failure.Code : "request-failed";
            logger.LogWarning("Entra {SyncKind} sync request {JobId} failed ({FailureCode}); stored attempt count will be {Attempt}.",
                job.Kind, job.Id, failureCode, Math.Min(job.Attempts + 1, 1000));
        }
        try
        {
            queue.Finish(job, succeeded, DateTimeOffset.UtcNow, failureCode);
            if (succeeded) logger.LogInformation("Entra {SyncKind} sync request accepted; cloud sign-in readiness is unverified.", job.Kind);
        }
        catch
        {
            logger.LogError("Could not persist Entra sync queue progress; the sync request remains pending.");
            await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);
        }
    }
}
