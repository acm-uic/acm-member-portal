# ACM@UIC Member Portal

Qwik City member portal — public signup, officer approval, MS365/Entra SSO,
Active Directory provisioning, admin configuration, and resources hub.

## Architecture (one screen)

- `src/` — Qwik City SSR app (Fastify runtime)
- `src/worker/` — provision outbox worker + nightly alumni digest (Node 24+)
- `windows-api/` — ASP.NET minimal API (`New-ADUser` wrapper) — runs on Windows
- `drizzle/0000_initial.sql` — Postgres schema + seeds (applied by `scripts/migrate.ts`)
- `terraform/` — Azure Entra app registration + k8s Secret
- `helm/acm-member-portal/` — Helm chart (in-cluster CloudNativePG or an external database)
- `k8s/` — raw manifests kept as a reference, plus `secret.example.yaml`

## Prerequisites

- Node 24+ runtime (`node --version`)
- Docker (for the container build)
- Helm 3.14+
- Kubernetes cluster with Traefik (the chart does not create an Ingress)
- CloudNativePG operator, unless you point the chart at an external Postgres
  (`database.enabled=false`)
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
docker build -t ghcr.io/acm-uic/acm-member-portal:latest .
docker push ghcr.io/acm-uic/acm-member-portal:latest

# 3. Entra app registration + dev Secret
cd terraform
terraform init
terraform apply -var-file=dev.tfvars
cd ..

# 4. SMTP / Discord / Windows API keys on portal-secrets
# Terraform already wrote BETTER_AUTH_SECRET and MICROSOFT_*. Add SMTP_*,
# DISCORD_*, and WINDOWS_API_* from k8s/secret.example.yaml; do not replace
# the Secret. Skip DATABASE_URL. The chart reads it from CloudNativePG
# (portal-db-app). Discord linking is optional: omit DISCORD_CLIENT_ID to hide
# the UI. Register redirect URIs `{origin}/api/auth/callback/discord` and
# `{origin}/signup/discord/callback` on the Discord application. No bot is
# required for link/unlink.

# 5. Portal + worker + alumni digest + CloudNativePG Cluster
helm upgrade --install acm-portal ./helm/acm-member-portal \
  --namespace acm-portal --create-namespace

kubectl wait --for=condition=Ready --timeout=180s cluster/portal-db -n acm-portal

# 6. Entra admin consent
# After terraform apply, visit https://entra.microsoft.com → App registrations →
# acm-member-portal-dev → API permissions → "Grant admin consent for <tenant>".
# Required because the openid / profile / email scopes are requested at runtime
# by better-auth's Microsoft provider but not declared in the app registration's
# required_resource_access (admin-consent is the standard path).

# 7. Verify
kubectl get pods -n acm-portal
kubectl wait --for=condition=Ready --timeout=120s deployment/portal -n acm-portal
curl -fsS https://portal.acmuic.org/healthz
```

The first pod's `migrate` init container applies `drizzle/0000_initial.sql` via
`scripts/migrate.ts` (advisory-locked, idempotent).

## External database

The chart deploys a CloudNativePG `Cluster` named `portal-db` when
`database.enabled` is true (the default). To use Postgres created outside the
chart, set `database.enabled=false` and point at a Secret that holds
`DATABASE_URL`:

```bash
helm upgrade --install acm-portal ./helm/acm-member-portal \
  --namespace acm-portal --create-namespace \
  --set database.enabled=false \
  --set database.existingSecret=portal-secrets \
  --set database.existingSecretUrlKey=DATABASE_URL
```

You can also pass `database.host` plus `database.password` (the chart builds
the URL) or `database.url`. See `helm/acm-member-portal/values.yaml` for
storage size, replica counts, origin, and the rest.

## Network policy

The chart's NetworkPolicy (`networkPolicy.enabled`, default true) applies to
portal, worker, and digest pods only. Ingress is allowed on the app port;
egress is DNS, Postgres, and public :80/:443 minus RFC1918. CloudNativePG
pods are not selected, so the operator can still manage replication.

FQDN-scoped egress to `login.microsoftonline.com` and the Windows API host
needs Cilium or Calico. The chart rule is a dev fallback; production should
narrow egress. For an external database on a known CIDR, set
`networkPolicy.databaseCidrs`. The older `k8s/networkpolicy.yaml` is a
namespace-wide default-deny kept as a reference.

## Daily development

```bash
# Zero-config local mode (no Postgres, Entra, SMTP, Discord, or Windows API):
# boots in-process PGlite, seeds officer@localhost / local-dev, stubs mail + AD.
# Discord link/unlink stays hidden until DISCORD_CLIENT_ID is set.
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

## Contributing

Check out the [contributing guide](.github/CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## Verification checklist (initial deploy)

- [ ] `terraform apply` exits 0; `output client_id` is non-empty
- [ ] `kubectl get pods -n acm-portal` shows portal replicas Ready
- [ ] `/healthz` returns `{"status":"ok"}` on portal.acmuic.org
- [ ] A logged-in officer can view /admin/signups (proves the Better Auth
  tenant lock, the `admin.access` permission gate, and the k8s Secret wiring)
- [ ] Approving a signup writes an `audit_events` row and a `provisioning_events`
  row in `pending`; the worker marks it `provisioned` and emails the member
- [ ] Running `kubectl create job --from=cronjob/portal-alumni-digest digest-smoke -n acm-portal`
  smoke-tests the digest with a no-op exit when there are no candidates
