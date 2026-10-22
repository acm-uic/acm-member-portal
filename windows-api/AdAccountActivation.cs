namespace AcmProvisioning;

internal interface IAdActivationAccount
{
    int UserAccountControl { get; }
    bool IsOwnedBy(string eventId);
    bool RequiresPasswordChange { get; }
    void ChangePassword(string currentPassword, string newPassword);
}

internal static class AdAccountActivation
{
    internal static bool Activate(IAdActivationAccount? account, ActivateAccountRequest request)
    {
        // Activation is only for an enabled account created by this exact event
        // that still requires its initial password change. Existing members use
        // the separate authenticated password-change flow.
        if (account is null || string.IsNullOrWhiteSpace(request.EventId)
            || (account.UserAccountControl & AdAccountCreation.UacCreateDisabled) != AdAccountCreation.UacEnabled
            || !account.IsOwnedBy(request.EventId) || !account.RequiresPasswordChange)
            return false;
        account.ChangePassword(request.CurrentPassword, request.NewPassword);
        return true;
    }
}
