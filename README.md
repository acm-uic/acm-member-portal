# ACM@UIC Member Portal

Qwik City member portal — public signup, officer approval, MS365/Entra SSO,
Active Directory provisioning, admin configuration, and resources hub.

## Architecture (one screen)

- `src/` — Qwik City SSR app (Fastify runtime)
- `src/worker/` — provision outbox worker + nightly alumni digest (Node 24+)
- `windows-api/` — ASP.NET minimal API (`New-ADUser` wrapper) — runs on Windows
- `drizzle/0000_initial.sql` — Postgres schema + seeds (applied by `scripts/migrate.ts`)
- `terraform/` — Azure Entra app registration + k8s Secret
- `k8s/` — Deployment + Service + Ingress + worker Deployment + CronJob + CNPG cluster + NetworkPolicy

## Prerequisites

- Node 24+ runtime (`node --version`)
- Docker (for the container build)
- Kubernetes cluster with: ingress-nginx, cert-manager (Let's Encrypt issuer),
  CloudNativePG operator
- An ACM Microsoft 365 tenant (admin role)
- An on-prem Active Directory with an `acm-uic.org` UPN suffix
- A self-hosted SMTP relay (or use the M365 SMTP alternative — see `windows-api/README.md`)
- An S3-compatible bucket for Terraform state + a DynamoDB-compatible table for locks

## First deploy (dev)

```bash
# 1. Env
cp .env.example .env
# Fill MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, etc. (the latter will come from
# `terraform output client_id` after step 3).

# 2. Build the image
docker build -t registry.example.com/acm/member-portal:latest .
docker push registry.example.com/acm/member-portal:latest

# 3. Entra app registration + dev Secret
cd terraform
terraform init
terraform apply -var-file=dev.tfvars
cd ..

# 4. Postgres + worker + cronjob + portal
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres-cluster.yaml
kubectl wait --for=condition=Ready --timeout=180s cluster/portal-db -n acm-portal
kubectl apply -f k8s/secret.example.yaml   # only for first boot, then terraform owns it
kubectl apply -f k8s/networkpolicy.yaml
kubectl apply -f k8s/worker.yaml
kubectl apply -f k8s/app.yaml

# 5. Entra admin consent
# After terraform apply, visit https://entra.microsoft.com → App registrations →
# acm-member-portal-dev → API permissions → "Grant admin consent for <tenant>".
# Required because the openid / profile / email scopes are requested at runtime
# by better-auth's Microsoft provider but not declared in the app registration's
# required_resource_access (admin-consent is the standard path).

# 6. Verify
kubectl get pods -n acm-portal
kubectl wait --for=condition=Ready --timeout=120s deployment/portal -n acm-portal
curl -fsS https://portal.acm-uic.org/healthz
```

The first pod's `migrate` init container applies `drizzle/0000_initial.sql` via
`scripts/migrate.ts` (advisory-locked, idempotent).

## Network policy

The shipped `k8s/networkpolicy.yaml` is a default-deny with DNS + CloudNativePG
0.0.0.0/0 :80/:443 minus RFC1918 (dev-safe fallback). For FQDN-scoped egress
to `login.microsoftonline.com` and the Windows API host, **use a Cilium or
Calico CNI** and replace the broad `0.0.0.0/0` rule with FQDN selectors — the
design commits to FQDN egress but requires the CNI to enforce it. The shipped
policy is a dev fallback; production should narrow egress.

Confirm with cluster admins that the CNI in the target cluster supports
FQDN egress (Cilium or Calico); if it does not, swap `k8s/networkpolicy.yaml`
to the IP-range variant before `kubectl apply`.

## Daily development

```bash
# Zero-config local mode (no Postgres, Entra, SMTP, or Windows API):
# boots in-process PGlite, seeds officer@localhost / local-dev, stubs mail + AD.
bun run dev          # or: npm run dev — vite on :5173
# Reset local DB + stub mail: rm -rf .data

# Against a real Postgres (CloudNativePG-shaped):
# cp .env.example .env  # set DATABASE_URL + auth secrets
npm run db:migrate   # apply drizzle/0000_initial.sql (also runs in init container)
npm run dev

npm run check        # tsc --noEmit
npm test             # vitest run
```

Local credentials (embedded mode only):

- Officer: `officer@local.test` / `local-dev`
- After approving a signup, the member password is written under `.data/mail/`
- `DEV_LOGIN=1` enables the same email/password login against a real `DATABASE_URL`
## Deploying the Windows API

See `windows-api/README.md`. Briefly: a Windows Server with the RSAT AD PowerShell
module, a `.NET 8` runtime, a service account delegated `Create/delete user objects`
on the Members OU, and the same `WINDOWS_API_TOKEN` value as the k8s Secret.

## Verification checklist (initial deploy)

- [ ] `terraform apply` exits 0; `output client_id` is non-empty
- [ ] `kubectl get pods -n acm-portal` shows portal replicas Ready
- [ ] `/healthz` returns `{"status":"ok"}` on portal.acm-uic.org
- [ ] A logged-in officer can view /admin/signups (proves the Better Auth
  tenant lock, the `admin.access` permission gate, and the k8s Secret wiring)
- [ ] Approving a signup writes an `audit_events` row and a `provisioning_events`
  row in `pending`; the worker marks it `provisioned` and emails the member
- [ ] Running `kubectl create job --from cronjob/portal-alumni-digest --schedule="" -n acm-portal`
  smoke-tests the digest with a no-op exit when there are no candidates
