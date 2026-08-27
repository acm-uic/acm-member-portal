using System.Management.Automation;
using System.Management.Automation.Runspaces;
using System.Security;
using System.Security.Cryptography;

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
/// Wraps the ActiveDirectory PowerShell module. Every invocation is
/// parameter-based (no string interpolation into script text), so netids
/// cannot inject PowerShell. Idempotent on sAMAccountName: replay returns
/// Existed=true with no password (research decision).
/// </summary>
public sealed class AdProvisioningService
{
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

    private static PowerShell CreateShell(out Runspace runspace)
    {
        var iss = InitialSessionState.CreateDefault();
        iss.ImportPSModule(new[] { "ActiveDirectory" });
        runspace = RunspaceFactory.CreateRunspace(iss);
        runspace.Open();
        var ps = PowerShell.Create();
        ps.Runspace = runspace;
        return ps;
    }

    public async Task<bool> UserExistsAsync(string samAccountName)
    {
        using var ps = CreateShell(out var runspace);
        using (runspace)
        {
            ps.AddCommand("Get-ADUser")
              .AddParameter("Filter", $"sAMAccountName -eq '{samAccountName.Replace("'", "''")}'")
              .AddParameter("Properties", "sAMAccountName");
            if (HasExplicitDc) ps.AddParameter("Server", _domainController);

            var results = await ps.InvokeAsync();
            return results.Count > 0;
        }
    }

    public async Task<CreateUserResponse> CreateUserAsync(CreateUserRequest req)
    {
        var accountName = req.AccountName;
        if (await UserExistsAsync(accountName))
        {
            return new CreateUserResponse(accountName, true, null);
        }

        var password = GeneratePassword();

        using var ps = CreateShell(out var runspace);
        using (runspace)
        {
            // Name/CN: "First Last" (matches manual New-ADUser)
            // DisplayName: preferred name when set, else "First Last"
            // GivenName/Surname: legal first/last
            // sAMAccountName / UserPrincipalName: signup Username
            // EmployeeID: UIN; Department: major; Company: college
            var legalName = $"{req.FirstName} {req.LastName}".Trim();
            ps.AddCommand("New-ADUser")
              .AddParameter("Name", legalName)
              .AddParameter("DisplayName", req.DisplayName)
              .AddParameter("GivenName", req.FirstName)
              .AddParameter("Surname", req.LastName)
              .AddParameter("SamAccountName", accountName)
              .AddParameter("UserPrincipalName", $"{accountName}@{_upnSuffix}")
              .AddParameter("EmailAddress", req.Email)
              .AddParameter("AccountPassword", ToSecureString(password))
              .AddParameter("Enabled", true)
              .AddParameter("ChangePasswordAtLogon", true)
              .AddParameter("Path", _usersOu);
            if (!string.IsNullOrWhiteSpace(req.Uin)) ps.AddParameter("EmployeeID", req.Uin);
            if (!string.IsNullOrWhiteSpace(req.Department)) ps.AddParameter("Department", req.Department);
            if (!string.IsNullOrWhiteSpace(req.Company)) ps.AddParameter("Company", req.Company);
            if (HasExplicitDc) ps.AddParameter("Server", _domainController);

            await ps.InvokeAsync();

            if (ps.HadErrors)
            {
                var errors = string.Join("; ", ps.Streams.Error.Select(e => e.ToString()));
                // A create that lost the race (or a replay after a crash between
                // create and response) is still idempotent success.
                if (await UserExistsAsync(accountName))
                {
                    return new CreateUserResponse(accountName, true, null);
                }
                throw new ProvisioningException($"New-ADUser failed: {errors}");
            }

            return new CreateUserResponse(accountName, false, password);
        }
    }

    public async Task<CreateUserResponse> UpdateUserAsync(string currentSam, UpdateUserRequest req)
    {
        if (!await UserExistsAsync(currentSam))
        {
            throw new ProvisioningException($"AD user '{currentSam}' was not found.");
        }

        var newSam = string.IsNullOrWhiteSpace(req.Username)
            ? currentSam
            : req.Username!.Trim();

        using var ps = CreateShell(out var runspace);
        using (runspace)
        {
            ps.AddCommand("Set-ADUser")
              .AddParameter("Identity", currentSam);
            if (!string.IsNullOrWhiteSpace(req.FirstName)) ps.AddParameter("GivenName", req.FirstName);
            if (!string.IsNullOrWhiteSpace(req.LastName)) ps.AddParameter("Surname", req.LastName);
            if (!string.IsNullOrWhiteSpace(req.DisplayName)) ps.AddParameter("DisplayName", req.DisplayName);
            if (!string.IsNullOrWhiteSpace(req.Email)) ps.AddParameter("EmailAddress", req.Email);
            if (!string.IsNullOrWhiteSpace(req.Uin)) ps.AddParameter("EmployeeID", req.Uin);
            if (!string.Equals(newSam, currentSam, StringComparison.OrdinalIgnoreCase))
            {
                ps.AddParameter("SamAccountName", newSam);
                ps.AddParameter("UserPrincipalName", $"{newSam}@{_upnSuffix}");
            }
            else
            {
                ps.AddParameter("UserPrincipalName", $"{currentSam}@{_upnSuffix}");
            }
            if (HasExplicitDc) ps.AddParameter("Server", _domainController);

            await ps.InvokeAsync();

            if (ps.HadErrors)
            {
                var errors = string.Join("; ", ps.Streams.Error.Select(e => e.ToString()));
                throw new ProvisioningException($"Set-ADUser failed: {errors}");
            }

            return new CreateUserResponse(newSam, true, null);
        }
    }

    private static SecureString ToSecureString(string value)
    {
        var secure = new SecureString();
        foreach (var c in value) secure.AppendChar(c);
        return secure;
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
        RandomNumberGenerator.Shuffle(array);
        return new string(array);

        static char Pick(string pool) => pool[RandomNumberGenerator.GetInt32(pool.Length)];
    }
}
