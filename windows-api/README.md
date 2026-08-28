# ACM Provisioning API

Minimal ASP.NET API that creates and updates on-prem Active Directory accounts
for ACM@UIC members. The member portal is its only caller: the outbox worker
POSTs new accounts, and profile saves PATCH existing ones.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | none | liveness |
| POST | `/users` | Bearer | create AD user (idempotent on sAMAccountName) |
| PATCH | `/users/{sam}` | Bearer | update AD user; `{sam}` is the current sAMAccountName |
| GET | `/users/{sam}` | Bearer | existence check |

JSON is camelCase. Required create fields: `username` (or `netid`), `firstName`,
`lastName`, `displayName`, `email`, `eventId`. Missing any of those is `400`.

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
part of `UserPrincipalName`. If it is omitted, `netid` is used instead. `eventId`
is correlation-only and is not written to AD.

AD mapping on create: `Name`/`CN`←`"First Last"`, `GivenName`←firstName,
`Surname`←lastName, `DisplayName`←displayName (portal sends preferred name or
`"First Last"`), `EmployeeID`←uin, `Department`←major, `Company`←college,
`EmailAddress`←email.

Response: `{ samAccountName, existed, oneTimePassword? }`. `oneTimePassword` is
returned only when a new account was created. It is never logged or stored.
Replay against an existing `sAMAccountName` returns `{ existed: true }` with no
password.

`PATCH /users/{sam}` body (all fields optional): `{ username, firstName,
lastName, preferredName, displayName, email, uin }`. Written to AD when set:
`GivenName`, `Surname`, `DisplayName`, `EmailAddress`, `EmployeeID`. A new
`username` renames `sAMAccountName` and `UserPrincipalName`. `preferredName` is
accepted and ignored; send `displayName` for the visible name. Unknown `{sam}`
is `404 { samAccountName, existed: false }`. Success is
`{ samAccountName, existed: true }` (no password).

`GET /users/{sam}` is `200 { samAccountName, existed: true }` or
`404 { samAccountName, existed: false }`.

## Host requirements

- Domain-joined Windows Server 2019+ (LDAP/ADSI, no RSAT PowerShell module)
- .NET 10 runtime (`dotnet --list-runtimes` → Microsoft.AspNetCore.App 10.x)
- Service identity `ACMUIC\acmmemberportal` (see [Service account](#service-account)). Do
  not run as LocalSystem or Domain Admin. `New-ADUser` in your own PowerShell
  session only proves *your* token can create users.
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
   API sets (`givenName`, `sn`, `displayName`, `mail`, `employeeID`, `department`,
   `company`, `sAMAccountName`, `userPrincipalName`, `userAccountControl`,
   `pwdLastSet`).
3. Confirm the ACE:

   ```powershell
   dsacls "OU=ACMUsers,DC=acmuic,DC=org"
   # look for ACMUIC\acmmemberportal (create-child user, reset password, write)
   ```
4. On the Windows host, grant **Log on as a service** to `ACMUIC\acmmemberportal`
   (Local Security Policy → User Rights Assignment). `sc.exe create` / `config`
   with `obj=` often adds this; if start fails with 1069 it is missing.
5. NTFS: the account needs Read & execute on `C:\srv\acm-provisioning`.
6. Prove it *as that user*, not as you:

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
- `Provisioning__UsersOu` — e.g. `OU=ACMUsers,DC=acmuic,DC=org`
- `Provisioning__DomainController` — optional; defaults to the domain's auto-discovered DC

## Deploy

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

Get-ADUser amorga -Properties GivenName, Surname, DisplayName, EmployeeID, Department, Company, EmailAddress
```
