using System.Reflection;
using System.Runtime.InteropServices;
using AcmProvisioning;
using Xunit;

namespace AcmProvisioning.Tests;

public class PasswordErrorsTests
{
    [Theory]
    [InlineData(0x80070056u)]
    [InlineData(0x8007052Bu)]
    [InlineData(0x8007052Eu)]
    public void IncorrectPasswordHasUsefulMessage(uint code)
    {
        var error = new TargetInvocationException(new COMException("Incorrect old password", unchecked((int)code)));
        var message = AdErrors.PasswordChangeMessage(error, "old-secret", "new-secret");
        Assert.Contains("Your current password is incorrect.", message);
        Assert.Contains($"0x{code:X8}", message);
    }

    [Theory]
    [InlineData(0x800708C5u)]
    [InlineData(0x8007052Du)]
    [InlineData(0x8007202Fu)]
    public void PolicyRejectionsKeepDirectoryDetails(uint code)
    {
        var error = new TargetInvocationException(new COMException("Directory password history restriction", unchecked((int)code)));
        var message = AdErrors.PasswordChangeMessage(error, "old-secret", "new-secret");
        Assert.Contains("Active Directory rejected the new password.", message);
        Assert.Contains("prevent password reuse", message);
        Assert.Contains("require waiting", message);
        Assert.Contains("Directory password history restriction", message);
        Assert.Contains($"0x{code:X8}", message);
    }

    [Fact]
    public void UnknownRejectionsRetainDetailsWithoutInventingPolicyRequirements()
    {
        var message = AdErrors.PasswordChangeMessage(new COMException("Access denied", unchecked((int)0x80070005)), "old-secret", "new-secret");
        Assert.Contains("Active Directory rejected the password change.", message);
        Assert.Contains("Access denied (0x80070005)", message);
        Assert.DoesNotContain("new password.", message);
    }

    [Fact]
    public void PasswordsAreRedactedFromExceptionDetails()
    {
        var error = new TargetInvocationException(new COMException("Rejected old-secret and new-secret", unchecked((int)0x8007052D)));
        var message = AdErrors.PasswordChangeMessage(error, "old-secret", "new-secret");
        Assert.DoesNotContain("old-secret", message);
        Assert.DoesNotContain("new-secret", message);
        Assert.Contains("[redacted]", message);
    }
}
