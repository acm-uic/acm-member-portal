# ACM Provisioning API

Minimal ASP.NET API that creates on-prem Active Directory accounts for approved
ACM@UIC signups. The member portal's outbox worker is its only caller.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | none | liveness |
| POST | `/users` | Bearer | create AD user (idempotent on sAMAccountName) |
| GET | `/users/{netid}` | Bearer | existence check |

`POST /users` body: `{ netid, displayName, email, uin?, eventId }`.
Response: `{ samAccountName, existed, oneTimePassword? }` — `oneTimePassword`
is returned only when a NEW account was created. It is never logged or stored.

## Host requirements

- Windows Server 2019+ with **RSAT: Active Directory module for Windows PowerShell**
  (`Install-WindowsFeature RSAT-AD-PowerShell`)
- .NET 8 runtime (`dotnet --list-runtimes` → Microsoft.AspNetCore.App 8.x)
- A service account delegated **Create/delete user objects** + **Reset user passwords**
  on the Members OU (do NOT run as Domain Admin)
- Firewall: allow inbound 8080 (or 443 with a cert) from the k8s cluster egress only

## Configuration

Environment variables override `appsettings.json`:

- `Provisioning__Token` — shared bearer token (same value as the portal's `WINDOWS_API_TOKEN` k8s Secret)
- `Provisioning__UpnSuffix` — e.g. `acm-uic.org`
- `Provisioning__UsersOu` — e.g. `OU=Members,DC=acm,DC=local`
- `Provisioning__DomainController` — optional; defaults to the domain's auto-discovered DC

## Deploy

```powershell
dotnet publish -c Release -o C:\srv\acm-provisioning
# run as a Windows service (one option):
sc.exe create AcmProvisioning binPath= "C:\srv\acm-provisioning\AcmProvisioning.exe"
sc.exe start AcmProvisioning
```

## Verify

```powershell
curl -H "Authorization: Bearer <token>" -X POST http://localhost:8080/users `
  -H "content-type: application/json" `
  -d '{"netid":"amorga42","displayName":"Alex Morgan","email":"alex@example.com","uin":"678901234","eventId":"<uuid>"}'
# → { "samAccountName": "amorga42", "existed": false, "oneTimePassword": "…" }
# replay → { "samAccountName": "amorga42", "existed": true }
Get-ADUser amorga42 -Properties EmployeeID, extensionAttribute1
```
