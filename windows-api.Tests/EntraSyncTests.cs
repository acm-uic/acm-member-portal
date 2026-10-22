using AcmProvisioning;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using System.Text.Json;
using Xunit;

namespace AcmProvisioning.Tests;

public sealed class EntraSyncTests : IDisposable
{
    private const string Dn = "CN=sync-test,OU=10,OU=2026,OU=ACMUsers,DC=acmuic,DC=org";
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "acm-sync-tests-" + Guid.NewGuid());
    private EntraSyncOptions Options => new() { Enabled = true, QueueDirectory = _directory };
    private static readonly DateTimeOffset Future = DateTimeOffset.UtcNow.AddDays(1);

    [Fact]
    public void DisabledIntegrationDoesNotTouchDiskOrQueueWork()
    {
        using var queue = new EntraSyncQueue(new() { QueueDirectory = _directory });
        queue.Enqueue(EntraSyncKind.Directory);
        queue.Enqueue(EntraSyncKind.UserHash, Dn);
        Assert.Null(queue.Due(Future));
        Assert.False(Directory.Exists(_directory));
    }

    [Fact]
    public void PendingWorkSurvivesRestartAndSuccessfulWorkStaysRemoved()
    {
        using (var first = new EntraSyncQueue(Options))
        {
            first.Enqueue(EntraSyncKind.UserHash, Dn);
            first.Enqueue(EntraSyncKind.Directory);
            first.Enqueue(EntraSyncKind.Directory);
        }
        using (var second = new EntraSyncQueue(Options))
        {
            var directory = Assert.IsType<EntraSyncJob>(second.Due(Future));
            Assert.Equal(EntraSyncKind.Directory, directory.Kind);
            second.Finish(directory, true, DateTimeOffset.UtcNow);
            var password = Assert.IsType<EntraSyncJob>(second.Due(Future));
            Assert.Equal(Dn, password.DistinguishedName);
            second.Finish(password, true, DateTimeOffset.UtcNow);
            Assert.Null(second.Due(Future));
        }
        using var third = new EntraSyncQueue(Options);
        Assert.Null(third.Due(Future));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void CompletionCannotLoseAChangeQueuedWhileSyncIsRunning(bool succeeded)
    {
        using var queue = new EntraSyncQueue(Options);
        queue.Enqueue(EntraSyncKind.UserHash, Dn);
        var running = Assert.IsType<EntraSyncJob>(queue.Due(Future));
        queue.Enqueue(EntraSyncKind.UserHash, Dn.ToUpperInvariant());
        queue.Finish(running, succeeded, DateTimeOffset.UtcNow);
        var newer = Assert.IsType<EntraSyncJob>(queue.Due(Future));
        Assert.NotEqual(running.Id, newer.Id);
        queue.Finish(newer, true, DateTimeOffset.UtcNow);
        Assert.Null(queue.Due(Future));
    }

    [Fact]
    public void FailedWorkUsesPersistentBackoffAndDoesNotStarveOtherWork()
    {
        var now = DateTimeOffset.UtcNow;
        using (var queue = new EntraSyncQueue(Options))
        {
            queue.Enqueue(EntraSyncKind.Directory);
            var job = Assert.IsType<EntraSyncJob>(queue.Due(Future));
            queue.Finish(job, false, now);
            Assert.Null(queue.Due(now));
            queue.Enqueue(EntraSyncKind.UserHash, Dn);
            Assert.Equal(EntraSyncKind.UserHash, queue.Due(now.AddSeconds(1))!.Kind);
        }
        using var reloaded = new EntraSyncQueue(Options);
        var directory = reloaded.Due(now.AddSeconds(15))!;
        Assert.Equal(EntraSyncKind.Directory, directory.Kind);
        Assert.Equal(1, directory.Attempts);
        for (var i = 0; i < 20; i++)
        {
            reloaded.Finish(directory, false, now);
            directory = reloaded.Due(Future)!;
        }
        Assert.Equal(now.AddMinutes(5), directory.NextAttempt);
    }

    [Fact]
    public void CorruptStateFailsStartupInsteadOfSilentlyDiscardingWork()
    {
        Directory.CreateDirectory(_directory);
        File.WriteAllText(Path.Combine(_directory, "queue.json"), "broken json");
        Assert.ThrowsAny<Exception>(() => new EntraSyncQueue(Options));
        // Failed initialization releases the lease so an administrator can repair/restart.
        File.WriteAllText(Path.Combine(_directory, "queue.json"), "{}");
        using var repaired = new EntraSyncQueue(Options);
    }

    [Fact]
    public void QueueDirectoryCannotBeSharedByConcurrentServiceInstances()
    {
        using var first = new EntraSyncQueue(Options);
        Assert.Throws<IOException>(() => new EntraSyncQueue(Options));
    }

    [Fact]
    public void FailedAtomicSaveDoesNotReplaceTheLastDurableSnapshot()
    {
        using var queue = new EntraSyncQueue(Options);
        queue.Enqueue(EntraSyncKind.Directory);
        var original = File.ReadAllText(Path.Combine(_directory, "queue.json"));
        Directory.CreateDirectory(Path.Combine(_directory, "queue.json.tmp"));
        Assert.ThrowsAny<Exception>(() => queue.Enqueue(EntraSyncKind.UserHash, Dn));
        Assert.Equal(original, File.ReadAllText(Path.Combine(_directory, "queue.json")));
        var directory = queue.Due(Future)!;
        Assert.Equal(EntraSyncKind.Directory, directory.Kind);
        Assert.Equal(original, File.ReadAllText(Path.Combine(_directory, "queue.json")));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("bad\0dn")]
    public void InvalidPasswordJobCannotEnterQueue(string? dn)
    {
        using var queue = new EntraSyncQueue(Options);
        Assert.Throws<ArgumentException>(() => queue.Enqueue(EntraSyncKind.UserHash, dn));
        Assert.Null(queue.Due(Future));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ProvisioningAndReplaysRequestDirectorySyncOnlyAfterSuccess(bool existed)
    {
        var queue = new RecordingQueue();
        var hooks = Hooks(queue);
        var calls = 0;
        var response = new CreateUserResponse("sync-test", existed, existed ? null : "secret");
        Assert.Same(response, hooks.Provision(() => { calls++; return response; }));
        Assert.Equal(1, calls);
        Assert.Equal((EntraSyncKind.Directory, (string?)null), Assert.Single(queue.Jobs));
        Assert.Throws<ProvisioningException>(() => hooks.Provision(() => throw new ProvisioningException("rejected")));
        Assert.Single(queue.Jobs);
    }

    [Fact]
    public void ActivationAndRegularPasswordChangesQueueOnlyConfirmedChanges()
    {
        var queue = new RecordingQueue();
        var hooks = Hooks(queue);
        var calls = 0;
        Assert.True(hooks.ChangePassword(Dn, () => { calls++; return true; }));
        Assert.Equal(1, calls);
        Assert.Equal((EntraSyncKind.UserHash, (string?)Dn), Assert.Single(queue.Jobs));
        Assert.False(hooks.ChangePassword(Dn, () => false));
        Assert.Throws<PasswordChangeException>(() => hooks.ChangePassword(Dn, () => throw new PasswordChangeException("rejected")));
        Assert.Single(queue.Jobs);
    }

    [Fact]
    public void PersistenceFailureNeverRepeatsOrFailsAnAppliedAdOperation()
    {
        var queue = new RecordingQueue { Fail = true };
        var hooks = Hooks(queue);
        var passwordCalls = 0;
        Assert.True(hooks.ChangePassword(Dn, () => { passwordCalls++; return true; }));
        Assert.Equal(1, passwordCalls);
        var createCalls = 0;
        Assert.False(hooks.Provision(() => { createCalls++; return new("sync-test", false, "secret"); }).Existed);
        Assert.Equal(1, createCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkerRetriesOnlyTheSyncRequestAndRemovesSuccessfulWork(bool fail)
    {
        using var queue = new EntraSyncQueue(Options);
        queue.Enqueue(EntraSyncKind.UserHash, Dn);
        var job = queue.Due(Future)!;
        var runner = new FakeRunner { Fail = fail };
        var worker = new EntraSyncWorker(Options, queue, runner, NullLogger<EntraSyncWorker>.Instance);
        await worker.ProcessAsync(job, CancellationToken.None);
        Assert.Equal(1, runner.Calls);
        if (fail)
        {
            Assert.Null(queue.Due(DateTimeOffset.UtcNow));
            Assert.Equal(1, queue.Due(Future)!.Attempts);
        }
        else Assert.Null(queue.Due(Future));
    }

    [Fact]
    public void ExistingQueueFilesAndPowerShellProtocolRemainCompatible()
    {
        Directory.CreateDirectory(_directory);
        // Snapshot from the original queue format: Kind=1 and the original key prefix.
        File.WriteAllText(Path.Combine(_directory, "queue.json"), """
            {
              "password:C62E71E95B6333C493DC8970C0AE64958824F4B3DC7516D4A203431768EB4954": {
                "Key": "password:C62E71E95B6333C493DC8970C0AE64958824F4B3DC7516D4A203431768EB4954",
                "Id": "00000000-0000-0000-0000-000000000001",
                "Kind": 1,
                "DistinguishedName": "CN=sync-test,OU=10,OU=2026,OU=ACMUsers,DC=acmuic,DC=org",
                "Attempts": 2,
                "NextAttempt": "2026-01-01T00:00:00Z"
              }
            }
            """);
        using var queue = new EntraSyncQueue(Options);
        var job = Assert.IsType<EntraSyncJob>(queue.Due(Future));
        Assert.Equal(EntraSyncKind.UserHash, job.Kind);
        Assert.Equal(2, job.Attempts);
        using var payload = JsonDocument.Parse(PowerShellEntraSyncRunner.RequestPayload(job));
        Assert.Equal("Password", payload.RootElement.GetProperty("Kind").GetString());
        Assert.Equal(Dn, payload.RootElement.GetProperty("DistinguishedName").GetString());
        queue.Finish(job, true, DateTimeOffset.UtcNow);
        Assert.Null(queue.Due(Future));
    }

    [Fact]
    public async Task QueuePayloadsAndDiagnosticsNeverContainAccountCredentials()
    {
        const string temporaryCredential = "temporary-sentinel-8Q!";
        const string currentCredential = "current-sentinel-4W!";
        const string nextCredential = "next-sentinel-6E!";
        using var queue = new EntraSyncQueue(Options);
        var notificationsLog = new CapturingLogger<AdSyncNotifications>();
        var hooks = new AdSyncNotifications(queue, notificationsLog);
        var response = hooks.Provision(() => new("sync-test", false, temporaryCredential));
        Assert.Equal(temporaryCredential, response.OneTimePassword);
        Assert.True(hooks.ChangePassword(Dn, () => currentCredential != nextCredential));
        var snapshot = File.ReadAllText(Path.Combine(_directory, "queue.json"));

        // Finish the directory request, then exercise failure and success logging for user hash sync.
        var workerLog = new CapturingLogger<EntraSyncWorker>();
        var directory = queue.Due(Future)!;
        await new EntraSyncWorker(Options, queue, new FakeRunner(), workerLog).ProcessAsync(directory, CancellationToken.None);
        var job = queue.Due(Future)!;
        var failed = new FakeRunner { Failure = new InvalidOperationException($"{currentCredential} {nextCredential}") };
        await new EntraSyncWorker(Options, queue, failed, workerLog).ProcessAsync(job, CancellationToken.None);
        await new EntraSyncWorker(Options, queue, new FakeRunner(), workerLog).ProcessAsync(queue.Due(Future)!, CancellationToken.None);

        // Notification persistence failures must also avoid logging credentials/call-stack exceptions.
        var unavailable = new AdSyncNotifications(new RecordingQueue { Fail = true }, notificationsLog);
        Assert.True(unavailable.ChangePassword(Dn, () => currentCredential != nextCredential));
        var diagnostics = string.Join('\n', notificationsLog.Messages.Concat(workerLog.Messages));
        Assert.NotEmpty(notificationsLog.Messages);
        Assert.NotEmpty(workerLog.Messages);
        foreach (var secret in new[] { temporaryCredential, currentCredential, nextCredential })
        {
            Assert.DoesNotContain(secret, snapshot);
            Assert.DoesNotContain(secret, PowerShellEntraSyncRunner.RequestPayload(job));
            Assert.DoesNotContain(secret, diagnostics);
        }
        Assert.DoesNotContain(Dn, diagnostics);
    }

    [Fact]
    public async Task ShutdownLeavesTheJobPendingForTheNextServiceStart()
    {
        using var queue = new EntraSyncQueue(Options);
        queue.Enqueue(EntraSyncKind.Directory);
        var job = queue.Due(Future)!;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var worker = new EntraSyncWorker(Options, queue, new FakeRunner(), NullLogger<EntraSyncWorker>.Instance);
        await worker.ProcessAsync(job, cancellation.Token);
        Assert.Equal(job, queue.Due(Future));
    }

    [Fact]
    public void RunnerUsesFixedExecutableAndScriptWithoutCommandInterpolation()
    {
        var start = PowerShellEntraSyncRunner.StartInfo("C:\\Windows", "C:\\path with spaces\\Invoke-EntraSync.ps1");
        Assert.EndsWith("powershell.exe", start.FileName);
        Assert.Equal(new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-File", "C:\\path with spaces\\Invoke-EntraSync.ps1" }, start.ArgumentList);
        Assert.False(start.UseShellExecute);
        Assert.True(start.RedirectStandardInput);
        Assert.DoesNotContain("-Command", start.ArgumentList);
        Assert.DoesNotContain("-ExecutionPolicy", start.ArgumentList);
    }

    [Fact]
    public void EnabledConfigurationRequiresPersistentPathAndBoundedTimeout()
    {
        Assert.Throws<InvalidOperationException>(() => new EntraSyncQueue(new() { Enabled = true, QueueDirectory = "relative" }));
        Assert.Throws<InvalidOperationException>(() => new EntraSyncQueue(withTimeout(0)));
        EntraSyncOptions withTimeout(int timeout) => new() { Enabled = true, QueueDirectory = _directory, TimeoutSeconds = timeout };
    }

    private static AdSyncNotifications Hooks(IEntraSyncQueue queue) => new(queue, NullLogger<AdSyncNotifications>.Instance);
    private sealed class RecordingQueue : IEntraSyncQueue
    {
        public bool Fail { get; init; }
        public List<(EntraSyncKind, string?)> Jobs { get; } = new();
        public void Enqueue(EntraSyncKind kind, string? distinguishedName = null)
        {
            if (Fail) throw new IOException("disk unavailable");
            Jobs.Add((kind, distinguishedName));
        }
    }
    private sealed class FakeRunner : IEntraSyncRunner
    {
        public bool Fail { get; init; }
        public Exception? Failure { get; init; }
        public int Calls { get; private set; }
        public Task RunAsync(EntraSyncJob job, CancellationToken cancellationToken)
        {
            Calls++;
            cancellationToken.ThrowIfCancellationRequested();
            if (Failure is not null) throw Failure;
            if (Fail) throw new InvalidOperationException("sync unavailable");
            return Task.CompletedTask;
        }
    }
    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = new();
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) =>
            Messages.Add(formatter(state, exception) + (exception?.ToString() ?? ""));
    }
    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }
}
