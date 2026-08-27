# Contributing to acm-member-portal

## What should I know?

### Folder structure

| name         | explanation                                                                              |
| ------------ | ---------------------------------------------------------------------------------------- |
| src          | Qwik City SSR app: routes, components, auth, RBAC, mail, provisioning outbox.            |
| src/worker   | Provision outbox worker and nightly alumni digest (Node 24+).                            |
| windows-api  | ASP.NET minimal API (`New-ADUser` wrapper). Runs on Windows with RSAT AD PowerShell.     |
| drizzle      | Postgres schema and seeds. Applied by `scripts/migrate.ts`.                              |
| terraform    | Azure Entra app registration and k8s Secret.                                             |
| k8s          | Deployment, Service, Ingress, worker, CronJob, CNPG cluster, NetworkPolicy.              |
| helm         | Helm chart for the same workloads.                                                       |
| scripts      | Node scripts such as `migrate.ts`.                                                       |
| adapters     | Vite adapter config for the Fastify server build.                                        |

### Stack

Qwik City on Fastify, Postgres via Drizzle, Better Auth with Microsoft Entra, and a Windows AD provisioning API.

### Installation

```console
bun install
```

For most UI work you can skip `.env`: `bun run dev` boots in-process PGlite. Copy `.env.example` to `.env` only when you need real Postgres, Entra, SMTP, or the Windows API.

### Local development

```console
bun run dev
```

Vite on :5173. `bun run check` typechecks. `bun test` runs vitest. `bun run db:migrate` applies `drizzle/0000_initial.sql` when you are not using embedded PGlite.

The Windows API is not required for most UI work. See `windows-api/README.md` if you are changing AD provisioning.

### Build

```console
bun run build
```

Client plus Fastify server build. `bun run serve` runs the production server entry.

## How can I Contribute?

### Reporting bugs

Bugs are tracked as [GitHub issues](https://guides.github.com/features/issues/).

- **Use a clear and descriptive title** for the issue to identify the problem.
- **Describe the exact steps which reproduce the problem** in as many details as possible. When listing steps, **don't just say what you did, but explain how you did it**.
- **Describe the behavior you observed after following the steps** and point out what exactly is the problem with that behavior.
- **Explain which behavior you expected to see instead and why.**
- **Include screenshots and animated GIFs** which show you following the described steps and clearly demonstrate the problem.

Include details about your configuration and environment:

- What's the name and version of the Browser you're using
- What's the name and version of the OS you're using?
- If it is a deploy or provisioning issue: Node version, k8s namespace, and whether Windows API / Entra / Postgres are in play

### Pull Requests

- Maintain code quality.
- Make sure `bun run check` and `bun test` are happy.
- Make sure the status checks are passing.
- Follow instructions in the pull request template.
- We try to squash and merge PRs when we can.
- Consider starting the PR title and commits with an applicable emoji:
  - 🌟 `:sparkles:` when adding an enhancement.
  - 🐛 `:bug:` when fixing a bug.
  - 📝 `:memo:` when writing docs.
  - 🔥 `:fire:` when removing code.
  - 💚 `:green_heart:` when fixing CI builds.
  - ⬆️ `:arrow_up:` when upgrading dependencies.
  - ⬇️ `:arrow_down:` when downgrading dependencies.

### PR and Issue labels

The labeler action should add some base labels to a pull request. Consider adding appropriate labels to pull requests and issues.
