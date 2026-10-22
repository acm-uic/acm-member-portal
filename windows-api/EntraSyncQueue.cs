using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AcmProvisioning;

public sealed class EntraSyncOptions
{
    public bool Enabled { get; set; }
    public string QueueDirectory { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 120;

    internal void Validate()
    {
        if (!Enabled) return;
        if (!Path.IsPathFullyQualified(QueueDirectory))
            throw new InvalidOperationException("EntraSync:QueueDirectory must be an absolute, persistent directory.");
        if (TimeoutSeconds is < 10 or > 600)
            throw new InvalidOperationException("EntraSync configuration is invalid.");
    }
}

public enum EntraSyncKind { Directory, Password }
public sealed record EntraSyncJob(string Key, Guid Id, EntraSyncKind Kind,
    string? DistinguishedName, int Attempts, DateTimeOffset NextAttempt);

public interface IEntraSyncQueue
{
    void Enqueue(EntraSyncKind kind, string? distinguishedName = null);
}

/// <summary>One writer per queue directory; atomic snapshots survive service restarts.</summary>
public sealed class EntraSyncQueue : IEntraSyncQueue, IDisposable
{
    private readonly object _gate = new();
    private readonly EntraSyncOptions _options;
    private readonly string _path;
    private readonly FileStream? _lease;
    private Dictionary<string, EntraSyncJob> _jobs = new();

    public EntraSyncQueue(EntraSyncOptions options)
    {
        options.Validate();
        _options = options;
        _path = Path.Combine(options.QueueDirectory, "queue.json");
        if (!options.Enabled) return;
        Directory.CreateDirectory(options.QueueDirectory);
        _lease = new FileStream(Path.Combine(options.QueueDirectory, "queue.lock"),
            FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        try
        {
            if (File.Exists(_path))
                _jobs = JsonSerializer.Deserialize<Dictionary<string, EntraSyncJob>>(File.ReadAllText(_path))
                    ?? throw new InvalidDataException("Invalid Entra sync queue.");
            if (_jobs.Count > 10_000 || _jobs.Any(pair => pair.Key != Key(pair.Value.Kind, pair.Value.DistinguishedName)
                || pair.Key != pair.Value.Key || pair.Value.Attempts is < 0 or > 1000))
                throw new InvalidDataException("Invalid Entra sync queue.");
            // Verify write access at startup, before accepting AD mutations.
            Save(_jobs);
        }
        catch { _lease.Dispose(); throw; }
    }

    public void Enqueue(EntraSyncKind kind, string? distinguishedName = null)
    {
        if (!_options.Enabled) return;
        var key = Key(kind, distinguishedName);
        lock (_gate)
        {
            if (!_jobs.ContainsKey(key) && _jobs.Count >= 10_000)
                throw new IOException("Entra sync queue is full.");
            var next = new Dictionary<string, EntraSyncJob>(_jobs)
            {
                // A new ID prevents an in-flight completion from discarding a newer change.
                [key] = new(key, Guid.NewGuid(), kind, distinguishedName, 0, DateTimeOffset.UtcNow)
            };
            Save(next);
            _jobs = next;
        }
    }

    internal EntraSyncJob? Due(DateTimeOffset now)
    {
        lock (_gate)
            return _jobs.Values.Where(job => job.NextAttempt <= now)
                .OrderBy(job => job.Kind).ThenBy(job => job.NextAttempt).FirstOrDefault();
    }

    internal void Finish(EntraSyncJob job, bool succeeded, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (!_jobs.TryGetValue(job.Key, out var current) || current.Id != job.Id) return;
            var next = new Dictionary<string, EntraSyncJob>(_jobs);
            if (succeeded) next.Remove(job.Key);
            else
            {
                var attempts = Math.Min(job.Attempts + 1, 1000);
                next[job.Key] = job with
                {
                    Attempts = attempts,
                    NextAttempt = now.AddSeconds(Math.Min(300, 15 * Math.Pow(2, Math.Min(attempts - 1, 5))))
                };
            }
            Save(next);
            _jobs = next;
        }
    }

    private void Save(Dictionary<string, EntraSyncJob> jobs)
    {
        var temporary = _path + ".tmp";
        using (var file = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            JsonSerializer.Serialize(file, jobs);
            file.Flush(flushToDisk: true);
        }
        File.Move(temporary, _path, overwrite: true);
    }

    private static string Key(EntraSyncKind kind, string? dn)
    {
        if (kind == EntraSyncKind.Directory && dn is null) return "directory";
        if (kind != EntraSyncKind.Password || string.IsNullOrWhiteSpace(dn) || dn.Length > 4096 || dn.Contains('\0'))
            throw new ArgumentException("Invalid sync job.");
        return "password:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(dn.ToUpperInvariant())));
    }

    public void Dispose() => _lease?.Dispose();
}

/// <summary>Never turn a completed AD operation into a failure or retry it for sync.</summary>
public sealed class AdSyncNotifications(IEntraSyncQueue queue, ILogger<AdSyncNotifications> logger)
{
    public CreateUserResponse Provision(Func<CreateUserResponse> provision)
    {
        var result = provision();
        // Replays also heal a missed directory-sync request without recreating the account.
        Notify(EntraSyncKind.Directory);
        return result;
    }

    public bool ChangePassword(string? dn, Func<bool> change)
    {
        var changed = change();
        if (changed) Notify(EntraSyncKind.Password, dn);
        return changed;
    }

    private void Notify(EntraSyncKind kind, string? dn = null)
    {
        try { queue.Enqueue(kind, dn); }
        catch
        {
            // Do not log an exception from the password-handling call stack.
            try
            {
                logger.LogError("Could not persist {SyncKind} sync request after successful AD operation. Scheduled Entra Connect synchronization remains the fallback.", kind);
            }
            catch { /* A logging failure must also preserve the applied AD result. */ }
        }
    }
}
