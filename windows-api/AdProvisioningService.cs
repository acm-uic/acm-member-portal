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
        // CreateDefault() loads snap-ins (Diagnostics, WSMan, …) from
        // runtimes/win/lib/netX.0/, which a framework-dependent publish does
        // not copy. CreateDefault2() is the core engine only (Import-Module).
        var iss = InitialSessionState.CreateDefault2();
        iss.ExecutionPolicy = Microsoft.PowerShell.ExecutionPolicy.Bypass;
        iss.ThrowOnRunspaceOpenError = true;

        // Windows services often have a stripped PSModulePath; RSAT lives here.
        var systemModules = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "Modules");
        var modulePath = Environment.GetEnvironmentVariable("PSModulePath") ?? "";
        if (modulePath.IndexOf(systemModules, StringComparison.OrdinalIgnoreCase) < 0)
        {
            modulePath = string.IsNullOrEmpty(modulePath)
                ? systemModules
                : modulePath + Path.PathSeparator + systemModules;
        }
        iss.EnvironmentVariables.Add(new SessionStateVariableEntry("PSModulePath", modulePath, ""));

        runspace = RunspaceFactory.CreateRunspace(iss);
        try
        {
            runspace.Open();
        }
        catch (Exception ex)
        {
            runspace.Dispose();
            throw new ProvisioningException($"Failed to open PowerShell runspace: {AdErrors.Format(ex)}");
        }

        var ps = PowerShell.Create();
        ps.Runspace = runspace;
        try
        {
            ImportActiveDirectory(ps);
        }
        catch
        {
            ps.Dispose();
            runspace.Dispose();
            throw;
        }
        return ps;
    }

    private static void ImportActiveDirectory(PowerShell ps)
    {
        string? last = null;
        if (TryImportActiveDirectory(ps, winPsRemoting: false, out last)) return;
        if (TryImportActiveDirectory(ps, winPsRemoting: true, out last)) return;
        throw new ProvisioningException(
            "Could not load the ActiveDirectory PowerShell module. " +
            "Install RSAT-AD-PowerShell (Install-WindowsFeature RSAT-AD-PowerShell). " +
            (last ?? ""));
    }

    private static bool TryImportActiveDirectory(PowerShell ps, bool winPsRemoting, out string? error)
    {
        ps.Commands.Clear();
        ps.Streams.Error.Clear();
        ps.AddCommand("Import-Module")
          .AddParameter("Name", "ActiveDirectory")
          .AddParameter("ErrorAction", ActionPreference.Stop);
        if (winPsRemoting) ps.AddParameter("UseWindowsPowerShell", true);
        else ps.AddParameter("SkipEditionCheck", true);

        try
        {
            ps.Invoke();
            error = ps.HadErrors ? FormatPsErrors(ps) : null;
            var ok = !ps.HadErrors;
            ps.Commands.Clear();
            ps.Streams.Error.Clear();
            return ok;
        }
        catch (Exception ex)
        {
            error = AdErrors.Format(ex);
            ps.Commands.Clear();
            ps.Streams.Error.Clear();
            return false;
        }
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

            var results = await InvokeCommandAsync(ps, "Get-ADUser");
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

            try
            {
                await ps.InvokeAsync();
            }
            catch (Exception ex)
            {
                if (await UserExistsAsync(accountName))
                {
                    return new CreateUserResponse(accountName, true, null);
                }
                throw new ProvisioningException($"New-ADUser failed: {AdErrors.Format(ex)}{ErrorSuffix(ps)}");
            }

            if (ps.HadErrors)
            {
                // A create that lost the race (or a replay after a crash between
                // create and response) is still idempotent success.
                if (await UserExistsAsync(accountName))
                {
                    return new CreateUserResponse(accountName, true, null);
                }
                throw new ProvisioningException($"New-ADUser failed:{ErrorSuffix(ps)}");
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

            await InvokeCommandAsync(ps, "Set-ADUser");

            return new CreateUserResponse(newSam, true, null);
        }
    }

    private static async Task<PSDataCollection<PSObject>> InvokeCommandAsync(PowerShell ps, string command)
    {
        try
        {
            var results = await ps.InvokeAsync();
            if (ps.HadErrors)
            {
                throw new ProvisioningException($"{command} failed: {FormatPsErrors(ps)}");
            }
            return results;
        }
        catch (ProvisioningException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new ProvisioningException($"{command} failed: {AdErrors.Format(ex)}{ErrorSuffix(ps)}");
        }
    }

    private static string ErrorSuffix(PowerShell ps) =>
        ps.HadErrors ? " " + FormatPsErrors(ps) : "";

    private static string FormatPsErrors(PowerShell ps) =>
        string.Join("; ", ps.Streams.Error.Select(e => e.Exception?.Message ?? e.ToString()));

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
            if (!string.IsNullOrWhiteSpace(e.Message) && (parts.Count == 0 || parts[^1] != e.Message))
            {
                parts.Add(e.Message);
            }
        }
        return parts.Count == 0 ? ex.GetType().Name : string.Join(" | ", parts);
    }
}
