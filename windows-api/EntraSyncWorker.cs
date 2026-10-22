using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace AcmProvisioning;

public interface IEntraSyncRunner
{
    Task RunAsync(EntraSyncJob job, CancellationToken cancellationToken);
}

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
        RedirectStandardError = true,
        ArgumentList = { "-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath }
    };

    public async Task RunAsync(EntraSyncJob job, CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var systemRoot = Environment.GetEnvironmentVariable("SystemRoot")
            ?? throw new InvalidOperationException("SystemRoot is unavailable.");
        using var process = new Process
        {
            StartInfo = StartInfo(systemRoot, Path.Combine(AppContext.BaseDirectory, "EntraSync", "Invoke-EntraSync.ps1"))
        };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(options.TimeoutSeconds));
        process.Start();
        // Drain both pipes concurrently. Never forward PowerShell output to API responses/logs.
        var stdout = process.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
        var stderr = process.StandardError.BaseStream.CopyToAsync(Stream.Null);
        try
        {
            // Data travels on stdin, never interpolated into commands or command-line arguments.
            await process.StandardInput.WriteLineAsync(RequestPayload(job).AsMemory(), timeout.Token);
            process.StandardInput.Close();
            await process.WaitForExitAsync(timeout.Token);
            await Task.WhenAll(stdout, stderr).WaitAsync(timeout.Token);
            if (process.ExitCode != 0) throw new InvalidOperationException("Entra sync request failed.");
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
        try
        {
            await runner.RunAsync(job, stoppingToken);
            succeeded = true;
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
        catch
        {
            logger.LogWarning("Entra {SyncKind} sync request failed on attempt {Attempt}; only synchronization will be retried.",
                job.Kind, job.Attempts + 1);
        }
        try
        {
            queue.Finish(job, succeeded, DateTimeOffset.UtcNow);
            if (succeeded) logger.LogInformation("Entra {SyncKind} sync request accepted; cloud sign-in readiness is unverified.", job.Kind);
        }
        catch
        {
            logger.LogError("Could not persist Entra sync queue progress; the sync request remains pending.");
            await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);
        }
    }
}
