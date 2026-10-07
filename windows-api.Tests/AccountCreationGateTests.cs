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
            AdAccountCreationGate.RunAsync<CreateUserResponse>(name, () => throw new InvalidOperationException("AD unavailable")));
        var retry = await AdAccountCreationGate.RunAsync(name,
            () => new CreateUserResponse(name, true, "retry-password")).WaitAsync(TestTimeout);
        Assert.Equal("retry-password", retry.OneTimePassword);
    }

    [Fact]
    public async Task CompletedPasswordChangePreventsQueuedCredentialReissueEvenAfterDisconnect()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        using var disconnected = new CancellationTokenSource();
        var account = new TestAccount(_ => { });
        account.SetPassword("initial-password");
        var change = AdAccountCreationGate.RunAsync("ASmith", () =>
        {
            started.SetResult();
            if (!release.Wait(TestTimeout)) throw new TimeoutException("Password change was not released");
            return account.ChangePassword("initial-password", "user-chosen-password");
        }, disconnected.Token);
        try
        {
            await started.Task.WaitAsync(TestTimeout);
            disconnected.Cancel();
            var retry = AdAccountCreationGate.RunAsync("asmith",
                () => Reissue(account, "retry-password"));
            Assert.False(change.IsCompleted);
            Assert.False(retry.IsCompleted);
            release.Set();

            Assert.True(await change.WaitAsync(TestTimeout));
            Assert.Null((await retry.WaitAsync(TestTimeout)).OneTimePassword);
            Assert.Equal("user-chosen-password", account.Password);
            Assert.False(account.RequiresPasswordChange);
        }
        finally
        {
            release.Set();
            await change.WaitAsync(TestTimeout);
        }
    }

    [Fact]
    public async Task CredentialReissueCompletesBeforeQueuedPasswordChangeVerifiesTheOldPassword()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var account = new TestAccount(password =>
        {
            if (password != "reissued-password") return;
            started.SetResult();
            if (!release.Wait(TestTimeout)) throw new TimeoutException("Credential reissue was not released");
        });
        account.SetPassword("initial-password");
        var retry = AdAccountCreationGate.RunAsync("ASmith",
            () => Reissue(account, "reissued-password"));
        try
        {
            await started.Task.WaitAsync(TestTimeout);
            var change = AdAccountCreationGate.RunAsync("asmith",
                () => account.ChangePassword("initial-password", "user-chosen-password"));
            Assert.False(change.IsCompleted);
            release.Set();
            Assert.Equal("reissued-password", (await retry.WaitAsync(TestTimeout)).OneTimePassword);
            await Assert.ThrowsAsync<PasswordChangeException>(() => change.WaitAsync(TestTimeout));
            Assert.Equal("reissued-password", account.Password);

            Assert.True(await AdAccountCreationGate.RunAsync("asmith",
                () => account.ChangePassword("reissued-password", "user-chosen-password")));
            var later = await AdAccountCreationGate.RunAsync("asmith",
                () => Reissue(account, "later-password"));
            Assert.Null(later.OneTimePassword);
            Assert.Equal("user-chosen-password", account.Password);
        }
        finally
        {
            release.Set();
            await retry.WaitAsync(TestTimeout);
        }
    }

    private static CreateUserResponse Reissue(TestAccount account, string password) =>
        AdAccountCreation.Create("asmith", () => account,
            () => throw new Exception("Unexpected create"), () => password,
            "event-1", retryCredentialDelivery: true);

    private sealed class TestAccount(Action<string> beforePassword) : IAdProvisioningAccount
    {
        public string? Password { get; private set; }
        public int UserAccountControl => AdAccountCreation.UacEnabled;
        public bool RequiresPasswordChange { get; private set; } = true;
        public bool IsOwnedBy(string eventId) => eventId == "event-1";
        public void SetPassword(string password)
        {
            beforePassword(password);
            Password = password;
        }
        public void Enable() => RequiresPasswordChange = true;
        public bool ChangePassword(string currentPassword, string newPassword)
        {
            if (Password != currentPassword) throw new PasswordChangeException("Current password is incorrect.");
            Password = newPassword;
            RequiresPasswordChange = false;
            return true;
        }
        public void Delete() => throw new Exception("Unexpected deletion");
        public void Dispose() { }
    }
}
