using System.Runtime.InteropServices;
using AcmProvisioning;
using Xunit;

namespace AcmProvisioning.Tests;

public class AccountCreationTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void FailedSetupDeletesOnlyTheCreatedAccountAndRetryCreatesAUsableAccount(bool failPassword)
    {
        FakeAccount? stored = null;
        var failed = new FakeAccount { FailPassword = failPassword, FailEnable = !failPassword };
        failed.OnDelete = () => stored = null;
        var expectedError = Assert.Throws<InvalidOperationException>(() => AdAccountCreation.Create(
            "asmith", () => stored, () => stored = failed, () => "first-password"));
        Assert.Equal(failPassword ? "password rejected" : "enable rejected", expectedError.Message);
        Assert.True(failed.Deleted);
        Assert.True(failed.Disposed);
        Assert.Null(stored);

        var retry = new FakeAccount();
        var result = AdAccountCreation.Create(
            "asmith", () => stored, () => stored = retry, () => "retry-password");
        Assert.False(result.Existed);
        Assert.Equal("retry-password", result.OneTimePassword);
        Assert.Equal("retry-password", retry.Password);
        Assert.Equal(AdAccountCreation.UacEnabled, retry.UserAccountControl);
        Assert.False(retry.Deleted);
    }

    [Fact]
    public void FailedCleanupSurfacesBothErrorsAndTheLeftoverAccountCannotReplayAsSuccess()
    {
        var account = new FakeAccount { FailPassword = true, FailDelete = true };
        FakeAccount? stored = null;
        var error = Assert.Throws<ProvisioningException>(() => AdAccountCreation.Create(
            "asmith", () => stored, () => stored = account, () => "test-secret-value"));
        Assert.Contains("password rejected", error.Message);
        Assert.Contains("delete rejected", error.Message);
        Assert.DoesNotContain("test-secret-value", error.Message);
        Assert.False(account.Deleted);

        Assert.Throws<ProvisioningException>(() => AdAccountCreation.Create(
            "asmith", () => stored, UnexpectedCreate, UnexpectedPassword));
    }

    [Theory]
    [InlineData(0x202)] // Disabled, including after a crash following SetPassword.
    [InlineData(0x222)] // Initial disabled account without a required password.
    [InlineData(0x220)] // Enabled but password setup is still incomplete.
    [InlineData(0)]
    public void ExistingIncompleteAccountsAreRejectedWithoutModification(int flags)
    {
        var existing = new FakeAccount { UserAccountControl = flags };
        Assert.Throws<ProvisioningException>(() => AdAccountCreation.Create(
            "asmith", () => existing, UnexpectedCreate, UnexpectedPassword));
        Assert.Null(existing.Password);
        Assert.Equal(0, existing.EnableCalls);
        Assert.Equal(0, existing.DeleteCalls);
        Assert.True(existing.Disposed);
    }

    [Fact]
    public void ExistingReadyAccountReplaysWithoutPasswordOrModification()
    {
        var existing = new FakeAccount { UserAccountControl = AdAccountCreation.UacEnabled };
        var result = AdAccountCreation.Create("asmith", () => existing, UnexpectedCreate, UnexpectedPassword);
        Assert.True(result.Existed);
        Assert.Null(result.OneTimePassword);
        Assert.Null(existing.Password);
        Assert.Equal(0, existing.EnableCalls);
        Assert.Equal(0, existing.DeleteCalls);
    }

    [Theory]
    [InlineData(0x200, true)]
    [InlineData(0x222, false)]
    public void AConcurrentCreateOnlyReplaysWhenTheOtherAccountIsReady(int flags, bool succeeds)
    {
        var raced = new FakeAccount { UserAccountControl = flags };
        var lookups = 0;
        CreateUserResponse Run() => AdAccountCreation.Create("asmith",
            () => ++lookups == 1 ? null : raced,
            () => throw new COMException("already exists", unchecked((int)0x80071392)),
            () => "unused-password");
        if (succeeds)
        {
            var result = Run();
            Assert.True(result.Existed);
            Assert.Null(result.OneTimePassword);
        }
        else
        {
            Assert.Throws<ProvisioningException>(() => Run());
        }
        Assert.Null(raced.Password);
        Assert.Equal(0, raced.EnableCalls);
        Assert.Equal(0, raced.DeleteCalls);
    }

    [Fact]
    public void AnUnrelatedCreateFailureIsNotTurnedIntoASuccessfulReplay()
    {
        var lookups = 0;
        var error = new COMException("access denied", unchecked((int)0x80070005));
        var thrown = Assert.Throws<COMException>(() => AdAccountCreation.Create("asmith",
            () => { lookups++; return null; }, () => throw error, () => "password"));
        Assert.Same(error, thrown);
        Assert.Equal(1, lookups);
    }

    private static IAdProvisioningAccount UnexpectedCreate() => throw new Exception("Unexpected account creation");
    private static string UnexpectedPassword() => throw new Exception("Unexpected password generation");

    private sealed class FakeAccount : IAdProvisioningAccount
    {
        public int UserAccountControl { get; set; } = AdAccountCreation.UacCreateDisabled;
        public bool FailPassword { get; init; }
        public bool FailEnable { get; init; }
        public bool FailDelete { get; init; }
        public Action? OnDelete { get; set; }
        public string? Password { get; private set; }
        public int EnableCalls { get; private set; }
        public int DeleteCalls { get; private set; }
        public bool Deleted { get; private set; }
        public bool Disposed { get; private set; }

        public void SetPassword(string password)
        {
            if (FailPassword) throw new InvalidOperationException("password rejected");
            Password = password;
        }

        public void Enable()
        {
            EnableCalls++;
            if (FailEnable) throw new InvalidOperationException("enable rejected");
            UserAccountControl = AdAccountCreation.UacEnabled;
        }

        public void Delete()
        {
            DeleteCalls++;
            if (FailDelete) throw new InvalidOperationException("delete rejected");
            Deleted = true;
            OnDelete?.Invoke();
        }

        public void Dispose() => Disposed = true;
    }
}
