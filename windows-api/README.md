# ACM Provisioning API

Minimal ASP.NET API that creates and updates on-prem Active Directory accounts
for ACM@UIC members. The member portal is its only caller: the outbox worker
POSTs new accounts, profile saves PATCH existing ones, and members can change
their ACM passwords from their profile.

## Endpoints

| Method | Path                    | Auth   | Purpose                                               |
| ------ | ----------------------- | ------ | ----------------------------------------------------- |
| GET    | `/healthz`              | none   | liveness                                              |
| POST   | `/users`                | Bearer | create AD user (idempotent on sAMAccountName)         |
| PATCH  | `/users/{sam}`          | Bearer | update AD user; `{sam}` is the current sAMAccountName |
| GET    | `/users/{sam}`          | Bearer | existence check                                       |
| POST   | `/users/{sam}/password` | Bearer | change password, verifying the current password       |
| POST   | `/users/{sam}/activate` | Bearer | initial password change for the owning signup event   |

JSON is camelCase. Required create fields: `username` (or `netid`), `firstName`,
`lastName`, `displayName`, `email`, `eventId`. Missing any of those is `400`.

### Initial account activation

Deploy this Windows API **before** deploying the portal activation page. The
portal needs migration `0015_account_activation.sql` and its configured
`WINDOWS_API_URL` / `WINDOWS_API_TOKEN`; an older Windows API does not support
activation. Keep the Windows API private to the portal and worker. End users
submit credentials only to the same-origin portal `/api/activate/` endpoint.

`POST /users/{sam}/activate` accepts `{ eventId, currentPassword, newPassword }`.
It requires an enabled, fully provisioned AD account, the exact matching
`ACM provisioning event: <eventId>` description marker, and `pwdLastSet = 0`.
Under the existing per-account gate it calls ADSI `ChangePassword`, which
verifies the temporary password and enforces AD policy. It never calls
administrative `SetPassword`. Accounts already activated or created by another
event cannot be changed through this operation. The regular signed-in
password-change endpoint retains its current behavior.

Only a confirmed change returns `{ ok: true }`. Ineligible accounts and AD
credential/policy rejections receive the same generic HTTP 400; unexpected
directory failures return 502 with an uncertain outcome. Passwords and directory
exception details are not logged or returned. Neither portal nor API retries an
uncertain password change. After uncertainty, allow synchronization and try the
new password at Microsoft sign-in; ask support to investigate rather than
reissuing initial credentials.

The portal independently verifies approved signup, completed provisioning and
delivered credentials, then records only a successful activation timestamp.
It applies database-backed username and connection-address budgets before AD
calls, so portal replicas share limits. Those records contain hashed limiter
keys and counts, never passwords. The API additionally shares its per-account
password-change rate limiter with activation.

No activation response proves Entra synchronization or successful Microsoft
sign-in. The applicant must allow synchronization after changing the initial
password. Real AD behavior must be verified on a Windows deployment; the
automated tests use fake AD accounts and mocked HTTP transport.

`POST /users` body:

```json
{
  "netid": "amorga42",
  "username": "amorga",
  "firstName": "Alex",
  "lastName": "Morgan",
  "preferredName": "Alex",
  "displayName": "Alex",
  "email": "alex@example.com",
  "uin": "678901234",
  "department": "Computer Science",
  "company": "Engineering",
  "eventId": "<uuid>"
}
```

`username` is the ACM account name. It becomes `sAMAccountName` and the local
part of `UserPrincipalName`. If it is omitted, `netid` is used instead. The API
records `ACM provisioning event: <eventId>` in the new account's `description`
to identify which signup event owns its initial credentials.

AD mapping on create: `Name`/`CN`←username (or netid), `GivenName`←firstName,
`Surname`←lastName, `DisplayName`←displayName (portal sends preferred name or
`"First Last"`), `EmployeeID`←uin, `Department`←major, `Company`←college,
`EmailAddress`←email.

New accounts go in a month OU nested inside a year OU under `Provisioning:UsersOu`,
for example `CN=amorga,OU=10,OU=2026,OU=ACMUsers,DC=acmuic,DC=org`.
The API uses the actual
account creation month in `Provisioning:TimeZone`, which defaults to
`America/Chicago`. It creates missing year and month OUs and reuses existing ones,
including when concurrent requests create the first accounts of the year or month.
The base OU must already exist.

Username-based CNs allow people with identical legal names in the same month.
Their legal and display name attributes retain the mapping above. Existing
accounts keep their current location and CN. Lookups, updates, password changes,
and create replays search the entire base OU subtree, including older accounts
directly under the base OU. A replay does not move an existing account into the
current month's OU. Username changes update the login attributes and retain the
original CN.

Response: `{ samAccountName, existed, oneTimePassword? }`. A new account returns
a temporary password, which is never logged or stored in production. Ordinary
replays against an enabled existing account return `{ existed: true }` without
a password. The worker passes `retryCredentialDelivery: true` until it has
recorded successful credential delivery. With that flag, a replay may issue a
fresh temporary password only when the account's description contains the same
event marker and `pwdLastSet` is still zero. It preserves the requirement to
change the password at first sign-in. Accounts owned by a different event,
unmarked existing accounts, and accounts whose password has already been changed
are never reset by credential retries.

Create, credential-reissue, and password-change requests for one account are
serialized within the Windows API process, including username spellings that
differ only by case. A completed user password change is checked before a queued
credential reissue, which then preserves the user's new password. This gate covers
password changes through this API; external AD clients do not share it.
Disconnected requests waiting to run are cancelled. A directory operation that
has already started retains its gate until it finishes, so a timed-out request
cannot overwrite credentials issued by a later retry.

The portal persists delivery progress without the password. Email failures stay
in the signup queue until delivery succeeds, and a saved delivery receipt lets a
restarted worker complete the event without resetting the password or sending
mail again. If an event awaiting delivery receives no temporary password, it
remains failed and requires an administrator to verify delivery. Deploy this
Windows API version before the worker to enable automatic credential reissue.
The migration treats older interrupted or failed events as awaiting delivery.
Their AD accounts may lack the event marker, so credential recovery can require
administrator verification rather than an automatic reset.

Disabled accounts or accounts with incomplete password setup return an error,
so the signup remains in the queue. If password setup or enablement fails for an account
created by the current request, the API deletes that new account and reports the
original failure. If deletion also fails, both errors are returned and an
administrator must repair or remove the incomplete account before retrying.
Accounts found during an initial lookup or concurrent create are never deleted
by a replay.

`PATCH /users/{sam}` body (all fields optional): `{ username, firstName,
lastName, preferredName, displayName, email, uin }`. Written to AD when set:
`GivenName`, `Surname`, `DisplayName`, `EmailAddress`, `EmployeeID`. A new
`username` renames `sAMAccountName` and `UserPrincipalName`. `preferredName` is
accepted and ignored; send `displayName` for the visible name. Unknown `{sam}`
is `404 { samAccountName, existed: false }`. Success is
`{ samAccountName, existed: true }` (no password).

`GET /users/{sam}` is `200 { samAccountName, existed: true }` or
`404 { samAccountName, existed: false }`.

`POST /users/{sam}/password` body: `{ currentPassword, newPassword }`.
Success is `200 { ok: true }`. Missing passwords, an unchanged password, or an
AD rejection return `400 { error }`. An unknown account returns `404`, directory
lookup failures return `502`, and more than five attempts per account per minute
return `429`. The limit is enforced by each Windows API instance.

This uses ADSI `ChangePassword`, which verifies the old password and applies AD's
effective policy, including fine-grained policies. It does not use an
administrative `SetPassword` reset. AD's error message, HRESULT, and extended
LDAP error details are returned to the member, with plain-language guidance for
incorrect passwords and policy rejections. AD may report a general policy
failure without identifying the exact length, complexity, history, or minimum
age rule. The portal does not invent specific requirements. Passwords are not
logged, stored, queued, or echoed in responses. An expired or temporary password
is passed directly to `ChangePassword`, without a separate login bind.

Password changes accept HTTP and HTTPS `WINDOWS_API_URL` values, including in
production. For the default Windows API listener, use
`http://<windows-host>:2433` on a trusted private network. HTTP sends passwords and
the bearer token without transport encryption. For HTTPS, use a certificate
trusted by the portal and configure TLS on Kestrel or on a reverse proxy on the
Windows host. Do not enable request body logging on either service or the proxy.
The AD account must allow password changes and the service identity needs
the Change Password extended right on managed users. Existing Reset Password
delegation alone is not sufficient. AD's normal Everyone/SELF Change Password
ACEs commonly supply this right; verify the effective ACL in your environment.

Before rollout, verify on a test AD account: an incorrect current password leaves
the password unchanged; a policy-rejected password displays AD's error; a valid
change permits sign-in with the new password and rejects the old one; an initial
temporary password can be changed; and repeated attempts return `429`.

## Automatic Entra Connect synchronization

The API can request synchronization on the **same Windows host as the active
Entra Connect installation**. This integration is disabled by default; it does
not install Connect, change the scheduler, synchronize temporary passwords, or
prove Microsoft sign-in readiness.

After a successful `POST /users` (including an idempotent replay), it queues
`Start-ADSyncSyncCycle -PolicyType Delta -InteractiveMode:$false`. After a
successful `POST /users/{sam}/activate` or `POST /users/{sam}/password`, it queues
`Invoke-ADSyncCSObjectPasswordHashSync` for the account's AD distinguished name.
Rejections and missing accounts do not queue password synchronization.
Provisioning does not queue a temporary password hash: `pwdLastSet = 0` remains
in effect until activation, with the existing tenant settings.

The queue stores only a job kind, account DN for password jobs, attempt metadata,
and IDs. It never receives passwords or bearer tokens. It persists atomic JSON
snapshots with a single-process file lease, combines directory requests and
pending password requests for the same DN, and retries failures with a 15-second
to 5-minute backoff. Requests added while a sync runs are retained. A busy,
disabled, suspended, or staging directory scheduler is not overridden. Password
sync is independent of the object scheduler's enabled/busy state, but is also
blocked on a suspended or staging server. A new account not yet present in the
connector space may require a later attempt after directory synchronization.

PowerShell runs in a separate, hidden Windows PowerShell 5.1 process using the
service identity. It executes a fixed published script, accepts JSON data on
stdin, and passes the DN as a literal cmdlet parameter. No command strings are
built from account data. No hosted PowerShell SDK or remoting is used. Each
invocation has a configurable timeout; PowerShell output is discarded and only
fixed progress/failure messages are logged.

### Enable on the Connect host

1. Publish/deploy the API, including the `EntraSync` subdirectory. Ensure the
   host's execution policy permits these administrator-reviewed scripts (sign
   them if required). The runner does not bypass execution policy.
2. Create `C:\ProgramData\ACM\EntraSync\settings.json` from
   `EntraSync\settings.example.json`. Set `ConnectorName` to `acmuic.org` and
   `UsersOu` to `OU=ACMUsers,DC=acmuic,DC=org` for this installation. Password DNs
   outside that managed OU are rejected. Only administrators should be able to
   write the settings and scripts; the service identity needs read/execute access.
3. Pre-create `C:\ProgramData\ACM\EntraSyncQueue` and grant the API service
   identity Modify access, with access otherwise restricted to Administrators
   and SYSTEM. Keep the directory outside `C:\srv\acm-provisioning`, because
   deployment replaces that installation directory. Do not share one queue
   directory between service instances or delete pending jobs during deployment.
4. Grant the **actual API service identity** access to the local Connect groups.
   For this installation, the `AcmProvisioning` service runs as
   `ACMUIC\acmmemberportal`. In an elevated administrator PowerShell on the
   Connect server, run:

   ```powershell
   Get-CimInstance Win32_Service -Filter "Name='AcmProvisioning'" |
       Select-Object Name, StartName
   Add-LocalGroupMember -Group ADSyncOperators -Member 'ACMUIC\acmmemberportal'
   Add-LocalGroupMember -Group ADSyncBrowse -Member 'ACMUIC\acmmemberportal'
   Restart-Service AcmProvisioning
   ```

   Substitute the service's real identity if it differs. Restart after group
   changes so the service and its PowerShell children receive a fresh access
   token. `ADSyncOperators` allows running synchronization operations;
   `ADSyncBrowse` supplies the accompanying browse access. Start with these
   groups rather than granting broad `ADSyncAdmins` management access. Existing
   AD OU permissions alone do not grant Connect engine access. Do not add
   `ADSyncPasswordSet` solely because password hash synchronization is used;
   its permission to run `Invoke-ADSyncCSObjectPasswordHashSync` has not been
   established for this deployment.

   Verify `Import-Module ADSync`, `Get-ADSyncScheduler`, and both sync commands
   under the service identity, not just your administrator shell. A successful
   scheduler read does not establish permission to invoke either sync command.
   Verify `Directory` and `UserHash` request-accepted messages separately. A
   successful Microsoft sign-in or Connect Event 657 with `Result: Success`
   confirms synchronization occurred, but does not distinguish an API-triggered
   request from the normal schedule.
   Domain Admin or LocalSystem is not required by this application. No new Graph
   credentials, SSPR, or password writeback are used.
5. Set the service environment/configuration and restart it:

   ```text
   EntraSync__Enabled=true
   EntraSync__QueueDirectory=C:\ProgramData\ACM\EntraSyncQueue
   EntraSync__TimeoutSeconds=120
   ```

   A relative/unwritable queue path, corrupt queue, or concurrent owner prevents
   enabled startup. The timeout must be between 10 and 600 seconds. Missing
   scripts, denied PowerShell execution, ADSync failures, and insufficient
   permissions cause fixed warning messages and persistent retries.

### Create host directories and settings

Run this first-time setup in an **elevated administrator Windows PowerShell** on
the active Connect server before enabling the worker. Substitute the actual
service identity if it differs. The settings directory gives the service
Read & execute; the separate queue directory gives it Modify. Administrators and
SYSTEM retain Full Control. Review existing explicit ACL entries when reusing
directories: `icacls /grant:r` replaces grants for the named identities, not
unrelated explicit grants.

```powershell
$ErrorActionPreference = 'Stop'
$syncServiceIdentity = 'ACMUIC\acmmemberportal'
$syncSettingsDir = 'C:\ProgramData\ACM\EntraSync'
$syncQueueDir = 'C:\ProgramData\ACM\EntraSyncQueue'
$syncSettingsPath = Join-Path $syncSettingsDir 'settings.json'

New-Item -ItemType Directory -Path $syncSettingsDir -Force | Out-Null
New-Item -ItemType Directory -Path $syncQueueDir -Force | Out-Null

# Well-known SIDs avoid localized Administrators/SYSTEM names.
icacls $syncSettingsDir /inheritance:r /grant:r `
    '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' `
    "${syncServiceIdentity}:(OI)(CI)RX"
if ($LASTEXITCODE -ne 0) { throw 'Failed to configure settings directory ACL.' }

icacls $syncQueueDir /inheritance:r /grant:r `
    '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' `
    "${syncServiceIdentity}:(OI)(CI)M"
if ($LASTEXITCODE -ne 0) { throw 'Failed to configure queue directory ACL.' }

# Preserve host-specific settings on subsequent runs.
if (-not (Test-Path -LiteralPath $syncSettingsPath)) {
    @{
        ConnectorName = 'acmuic.org'
        UsersOu = 'OU=ACMUsers,DC=acmuic,DC=org'
    } | ConvertTo-Json | Set-Content -LiteralPath $syncSettingsPath -Encoding UTF8
}

Get-Content -LiteralPath $syncSettingsPath -Raw | ConvertFrom-Json |
    Select-Object ConnectorName, UsersOu
icacls $syncSettingsPath
icacls $syncQueueDir
```

`settings.json` is required for **both** directory and password requests; it is
not created by deployment or by setting `EntraSync__Enabled=true`. The connector
name must match the AD connector in Connect, and `UsersOu` must be the managed
base OU, including its descendant year/month OUs. Both directories are outside
the replaced installation directory. Keep their contents and ACLs during
deployment; never empty a live queue to fix setup.

The worker reads `settings.json` on every attempt. Correcting this file does not
require another password change or service restart; pending jobs retry within
their backoff window, up to five minutes after a failed attempt. Restart after
changing group membership or service environment variables. Existing files with
custom ACLs must also allow the service to read settings and modify queue files.

### Read-only checks under the service identity

Where interactive logon is permitted, an administrator can open a diagnostic
session with the service identity. Enter its password locally, never in a command
argument or a shared log. This is a diagnostic technique, not a requirement to
grant interactive logon to the service account.

```powershell
runas /user:ACMUIC\acmmemberportal "powershell.exe -NoProfile -NoExit"
```

Run the following in that new window. These checks do not create accounts,
change passwords, or trigger synchronization:

```powershell
$ErrorActionPreference = 'Stop'
whoami
whoami /groups

$syncSettings = Get-Content -LiteralPath `
    'C:\ProgramData\ACM\EntraSync\settings.json' -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($syncSettings.ConnectorName) -or
    [string]::IsNullOrWhiteSpace($syncSettings.UsersOu)) {
    throw 'ConnectorName and UsersOu are required.'
}
$syncSettings | Select-Object ConnectorName, UsersOu
icacls 'C:\ProgramData\ACM\EntraSyncQueue'

Import-Module ADSync -ErrorAction Stop
Get-Command Get-ADSyncScheduler, Start-ADSyncSyncCycle, Invoke-ADSyncCSObjectPasswordHashSync
Get-ADSyncScheduler -ErrorAction Stop |
    Select-Object SyncCycleEnabled, SyncCycleInProgress, StagingModeEnabled, SchedulerSuspended
Get-ExecutionPolicy -List
```

Expect the service identity and its refreshed Operators/Browse memberships,
readable settings, all three commands, `SyncCycleEnabled = True`, and staging and
suspension disabled. A busy directory cycle should clear normally; the worker
retries rather than interrupting it. Command discovery and a scheduler read do
not prove permission to execute the two sync triggers. Enabled API startup
separately checks queue write access. If interactive logon is denied, use your
approved diagnostic mechanism under the same identity rather than testing only
as an administrator.

Look for `Entra synchronization worker enabled`, sync-request accepted messages,
or retry/persistence errors in service logging. An accepted request is not a
completed export or evidence that the password is ready for Microsoft sign-in.
Use the Connect diagnostics and a real test sign-in to verify the result.
The unchanged `/healthz` response checks API liveness, not sync health.

The queue is written immediately **after** AD reports success. A process crash
in that small interval, or a later disk-write failure, can miss the extra trigger;
normal scheduled directory/password synchronization remains the fallback. Such
failures never turn a completed password change or creation into an HTTP error
and never replay AD operations. Already-persisted jobs resume on service restart.
Disabling the feature pauses the queue without deleting it.

Run the .NET queue/notification/worker regressions and the Windows PowerShell
checks without contacting AD or Connect:

```powershell
dotnet test windows-api.Tests/AcmProvisioning.Tests.csproj
powershell.exe -NoProfile -File windows-api/EntraSync/test-sync.ps1
```

The PowerShell checks mock all ADSync calls and exercise the real stdin wrapper
in an isolated subprocess. Live Connect permissions, sync completion, and
Microsoft sign-in still require deployment-time validation.

Microsoft references: [ADSync commands](https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/reference-connect-adsync),
[delegating sync operations with ADSyncOperators](https://learn.microsoft.com/en-us/answers/questions/889690/delegate-permssion-on-aadconnect),
[directory scheduler](https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-sync-feature-scheduler),
and [password synchronization](https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-password-hash-synchronization).

### Troubleshoot synchronization and sign-in

Use **Event Viewer → Windows Logs → Application**. API worker entries use source
`AcmProvisioning` and category `AcmProvisioning.EntraSyncWorker`; Connect entries
use sources such as `Directory Synchronization` and `ADSync`. Include Information
events in the view, not only warnings/errors. The shipped `appsettings.json`
sets `Logging:EventLog:LogLevel:Default` to `Information`; check environment
overrides if API success messages are missing. For example, from an
administrator session:

```powershell
Get-WinEvent -FilterHashtable @{
    LogName = 'Application'
    ProviderName = 'AcmProvisioning'
    StartTime = (Get-Date).AddMinutes(-30)
} -MaxEvents 50 | Select-Object TimeCreated, LevelDisplayName, Message
```

| Symptom | Next check |
| --- | --- |
| Microsoft does not recognize the username | Confirm the exact ACM UPN and AD account, then check directory import/export and the `Directory` request result. Object synchronization and password synchronization are separate. |
| Microsoft recognizes the username but rejects the new password | Confirm the portal activation receipt and AD `pwdLastSet` is nonzero; allow propagation before another attempt. Check the per-user password-sync diagnostic and Event 657 for the same DN. Do not repeatedly reset or reissue credentials. |
| `Entra Directory` or `Entra UserHash` request fails | Run the service-identity checks above: missing/unreadable settings, module or command availability, group token, script execution policy, and scheduler state. A generic warning does not identify which check failed. |
| No API worker events | Check the running deployment, `EntraSync__Enabled`, service restart, Information-level logging, event filters, and the service's startup logs. A healthy `/healthz` does not establish sync health. |
| Queue cannot load or persist progress | Check the configured absolute path, service Modify access, disk availability, and that only one process owns the directory. Preserve pending jobs; do not delete `queue.json` or share it between instances. |

The worker logs `Entra Directory sync request accepted` and
`Entra UserHash sync request accepted` separately. A failure retries only
synchronization, never account creation or the password change. Raw PowerShell
errors are deliberately discarded, so expanding the generic warning does not
reveal the underlying exception. If basic checks pass, reproduce the fixed sync
operation under the service identity in a controlled diagnostic session without
supplying or logging passwords. Record any such invocation as **manual
intervention**, not proof of the automatic path.

Connect Event **657** with `Result: Success` confirms that the identified user's
password hash synchronized; `Result: Failed` is a failure. Match the account DN,
connector, and timestamp. `PwdChangeOnLogon=False` is consistent with completing
the initial AD password change. Neither this event nor a successful login alone
identifies whether the API request or the normal schedule triggered sync. See
[Microsoft's password-sync event reference](https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/user-prov-sync/troubleshoot-pwd-sync#event-id-messages-in-event-viewer).

For a per-user diagnostic, run on the Connect server with the necessary
administrative access; obtain the exact current DN rather than assuming a
year/month OU:

```powershell
Import-Module ADSync
Get-ADSyncConnector | Where-Object { $_.ConnectorTypeName -eq 'AD' } |
    Select-Object Name, Identifier
Import-Module ActiveDirectory
$testUsername = Read-Host 'Exact test username'
$testAdUser = Get-ADUser -Identity $testUsername -Properties pwdLastSet, PasswordLastSet
$testAdUser | Format-List SamAccountName, UserPrincipalName, DistinguishedName, pwdLastSet, PasswordLastSet
Import-Module ADSyncDiagnostics
Invoke-ADSyncDiagnostics -PasswordSync -ADConnectorName 'acmuic.org' `
    -DistinguishedName $testAdUser.DistinguishedName
```

Use the connector name from the first command if it differs. The ActiveDirectory
module is needed for these operator diagnostics, not for normal API operation.

### Live onboarding verification

1. Complete host setup and service restart **before** creating a uniquely named,
   disposable signup. Use synthetic contact details and **Show temporary
   password** to avoid sending test mail. Confirm any earlier cleanup sync has
   finished, then leave manual sync off during the test.
2. Approve the signup, confirm its AD account was created, and acknowledge
   credential delivery. Record the provisioning event ID and approval time.
3. Have the applicant complete `/activate/` with the temporary password and a new
   password. Record the portal activation receipt and confirm AD `pwdLastSet` is
   nonzero. Keep passwords out of tickets, screenshots, logs, and test reports.
4. Record `Directory` and `UserHash` request-accepted messages and the matching
   Connect password-sync result, including timestamps and time zone. These are
   separate checks from the portal's AD success response.
5. Allow synchronization, then sign in with Microsoft using the ACM UPN and new
   password. Space retries by a few minutes instead of repeatedly submitting
   credentials. The October 22, 2026 smoke test reported successful hash sync
   about 34 seconds after activation and accepted Microsoft password sign-in on
   a retry about three minutes after activation. These are observations, not a
   latency guarantee; portal guidance allows up to 30 minutes before escalation.
6. Complete the tenant's security enrollment requirements. For a disposable test
   account, defer setup only when explicitly approved and offered by Microsoft.
   Verify the OAuth callback reaches the portal dashboard under the **test
   identity**, with membership Active and AD account Provisioned.
7. Record whether any manual sync, password reset, service restart, or host change
   occurred after approval. Such intervention may restore access, but does not
   validate an onboarding run without intervention. If worker acceptance logs
   are unavailable, report successful synchronization/sign-in without claiming
   that the API triggers were verified. Then perform the cleanup below.

### Clean up disposable test accounts

Portal records, on-prem AD accounts, and synchronized Entra accounts have
separate lifecycles. Portal deletion does not remove AD access; AD deletion must
be exported to Entra. The Windows API has no account-deletion endpoint, and the
portal currently has no complete test-account deletion UI.

1. Identify the exact disposable username, portal user ID (if one exists), signup
   ID, provisioning event ID, and AD DN/event-description marker. Verify the
   synthetic name/email and ownership; never delete by a broad `codextest%`
   pattern. Ensure no provisioning or credential-delivery attempt is in flight.
2. Have an authorized database operator remove the matched portal records in one
   transaction with identity/status guards. Delete the provisioning event before
   its signup; activation receipts and provisioning logs cascade. Deleting the
   portal user revokes its sessions and removes linked provider accounts, member
   profile, and role assignments through cascades. A signup that never completed
   Microsoft login may have no portal user yet.
3. Verify/release only that account's orphaned `username_claims` reservation.
   Remove its hashed username activation-limit entry if appropriate, preserving
   shared address limits. Retain audit history and append a cleanup audit entry;
   audit actor references must be preserved rather than deleted to bypass foreign
   keys. Confirm the exact user, signup, session, provider-account, provisioning,
   and activation rows are gone. Do not paste production tokens or provider
   credentials into cleanup output.
4. On a machine with the ActiveDirectory module, inspect the exact AD account and
   delete it with the normal confirmation prompt:

   ```powershell
   Import-Module ActiveDirectory
   $testUsername = Read-Host 'Exact disposable test username to delete'
   $testAdUser = Get-ADUser -Identity $testUsername -Properties Description
   $testAdUser | Format-List SamAccountName, UserPrincipalName, DistinguishedName, Description
   Remove-ADUser -Identity $testAdUser -Confirm:$true
   ```

5. Allow the normal directory cycle to export the deletion. After the onboarding
   measurement has ended, an authorized operator can instead run
   `Import-Module ADSync; Start-ADSyncSyncCycle -PolicyType Delta` on the Connect
   server. Confirm the object leaves the active Entra user list; merely starting
   a cycle does not confirm deletion export. Close test browser sessions and
   remove saved test credentials without disturbing administrator sessions.

The API does not queue synchronization for an external `Remove-ADUser` operation.
Do not delete the shared sync queue during cleanup: it may contain unrelated
account work. Do not reuse a test username until deletion has propagated.

## Host requirements

- Domain-joined Windows Server 2019+ (LDAP/ADSI, no RSAT PowerShell module)
- .NET 10 runtime (`dotnet --list-runtimes` → Microsoft.AspNetCore.App 10.x)
- Service identity `ACMUIC\acmmemberportal` (see [Service account](#service-account)). Do
  not run as LocalSystem or Domain Admin. `New-ADUser` in your own PowerShell
  session only proves _your_ token can create users.
- Firewall: allow inbound 2433 (or 443 with a cert) from the k8s cluster egress only
- LDAP (TCP 389) from this host to the DCs. The PowerShell AD module uses ADWS
  (9389); this process uses LDAP.

## Service account

The Windows service impersonates `ACMUIC\acmmemberportal` for every LDAP bind.
Provision that account once, then keep it off Domain Admins and out of the
members OU it manages.

1. Create the user in AD (dedicated account, password never expires, no interactive
   login needed). sAMAccountName `acmmemberportal`, UPN
   `acmmemberportal@acmuic.org`.
2. Delegate on the members OU (`OU=ACMUsers,DC=acmuic,DC=org` unless
   `Provisioning__UsersOu` says otherwise):
   - ADUC → the OU → Delegate Control → `ACMUIC\acmmemberportal`
   - canned task **Create, delete, and manage user accounts**
     That grants create/delete users, reset password, and write the attributes this
     API sets (`givenName`, `sn`, `displayName`, `mail`, `description`,
     `employeeID`, `department`, `company`, `sAMAccountName`, `userPrincipalName`, `userAccountControl`,
     `pwdLastSet`).
   - Add a custom delegation on the base OU and descendant OUs for **Create
     Organizational Unit objects**. The API needs this to create years under
     the base OU and months under each year OU.
   - Ensure the user-management delegation applies to descendant user objects
     and permits creating users in descendant OUs. New year and month OUs must inherit
     those permissions and any member Group Policy settings.
3. Confirm the ACE:

   ```powershell
   dsacls "OU=ACMUsers,DC=acmuic,DC=org"
   # look for ACMUIC\acmmemberportal (create-child user, reset password, write)
   ```

4. On the Windows host, grant **Log on as a service** to `ACMUIC\acmmemberportal`
   (Local Security Policy → User Rights Assignment). `sc.exe create` / `config`
   with `obj=` often adds this; if start fails with 1069 it is missing.
5. NTFS: the account needs Read & execute on `C:\srv\acm-provisioning`.
6. Prove it _as that user_, not as you:

   ```powershell
   runas /user:ACMUIC\acmmemberportal powershell
   New-ADUser -Name "Acl Test" -SamAccountName acltest01 `
     -UserPrincipalName acltest01@acmuic.org `
     -Path "OU=ACMUsers,DC=acmuic,DC=org" `
     -AccountPassword (Read-Host -AsSecureString) `
     -Enabled $true -ChangePasswordAtLogon $true
   Get-ADUser acltest01
   Remove-ADUser acltest01 -Confirm:$false
   ```

Access denied from the API is `0x80070005` (or another LDAP insufficient-access
code) in the JSON `{ error }` body. Lookup succeeding and create failing means
create/reset is missing on the OU.

## Configuration

Environment variables override `appsettings.json`:

- `Provisioning__Token` — shared bearer token (same value as the portal's `WINDOWS_API_TOKEN` k8s Secret)
- `Provisioning__UpnSuffix` — e.g. `acmuic.org`
- `Provisioning__UsersOu` — existing base OU, e.g. `OU=ACMUsers,DC=acmuic,DC=org`; year OUs and nested month OUs are created beneath it
- `Provisioning__TimeZone` — calendar time zone for monthly OUs; defaults to `America/Chicago`
- `Provisioning__DomainController` — optional; defaults to the domain's auto-discovered DC

## Deploy

### Deployment script

From an elevated PowerShell session on the Windows host, run this command from
the root of the checked-out repository. To launch from another directory, use
the full path to `deploy.ps1`; it resolves the project relative to itself:

```powershell
.\windows-api\deploy.ps1
```

Install a .NET 10 SDK on the build host as well as the ASP.NET Core 10 runtime.
Complete the [service account setup](#service-account), firewall rules, and
[configuration](#configuration) before the first deployment. Set
`Provisioning__Token` to the portal's shared token in the machine or service
environment. The script does not provision AD accounts or configure secrets.

The script prompts for the `ACMUIC\acmmemberportal` password, cleans and
publishes a framework-dependent Release build to a temporary directory, then
stops the existing service and copies the files to `C:\srv\acm-provisioning`.
It grants the account Read & execute access and pre-creates `service-boot.log`
and `startup-error.log` with write access for that account. Existing log contents
are preserved. It creates or updates `AcmProvisioning`
with automatic startup and `--windows-service`, starts it, prints its
registration, and waits for `/healthz` to report `ok`.
The health wait uses a monotonic timer and limits requests and retry delays to
the remaining `TimeoutSeconds` budget. Updating the registration preserves
service-specific environment variables. Registration uses the local
`Win32_Service` API so the password is not passed in a child process command line.

To override the installation directory, account, health endpoint, or wait timeout,
use these parameters. The health endpoint must be an absolute HTTP or HTTPS URI:

```powershell
.\windows-api\deploy.ps1 `
  -InstallPath 'D:\ACM Services\provisioning' `
  -ServiceCredential (Get-Credential 'ACMUIC\acmmemberportal') `
  -HealthUri 'http://localhost:2433/healthz' `
  -TimeoutSeconds 120
```

Use an absolute drive or UNC path to a dedicated installation directory outside
the source project. Drive-relative forms such as `C:` and `C:folder` are rejected.
The script rejects installation paths equal to, within, or containing the project directory.
Containment checks use Windows filesystem handles to resolve path aliases,
including NTFS short names. Device-prefixed installation paths are rejected.
Deployment removes the installation directory's old files and
subdirectories except `service-boot.log` and `startup-error.log`, then copies
the new application files, including `appsettings.json`. Permission grants
replace the service account's existing explicit grants on the installation
tree and log files. Inherited permissions and group memberships still depend
on host configuration.
When changing the service identity, the script compares account SIDs and removes
the former account's explicit grants throughout the installation directory,
including the logs. Windows' baseline SYSTEM grants are preserved.
Account SID lookups must succeed before stopping the service.
Drive roots and UNC share roots are rejected, with or without a trailing slash.
The script rejects junctions and symbolic links in the installation path,
its existing parents, and its contents. Existing diagnostic log paths must
be regular files. These checks run before deployment and again after publishing,
before stopping the service.
Keep host-specific settings in environment variables. A build failure leaves
the running service alone. A failure after stopping the service requires fixing
the reported error and rerunning the script; it does not roll back files.
The health check confirms HTTP liveness. Run the [AD verification](#verify)
separately to check account creation and updates.

Run the deployment regression checks in a fresh Windows PowerShell process:

```powershell
powershell.exe -NoProfile -File .\windows-api\tests\deploy.Tests.ps1
```

The checks exercise the native command helper using Windows PowerShell and a
temporary script,
then mock service management and native commands for deployment scenarios,
and require neither elevation nor a domain account. They cover registration,
password handling, diagnostic log permissions and preservation, obsolete file
removal, and failure paths.

### Manual deployment

Publish, then register as a Windows service. `binPath` must include `--windows-service`
so the process reports to SCM. A console Kestrel app will `sc.exe create` successfully,
then `sc.exe start` fails with **1053**.

```powershell
dotnet publish -c Release -o C:\srv\acm-provisioning

# Confirm the ASP.NET Core 10 runtime is installed (framework-dependent publish):
dotnet --list-runtimes
# expect: Microsoft.AspNetCore.App 10.x

# Recreate if an old registration exists:
sc.exe stop AcmProvisioning
sc.exe delete AcmProvisioning

# --windows-service forces SCM lifetime even when parent-process detection fails
sc.exe create AcmProvisioning `
  binPath= "C:\srv\acm-provisioning\AcmProvisioning.exe --windows-service" `
  start= auto `
  obj= "ACMUIC\acmmemberportal" `
  password= "<acmmemberportal password>"
sc.exe start AcmProvisioning
sc.exe qc AcmProvisioning
# SERVICE_START_NAME should be ACMUIC\acmmemberportal
```

To change the account on an existing service without deleting it:

```powershell
sc.exe stop AcmProvisioning
sc.exe config AcmProvisioning obj= "ACMUIC\acmmemberportal" password= "<acmmemberportal password>"
sc.exe start AcmProvisioning
```

Smoke-test the binary as a console app first if start still fails (omit `--windows-service`):

```powershell
C:\srv\acm-provisioning\AcmProvisioning.exe
# should listen on http://0.0.0.0:2433; Ctrl+C to stop
```

If `sc.exe start` still returns 1053, check `C:\srv\acm-provisioning\service-boot.log` and
`startup-error.log`. Startup exceptions also land in **Event Viewer → Windows Logs → Application**.
Do not publish with `Microsoft.PowerShell.SDK` or `-r win-x64`; those have prevented the
process from reporting to SCM. Common remaining causes: no ASP.NET Core 10 runtime,
or the process dying before it reports `SERVICE_RUNNING` (bad `appsettings.json` path,
port 2433 already bound).

## Verify

Run the Windows API tests with
`dotnet test ../windows-api.Tests/AcmProvisioning.Tests.csproj` from this directory.
These test month and year boundaries in Chicago time, duplicate legal names,
DN escaping, OU creation error classification, failed account setup and cleanup,
replays of incomplete accounts, event-owned credential retries, overlapping
requests and cancellation, password changes racing credential reissue in either
order, AD error translation, and password redaction.
Live OU and account creation still require the Windows host and a
test domain account. Verify two different usernames with the same legal name in
the same month, replay after a month change, and inherited permissions in a newly
created monthly OU. Existing accounts under the base OU must still support lookup,
updates, and password changes. Verify a failed credential email can retry with
the same event ID, while different event IDs and accounts that already changed
their password cannot obtain a reset.

```powershell
# create (sAMAccountName comes from username, not netid)
curl -H "Authorization: Bearer <token>" -X POST http://localhost:2433/users `
  -H "content-type: application/json" `
  -d '{"netid":"amorga42","username":"amorga","firstName":"Alex","lastName":"Morgan","preferredName":"Alex","displayName":"Alex","email":"alex@example.com","uin":"678901234","department":"Computer Science","company":"Engineering","eventId":"<uuid>"}'
# → { "samAccountName": "amorga", "existed": false, "oneTimePassword": "…" }
# replay → { "samAccountName": "amorga", "existed": true }

curl -H "Authorization: Bearer <token>" http://localhost:2433/users/amorga
# → { "samAccountName": "amorga", "existed": true }

curl -H "Authorization: Bearer <token>" -X PATCH http://localhost:2433/users/amorga `
  -H "content-type: application/json" `
  -d '{"displayName":"Alex Morgan","email":"alex@example.com"}'
# → { "samAccountName": "amorga", "existed": true }

Get-ADUser amorga -Properties GivenName, Surname, DisplayName, EmployeeID, Department, Company, EmailAddress, DistinguishedName
# New account DN: CN=amorga,OU=MM,OU=YYYY,OU=ACMUsers,DC=acmuic,DC=org
```
