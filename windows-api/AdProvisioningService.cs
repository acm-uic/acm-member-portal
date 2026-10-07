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
    string? Username = null,
    bool RetryCredentialDelivery = false)
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
public record ChangePasswordRequest(string CurrentPassword, string NewPassword);

public class PasswordChangeException(string message) : Exception(message);

public class ProvisioningException(string message) : Exception(message);

/// <summary>
/// LDAP/ADSI (System.DirectoryServices). A hosted PowerShell runspace cannot
/// load RSAT's ActiveDirectory module: SMA looks for built-in modules under
/// the publish folder, not $PSHOME. Ordinary replays use sAMAccountName and
/// return Existed=true with no password. The owning event can request fresh
/// initial credentials while the account still requires its first password change.
/// </summary>
public sealed class AdProvisioningService
{
    private readonly string _upnSuffix;
    private readonly string _usersOu;
    private readonly string? _domainController;
    private readonly TimeZoneInfo _timeZone;

    public AdProvisioningService(IConfiguration config)
    {
        _upnSuffix = config["Provisioning:UpnSuffix"] ?? throw new InvalidOperationException("Provisioning:UpnSuffix is required");
        _usersOu = config["Provisioning:UsersOu"] ?? throw new InvalidOperationException("Provisioning:UsersOu is required");
        _domainController = config["Provisioning:DomainController"];
        _timeZone = TimeZoneInfo.FindSystemTimeZoneById(config["Provisioning:TimeZone"] ?? "America/Chicago");
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

    public Task<CreateUserResponse> CreateUserAsync(
        CreateUserRequest req, CancellationToken cancellationToken = default) =>
        AdAccountCreationGate.RunAsync(req.AccountName, () =>
        {
            var accountName = req.AccountName;
            try
            {
                return AdAccountCreation.Create(accountName,
                    () =>
                    {
                        var existing = FindUser(accountName);
                        return existing is null ? null : new DirectoryAccount(existing);
                    },
                    () =>
                    {
                        using var ou = EnsureMonthlyUsersOu(DateTimeOffset.UtcNow);
                        return new DirectoryAccount(CreateDirectoryUser(ou, req, accountName,
                            AdUserPlacement.UserRdn(accountName)));
                    },
                    GeneratePassword, req.EventId, req.RetryCredentialDelivery);
            }
            catch (Exception ex) when (ex is not ProvisioningException)
            {
                throw new ProvisioningException($"AD create failed: {AdErrors.Format(ex)}");
            }
        }, cancellationToken);

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

    public Task<bool> ChangePasswordAsync(
        string samAccountName, ChangePasswordRequest req, CancellationToken cancellationToken = default) =>
        AdAccountCreationGate.RunAsync(samAccountName, () =>
        {
            using var user = FindUser(samAccountName);
            if (user is null) return false;
            try
            {
                // ChangePassword verifies the old password and enforces AD policy.
                // Do not replace this with SetPassword, which is an administrative reset.
                // No separate login bind: temporary/expired passwords can still be changed.
                user.Invoke("ChangePassword", req.CurrentPassword, req.NewPassword);
                return true;
            }
            catch (Exception ex) when (AdErrors.IsPasswordRejection(ex))
            {
                throw new PasswordChangeException(AdErrors.PasswordChangeMessage(ex, req.CurrentPassword, req.NewPassword));
            }
        }, cancellationToken);

    private DirectoryEntry EnsureMonthlyUsersOu(DateTimeOffset createdAt)
    {
        var (year, month) = AdUserPlacement.OuNames(createdAt, _timeZone);
        using var root = new DirectoryEntry(UsersLdapPath);
        using var yearOu = EnsureChildOu(root, year);
        return EnsureChildOu(yearOu, month);
    }

    private DirectoryEntry CreateDirectoryUser(
        DirectoryEntry ou, CreateUserRequest req, string accountName, string rdn)
    {
        var user = ou.Children.Add(rdn, "user");
        try
        {
            user.Properties["sAMAccountName"].Value = accountName;
            user.Properties["userPrincipalName"].Value = $"{accountName}@{_upnSuffix}";
            user.Properties["givenName"].Value = req.FirstName;
            user.Properties["sn"].Value = req.LastName;
            user.Properties["displayName"].Value = req.DisplayName;
            user.Properties["mail"].Value = req.Email;
            user.Properties["description"].Value = AdAccountCreation.EventMarker(req.EventId);
            if (!string.IsNullOrWhiteSpace(req.Uin)) user.Properties["employeeID"].Value = req.Uin;
            if (!string.IsNullOrWhiteSpace(req.Department)) user.Properties["department"].Value = req.Department;
            if (!string.IsNullOrWhiteSpace(req.Company)) user.Properties["company"].Value = req.Company;
            user.Properties["userAccountControl"].Value = AdAccountCreation.UacCreateDisabled;
            user.CommitChanges();
            return user;
        }
        catch
        {
            user.Dispose();
            throw;
        }
    }

    private sealed class DirectoryAccount(DirectoryEntry user) : IAdProvisioningAccount
    {
        public int UserAccountControl => Convert.ToInt32(user.Properties["userAccountControl"].Value);

        public bool IsOwnedBy(string eventId) =>
            user.Properties["description"].Contains(AdAccountCreation.EventMarker(eventId));

        public bool RequiresPasswordChange
        {
            get
            {
                // Let LDAP compare the LargeInteger rather than relying on COM marshalling.
                using var searcher = new DirectorySearcher(user)
                {
                    SearchScope = SearchScope.Base,
                    Filter = "(&(objectClass=user)(pwdLastSet=0))",
                };
                return searcher.FindOne() is not null;
            }
        }

        public void SetPassword(string password) => user.Invoke("SetPassword", password);

        public void Enable()
        {
            user.Properties["userAccountControl"].Value = AdAccountCreation.UacEnabled;
            user.Properties["pwdLastSet"].Value = 0;
            user.CommitChanges();
        }

        public void Delete() => user.DeleteTree();
        public void Dispose() => user.Dispose();
    }

    private static DirectoryEntry EnsureChildOu(DirectoryEntry parent, string name)
    {
        var existing = FindChildOu(parent, name);
        if (existing is not null) return existing;

        var created = parent.Children.Add($"OU={name}", "organizationalUnit");
        try
        {
            created.CommitChanges();
            return created;
        }
        catch (Exception ex)
        {
            created.Dispose();
            // Another request may have created the same OU since our lookup.
            // Do not hide permission, connectivity, or other directory failures.
            if (AdErrors.IsEntryExists(ex))
            {
                var raced = FindChildOu(parent, name);
                if (raced is not null) return raced;
            }
            throw;
        }
    }

    private static DirectoryEntry? FindChildOu(DirectoryEntry parent, string name)
    {
        using var searcher = new DirectorySearcher(parent)
        {
            Filter = $"(&(objectClass=organizationalUnit)(ou={EscapeFilter(name)}))",
            SearchScope = SearchScope.OneLevel,
        };
        return searcher.FindOne()?.GetDirectoryEntry();
    }

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
    public static bool IsEntryExists(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
        {
            // ERROR_OBJECT_ALREADY_EXISTS and ERROR_DS_OBJ_STRING_NAME_EXISTS.
            if (unchecked((uint)e.HResult) is 0x80071392 or 0x80072071)
                return true;
        }
        return false;
    }

    public static bool IsPasswordRejection(Exception ex)
    {
        // ADSI wraps COM errors in invocation exceptions. Only known credential
        // and password-policy rejections should become user-visible HTTP 400s.
        for (var e = ex; e != null; e = e.InnerException)
        {
            var code = unchecked((uint)e.HResult);
            if (code is 0x80070056 or 0x8007052B or 0x8007052E
                or 0x800708C5 or 0x8007052D or 0x8007202F)
                return true;
        }
        return false;
    }

    public static string PasswordChangeMessage(Exception ex, string currentPassword, string newPassword)
    {
        var hint = "Active Directory rejected the password change.";
        for (var e = ex; e != null; e = e.InnerException)
        {
            var code = unchecked((uint)e.HResult);
            if (code == 0x80070056 || code == 0x8007052B || code == 0x8007052E)
                hint = "Your current password is incorrect.";
            else if (code == 0x800708C5 || code == 0x8007052D || code == 0x8007202F)
                hint = "Active Directory rejected the new password. Its policy may require a longer or more complex password, prevent password reuse, or require waiting before changing it again.";
        }
        // AD may only report a general policy rejection. Preserve every detail it
        // supplies rather than inventing a minimum length or password history count.
        var message = $"{hint} AD details: {Format(ex)}";
        var passwords = new[] { currentPassword, newPassword }
            .Where(password => !string.IsNullOrEmpty(password))
            .OrderByDescending(password => password.Length)
            .Select(System.Text.RegularExpressions.Regex.Escape)
            .ToArray();
        if (passwords.Length > 0)
        {
            message = System.Text.RegularExpressions.Regex.Replace(
                message, string.Join("|", passwords), "[redacted]");
        }
        return message;
    }

    public static string Format(Exception ex)
    {
        var parts = new List<string>();
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e is DirectoryServicesCOMException directory && !string.IsNullOrWhiteSpace(directory.ExtendedErrorMessage))
            {
                parts.Add(directory.ExtendedErrorMessage);
            }
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
