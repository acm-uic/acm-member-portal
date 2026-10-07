using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using AcmProvisioning;
using Xunit;

namespace AcmProvisioning.Tests;

public class UserPlacementTests
{
    [Theory]
    [InlineData("2026-11-01T04:59:59Z", "2026", "10")]
    [InlineData("2026-11-01T05:00:00Z", "2026", "11")]
    [InlineData("2027-01-01T05:59:59Z", "2026", "12")]
    [InlineData("2027-01-01T06:00:00Z", "2027", "01")]
    public void CreationMonthUsesChicagoTimeAcrossMonthAndYearBoundaries(string timestamp, string year, string month)
    {
        var timeZone = TimeZoneInfo.FindSystemTimeZoneById("America/Chicago");
        var createdAt = DateTimeOffset.Parse(timestamp, CultureInfo.InvariantCulture);
        Assert.Equal((year, month), AdUserPlacement.OuNames(createdAt, timeZone));
    }

    [Fact]
    public void MonthNameDoesNotUseTheCurrentCulturesCalendar()
    {
        var original = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("th-TH");
            Assert.Equal(("2026", "10"), AdUserPlacement.OuNames(
                new DateTimeOffset(2026, 10, 7, 0, 0, 0, TimeSpan.Zero), TimeZoneInfo.Utc));
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
        }
    }

    [Fact]
    public void UsesLegalNameWithUsernameSuffixForACollision()
    {
        var first = new CreateUserRequest("asmith", "Alex", "Smith", "Alex Smith",
            "first@example.com", null, "event-1", Username: "asmith");
        var second = first with { Username = "asmith2", EventId = "event-2" };
        Assert.Equal("CN=Alex Smith", AdUserPlacement.UserRdn(first.FirstName, first.LastName));
        var firstFallback = AdUserPlacement.UserRdn(first.FirstName, first.LastName, first.AccountName);
        var secondFallback = AdUserPlacement.UserRdn(second.FirstName, second.LastName, second.AccountName);
        Assert.NotEqual(firstFallback, secondFallback);
        Assert.Equal("CN=Alex Smith (asmith2)", secondFallback);
        Assert.Equal(first.DisplayName, second.DisplayName);
    }

    [Theory]
    [InlineData("a,b+c", "CN=a\\,b\\+c Smith")]
    [InlineData("#name", "CN=\\#name Smith")]
    [InlineData("a\\b", "CN=a\\\\b Smith")]
    [InlineData("a\0b", "CN=a\\00b Smith")]
    public void LegalNameCannotChangeTheDistinguishedNameStructure(string firstName, string expected)
    {
        Assert.Equal(expected, AdUserPlacement.UserRdn(firstName, "Smith"));
    }

    [Fact]
    public void CollisionSuffixCannotChangeTheDistinguishedNameStructure()
    {
        Assert.Equal("CN=Alex Smith (a\\,b\\+c)", AdUserPlacement.UserRdn("Alex", "Smith", "a,b+c"));
    }

    [Theory]
    [InlineData(0x80071392u, true)]
    [InlineData(0x80072071u, true)]
    [InlineData(0x80070005u, false)]
    [InlineData(0x8007203Au, false)]
    public void OnlyEntryExistsErrorsAllowANameCollisionRetry(uint code, bool expected)
    {
        var error = new TargetInvocationException(new COMException("Directory failure", unchecked((int)code)));
        Assert.Equal(expected, AdErrors.IsEntryExists(error));
    }
}
