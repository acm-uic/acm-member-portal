using System.Globalization;
using System.Text;

namespace AcmProvisioning;

internal static class AdUserPlacement
{
    public static (string Year, string Month) OuNames(DateTimeOffset createdAt, TimeZoneInfo timeZone)
    {
        var localTime = TimeZoneInfo.ConvertTime(createdAt, timeZone);
        return (localTime.ToString("yyyy", CultureInfo.InvariantCulture),
            localTime.ToString("MM", CultureInfo.InvariantCulture));
    }

    public static string UserRdn(string accountName) => $"CN={EscapeDn(accountName)}";

    /// <summary>RFC 4514 DN attribute-value escape for a CN RDN.</summary>
    private static string EscapeDn(string value)
    {
        var sb = new StringBuilder(value.Length + 8);
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            var edge = i == 0 || i == value.Length - 1;
            if (c == '\0')
                sb.Append("\\00");
            else if (c is ',' or '+' or '"' or '\\' or '<' or '>' or ';' or '='
                || (edge && c == ' ')
                || (i == 0 && c == '#'))
                sb.Append('\\').Append(c);
            else
                sb.Append(c);
        }
        return sb.ToString();
    }
}
