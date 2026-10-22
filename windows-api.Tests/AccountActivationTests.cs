using AcmProvisioning;
using Xunit;

namespace AcmProvisioning.Tests;

public class AccountActivationTests
{
    private const string EventId = "00000000-0000-0000-0000-000000000001";
    private static readonly ActivateAccountRequest Request = new(EventId, " old secret ", " new secret ");

    [Fact]
    public void ActivationChangesPasswordUsingTheExactOldAndNewValues()
    {
        var account = new FakeAccount();
        Assert.True(AdAccountActivation.Activate(account, Request));
        Assert.Equal((Request.CurrentPassword, Request.NewPassword), account.Changed);
        Assert.Equal(1, account.ChangeCalls);
        Assert.False(AdAccountActivation.Activate(account, Request));
        Assert.Equal(1, account.ChangeCalls);
    }

    [Theory]
    [InlineData(false, true, 0x200)]
    [InlineData(true, false, 0x200)]
    [InlineData(true, true, 0x202)]
    [InlineData(true, true, 0x220)]
    public void IneligibleAccountNeverChangesPassword(bool owned, bool initial, int flags)
    {
        var account = new FakeAccount { Owned = owned, RequiresPasswordChange = initial, UserAccountControl = flags };
        Assert.False(AdAccountActivation.Activate(account, Request));
        Assert.Equal(0, account.ChangeCalls);
    }

    [Fact]
    public void MissingAccountOrWrongEventCannotActivate()
    {
        Assert.False(AdAccountActivation.Activate(null, Request));
        var account = new FakeAccount();
        Assert.False(AdAccountActivation.Activate(account, Request with { EventId = "another-event" }));
        Assert.Equal(0, account.ChangeCalls);
    }

    [Fact]
    public void RejectedChangeIsNotRetriedOrConvertedToSuccess()
    {
        var account = new FakeAccount { Reject = true };
        Assert.Throws<PasswordChangeException>(() => AdAccountActivation.Activate(account, Request));
        Assert.Equal(1, account.ChangeCalls);
        Assert.True(account.RequiresPasswordChange);
    }

    private sealed class FakeAccount : IAdActivationAccount
    {
        public bool Owned { get; init; } = true;
        public bool RequiresPasswordChange { get; set; } = true;
        public int UserAccountControl { get; init; } = 0x200;
        public bool Reject { get; init; }
        public int ChangeCalls { get; private set; }
        public (string, string)? Changed { get; private set; }
        public bool IsOwnedBy(string eventId) => Owned && eventId == EventId;
        public void ChangePassword(string current, string next)
        {
            ChangeCalls++;
            if (Reject) throw new PasswordChangeException("Rejected");
            Changed = (current, next);
            RequiresPasswordChange = false;
        }
    }
}
