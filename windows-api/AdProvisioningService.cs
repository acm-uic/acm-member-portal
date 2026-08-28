using System.DirectoryServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace AcmProvisioning;

public record CreateUserRequest(
    string Netid,
    string FirstName,
    string LastName,
    string DisplayName,
    string Email,
    string? Uin,
    string EventId,
    string? PreferredName = null,
    string? Department = null,
    string? Company = null,
    string? Username = null)
{
    public string AccountName =>
        string.IsNullOrWhiteSpace(Username) ? Netid : Username!.Trim();
}

public record UpdateUserRequest(
    string? Username,
    string? FirstName,
    string? LastName,
    string? DisplayName,
    string? Email,
    string? Uin,
    string? PreferredName);

public record CreateUserResponse(string SamAccountName, bool Existed, string? OneTimePassword);

public class ProvisioningException(string message) : Exception(message);

/// <summary>
/// LDAP/ADSI (System.DirectoryServices). A hosted PowerShell runspace cannot
/// load RSAT's ActiveDirectory module: SMA looks for built-in modules under
/// the publish folder, not $PSHOME. Idempotent on sAMAccountName: replay
/// returns Existed=true with no password.
/// </summary>
public sealed class AdProvisioningService
{
    // ADS_UF_NORMAL_ACCOUNT | ACCOUNTDISABLE | PASSWD_NOTREQD — password is
    // set in a second commit, so the account is created disabled first.
    private const int UacCreateDisabled = 0x200 | 0x002 | 0x020;
    private const int UacEnabled = 0x200;

    private readonly string _upnSuffix;
    private readonly string _usersOu;
    private readonly string? _domainController;

    public AdProvisioningService(IConfiguration config)
    {
        _upnSuffix = config["Provisioning:UpnSuffix"] ?? throw new InvalidOperationException("Provisioning:UpnSuffix is required");
        _usersOu = config["Provisioning:UsersOu"] ?? throw new InvalidOperationException("Provisioning:UsersOu is required");
        _domainController = config["Provisioning:DomainController"];
    }

    private bool HasExplicitDc => !string.IsNullOrWhiteSpace(_domainController);

    private string UsersLdapPath => HasExplicitDc
        ? $"LDAP://{_domainController}/{_usersOu}"
        : $"LDAP://{_usersOu}";

    public Task<bool> UserExistsAsync(string samAccountName) =>
        Task.Run(() =>
        {
            try
            {
                using var user = FindUser(samAccountName);
                return user is not null;
            }
            catch (Exception ex) when (ex is not ProvisioningException)
            {
                throw new ProvisioningException($"AD lookup failed: {AdErrors.Format(ex)}");
            }
        });

    public Task<CreateUserResponse> CreateUserAsync(CreateUserRequest req) =>
        Task.Run(() =>
        {
            var accountName = req.AccountName;
            try
            {
                using (var existing = FindUser(accountName))
                {
                    if (existing is not null)
                    {
                        return new CreateUserResponse(accountName, true, null);
                    }
                }

                var password = GeneratePassword();
                var legalName = $"{req.FirstName} {req.LastName}".Trim();

                using var ou = new DirectoryEntry(UsersLdapPath);
                using var user = ou.Children.Add($"CN={EscapeDn(legalName)}", "user");
                user.Properties["sAMAccountName"].Value = accountName;
                user.Properties["userPrincipalName"].Value = $"{accountName}@{_upnSuffix}";
                user.Properties["givenName"].Value = req.FirstName;
                user.Properties["sn"].Value = req.LastName;
                user.Properties["displayName"].Value = req.DisplayName;
                user.Properties["mail"].Value = req.Email;
                if (!string.IsNullOrWhiteSpace(req.Uin)) user.Properties["employeeID"].Value = req.Uin;
                if (!string.IsNullOrWhiteSpace(req.Department)) user.Properties["department"].Value = req.Department;
                if (!string.IsNullOrWhiteSpace(req.Company)) user.Properties["company"].Value = req.Company;
                user.Properties["userAccountControl"].Value = UacCreateDisabled;
                user.CommitChanges();

                user.Invoke("SetPassword", password);
                user.Properties["userAccountControl"].Value = UacEnabled;
                user.Properties["pwdLastSet"].Value = 0;
                user.CommitChanges();

                return new CreateUserResponse(accountName, false, password);
            }
            catch (Exception ex) when (ex is not ProvisioningException)
            {
                try
                {
                    using var raced = FindUser(accountName);
                    if (raced is not null)
                    {
                        return new CreateUserResponse(accountName, true, null);
                    }
                }
                catch
                {
                    // surface the original create failure
                }
                throw new ProvisioningException($"AD create failed: {AdErrors.Format(ex)}");
            }
        });

    public Task<CreateUserResponse> UpdateUserAsync(string currentSam, UpdateUserRequest req) =>
        Task.Run(() =>
        {
            try
            {
                using var user = FindUser(currentSam);
                if (user is null)
                {
                    throw new ProvisioningException($"AD user '{currentSam}' was not found.");
                }

                var newSam = string.IsNullOrWhiteSpace(req.Username)
                    ? currentSam
                    : req.Username!.Trim();

                if (!string.IsNullOrWhiteSpace(req.FirstName)) user.Properties["givenName"].Value = req.FirstName;
                if (!string.IsNullOrWhiteSpace(req.LastName)) user.Properties["sn"].Value = req.LastName;
                if (!string.IsNullOrWhiteSpace(req.DisplayName)) user.Properties["displayName"].Value = req.DisplayName;
                if (!string.IsNullOrWhiteSpace(req.Email)) user.Properties["mail"].Value = req.Email;
                if (!string.IsNullOrWhiteSpace(req.Uin)) user.Properties["employeeID"].Value = req.Uin;
                user.Properties["sAMAccountName"].Value = newSam;
                user.Properties["userPrincipalName"].Value = $"{newSam}@{_upnSuffix}";
                user.CommitChanges();

                return new CreateUserResponse(newSam, true, null);
            }
            catch (Exception ex) when (ex is not ProvisioningException)
            {
                throw new ProvisioningException($"AD update failed: {AdErrors.Format(ex)}");
            }
        });

    private DirectoryEntry? FindUser(string samAccountName)
    {
        using var root = new DirectoryEntry(UsersLdapPath);
        using var searcher = new DirectorySearcher(root)
        {
            Filter = $"(&(objectCategory=person)(objectClass=user)(sAMAccountName={EscapeFilter(samAccountName)}))",
            SearchScope = SearchScope.Subtree,
        };
        searcher.PropertiesToLoad.Add("distinguishedName");
        var result = searcher.FindOne();
        return result?.GetDirectoryEntry();
    }

    /// <summary>RFC 4515 LDAP filter escape.</summary>
    private static string EscapeFilter(string value)
    {
        var sb = new StringBuilder(value.Length);
        foreach (var c in value)
        {
            switch (c)
            {
                case '\\': sb.Append("\\5c"); break;
                case '*': sb.Append("\\2a"); break;
                case '(': sb.Append("\\28"); break;
                case ')': sb.Append("\\29"); break;
                case '\0': sb.Append("\\00"); break;
                default: sb.Append(c); break;
            }
        }
        return sb.ToString();
    }

    /// <summary>RFC 4514 DN attribute-value escape for a CN RDN.</summary>
    private static string EscapeDn(string value)
    {
        if (value.Length == 0) return value;
        var sb = new StringBuilder(value.Length + 8);
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            var edge = i == 0 || i == value.Length - 1;
            if (c is ',' or '+' or '"' or '\\' or '<' or '>' or ';' or '='
                || (edge && c == ' ')
                || (i == 0 && c == '#'))
            {
                sb.Append('\\').Append(c);
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.ToString();
    }

    /// <summary>20 chars, 4 complexity classes (AD default policy safe), no ambiguous glyphs.</summary>
    private static string GeneratePassword()
    {
        const string upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
        const string lower = "abcdefghjkmnpqrstuvwxyz";
        const string digits = "23456789";
        const string symbols = "!@#$%&*?";
        const string all = upper + lower + digits + symbols;

        var chars = new List<char>
        {
            Pick(upper), Pick(lower), Pick(digits), Pick(symbols),
        };
        for (var i = 0; i < 16; i++) chars.Add(Pick(all));
        var array = chars.ToArray();
        RandomNumberGenerator.Shuffle<char>(array);
        return new string(array);

        static char Pick(string pool) => pool[RandomNumberGenerator.GetInt32(pool.Length)];
    }
}

internal static class AdErrors
{
    public static string Format(Exception ex)
    {
        var parts = new List<string>();
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e is COMException com && com.ErrorCode != 0 && !string.IsNullOrWhiteSpace(com.Message))
            {
                var code = $"0x{unchecked((uint)com.ErrorCode):X8}";
                if (parts.Count == 0 || parts[^1] != com.Message)
                {
                    parts.Add($"{com.Message} ({code})");
                }
                continue;
            }
            if (!string.IsNullOrWhiteSpace(e.Message) && (parts.Count == 0 || parts[^1] != e.Message))
            {
                parts.Add(e.Message);
            }
        }
        return parts.Count == 0 ? ex.GetType().Name : string.Join(" | ", parts);
    }
}
