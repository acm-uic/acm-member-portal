using AcmProvisioning;
using Xunit;

namespace AcmProvisioning.Tests;

public class AccountCreationGateTests
{
    private static readonly TimeSpan TestTimeout = TimeSpan.FromSeconds(5);

    [Fact]
    public async Task DisconnectedResetFinishesBeforeItsRetryCanIssueCredentials()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        using var disconnected = new CancellationTokenSource();
        var account = new TestAccount(password =>
        {
            if (password != "abandoned-password") return;
            started.SetResult();
            if (!release.Wait(TestTimeout)) throw new TimeoutException("Reset was not released");
        });
        var first = AdAccountCreationGate.RunAsync("ASmith",
            () => Reissue(account, "abandoned-password"), disconnected.Token);
        try
        {
            await started.Task.WaitAsync(TestTimeout);
            disconnected.Cancel();
            var retry = AdAccountCreationGate.RunAsync("asmith",
                () => Reissue(account, "delivered-password"));

            // Disconnect cannot release a gate while the first ADSI reset is running.
            Assert.False(first.IsCompleted);
            Assert.False(retry.IsCompleted);
            release.Set();
            await first.WaitAsync(TestTimeout);
            var result = await retry.WaitAsync(TestTimeout);
            Assert.Equal("delivered-password", result.OneTimePassword);
            Assert.Equal(result.OneTimePassword, account.Password);
        }
        finally
        {
            release.Set();
            await first.WaitAsync(TestTimeout);
        }
    }

    [Fact]
    public async Task CancelledQueuedRequestCannotResetThePasswordOrReleaseAnActiveGate()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        using var cancellation = new CancellationTokenSource();
        var name = "queued-cancellation";
        var active = AdAccountCreationGate.RunAsync(name, () =>
        {
            started.SetResult();
            if (!release.Wait(TestTimeout)) throw new TimeoutException("Operation was not released");
            return new CreateUserResponse(name, true, "initial-password");
        });
        try
        {
            await started.Task.WaitAsync(TestTimeout);
            var abandonedRan = false;
            var abandoned = AdAccountCreationGate.RunAsync(name, () =>
            {
                abandonedRan = true;
                return new CreateUserResponse(name, true, "abandoned-password");
            }, cancellation.Token);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => abandoned);
            Assert.False(abandonedRan);

            var retry = AdAccountCreationGate.RunAsync(name,
                () => new CreateUserResponse(name, true, "delivered-password"));
            Assert.False(retry.IsCompleted);
            release.Set();
            await active.WaitAsync(TestTimeout);
            Assert.Equal("delivered-password", (await retry.WaitAsync(TestTimeout)).OneTimePassword);
        }
        finally
        {
            release.Set();
            await active.WaitAsync(TestTimeout);
        }
    }

    [Fact]
    public async Task FailedOperationDoesNotBlockLaterAttempts()
    {
        var name = "failed-operation";
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            AdAccountCreationGate.RunAsync(name, () => throw new InvalidOperationException("AD unavailable")));
        var retry = await AdAccountCreationGate.RunAsync(name,
            () => new CreateUserResponse(name, true, "retry-password")).WaitAsync(TestTimeout);
        Assert.Equal("retry-password", retry.OneTimePassword);
    }

    private static CreateUserResponse Reissue(TestAccount account, string password) =>
        AdAccountCreation.Create("asmith", () => account,
            () => throw new Exception("Unexpected create"), () => password,
            "event-1", retryCredentialDelivery: true);

    private sealed class TestAccount(Action<string> beforePassword) : IAdProvisioningAccount
    {
        public string? Password { get; private set; }
        public int UserAccountControl => AdAccountCreation.UacEnabled;
        public bool RequiresPasswordChange => true;
        public bool IsOwnedBy(string eventId) => eventId == "event-1";
        public void SetPassword(string password)
        {
            beforePassword(password);
            Password = password;
        }
        public void Enable() { }
        public void Delete() => throw new Exception("Unexpected deletion");
        public void Dispose() { }
    }
}
