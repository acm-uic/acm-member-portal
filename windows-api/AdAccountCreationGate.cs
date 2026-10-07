namespace AcmProvisioning;

internal static class AdAccountCreationGate
{
    // A bounded set of gates avoids retaining a lock for every username forever.
    // Case-insensitive hashing puts alternate spellings of one account on the same gate.
    private static readonly SemaphoreSlim[] Gates = Enumerable.Range(0, 128)
        .Select(_ => new SemaphoreSlim(1, 1)).ToArray();

    public static async Task<T> RunAsync<T>(
        string accountName, Func<T> operation,
        CancellationToken cancellationToken = default)
    {
        var hash = unchecked((uint)StringComparer.OrdinalIgnoreCase.GetHashCode(accountName));
        var gate = Gates[hash % (uint)Gates.Length];
        await gate.WaitAsync(cancellationToken);
        try
        {
            // Cancel abandoned requests while queued, but keep the gate until an
            // already-running ADSI operation finishes, even after client disconnect.
            return await Task.Run(operation, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }
}
