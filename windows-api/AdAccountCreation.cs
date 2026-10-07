namespace AcmProvisioning;

internal interface IAdProvisioningAccount : IDisposable
{
    int UserAccountControl { get; }
    void SetPassword(string password);
    void Enable();
    void Delete();
}

internal static class AdAccountCreation
{
    // NORMAL_ACCOUNT | ACCOUNTDISABLE | PASSWD_NOTREQD until setup completes.
    internal const int UacCreateDisabled = 0x200 | 0x002 | 0x020;
    internal const int UacEnabled = 0x200;

    public static CreateUserResponse Create(
        string accountName,
        Func<IAdProvisioningAccount?> findAccount,
        Func<IAdProvisioningAccount> createAccount,
        Func<string> generatePassword)
    {
        using (var existing = findAccount())
        {
            if (existing is not null) return Replay(accountName, existing);
        }

        var password = generatePassword();
        IAdProvisioningAccount created;
        try
        {
            created = createAccount();
        }
        catch (Exception ex) when (AdErrors.IsEntryExists(ex))
        {
            // A concurrent request may own this account. Never modify it here.
            using var raced = findAccount();
            if (raced is not null) return Replay(accountName, raced);
            throw;
        }

        using var account = created;
        try
        {
            account.SetPassword(password);
            account.Enable();
        }
        catch (Exception setupError)
        {
            // Only roll back the object returned by this request's create.
            try
            {
                account.Delete();
            }
            catch (Exception cleanupError)
            {
                throw new ProvisioningException(
                    $"AD create failed: {AdErrors.Format(setupError)}. " +
                    $"Could not remove the account created by this attempt: {AdErrors.Format(cleanupError)}. " +
                    "An administrator must repair or remove the incomplete account before retrying.");
            }
            throw;
        }

        return new CreateUserResponse(accountName, false, password);
    }

    private static CreateUserResponse Replay(string accountName, IAdProvisioningAccount account)
    {
        if ((account.UserAccountControl & UacCreateDisabled) != UacEnabled)
            throw new ProvisioningException(
                $"AD account '{accountName}' already exists but is disabled or has incomplete password setup. " +
                "An administrator must repair or remove it before retrying.");
        return new CreateUserResponse(accountName, true, null);
    }
}
