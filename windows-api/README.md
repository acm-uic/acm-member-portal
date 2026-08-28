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

- Windows Server 2019+ with **RSAT: Active Directory module for Windows PowerShell**
  (`Install-WindowsFeature RSAT-AD-PowerShell`)
- .NET 10 runtime (`dotnet --list-runtimes` → Microsoft.AspNetCore.App 10.x)
- A service account delegated **Create/delete user objects** + **Reset user passwords**
  on the Members OU (do NOT run as Domain Admin)
- Firewall: allow inbound 2433 (or 443 with a cert) from the k8s cluster egress only

## Configuration

Environment variables override `appsettings.json`:

- `Provisioning__Token` — shared bearer token (same value as the portal's `WINDOWS_API_TOKEN` k8s Secret)
- `Provisioning__UpnSuffix` — e.g. `acm-uic.org`
- `Provisioning__UsersOu` — e.g. `OU=Members,DC=acm,DC=local`
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
sc.exe create AcmProvisioning binPath= "C:\srv\acm-provisioning\AcmProvisioning.exe --windows-service" start= auto
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
