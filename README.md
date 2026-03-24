# Dobby

Ephemeral AI coding service. POST a task + a GitHub repo, get back a pull request. Pay per minute in FLOPS tokens via the Machine Payments Protocol.

## How It Works

1. **Submit** a job via `POST /v1/jobs` with a task description, GitHub repo URL, git token, and MPP payment token
2. **Dobby provisions** an ephemeral Fargate Spot container running an AI coding agent (OpenCode + Hyperpowers)
3. **The agent** clones the repo, executes the task, and creates a draft PR
4. **Poll** `GET /v1/jobs/:id` for status updates and the PR URL when done
5. **Billing** settles automatically — per-minute compute cost, unused escrow refunded on-chain

Jobs survive AWS Spot interruptions: the runner checkpoints its work and Dobby auto-resumes on a new container.

## Quick Start

### Submit a job

```bash
curl -X POST https://dobby.suverenum.ai/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "MPP-Token: <your-mpp-preauth-token>" \
  -d '{
    "repository": "https://github.com/your-org/your-repo",
    "task": "Add input validation to the /api/users endpoint using Zod",
    "gitToken": "ghp_xxxxxxxxxxxx",
    "baseBranch": "main"
  }'
```

Response:

```json
{ "id": "db_abc123", "status": "provisioning" }
```

### Poll for status

```bash
curl https://dobby.suverenum.ai/api/v1/jobs/db_abc123
```

Response (when complete):

```json
{
  "id": "db_abc123",
  "status": "completed",
  "prUrl": "https://github.com/your-org/your-repo/pull/42",
  "startedAt": "2026-03-24T10:00:00Z",
  "finishedAt": "2026-03-24T10:08:30Z",
  "costFlops": 15
}
```

### Optional fields

| Field           | Description                                              |
| --------------- | -------------------------------------------------------- |
| `baseBranch`    | Branch to clone from and PR into (default: `main`)       |
| `workingBranch` | Branch name for the work (default: auto-generated)       |
| `existingPrUrl` | Push to an existing PR instead of creating a new one     |
| `secrets`       | Key-value env vars passed to the runner (encrypted)      |

## Architecture

```
Caller (REST API)  →  Vercel (Next.js control plane + Admin UI)  →  AWS ECS Fargate Spot (runner containers)
                          ├── Neon Postgres (jobs table)                  ├── OpenCode + Hyperpowers (AI coding)
                          ├── MPP (FLOPS escrow/billing)                  ├── AWS Bedrock (Claude Opus 4 LLM)
                          ├── AWS KMS (secret encryption)                 ├── GitHub (clone, push, PR)
                          ├── CloudWatch (runner logs)                    └── Callback → API on status changes
                          └── EventBridge (Spot interruption events)
```

### Monorepo Structure

```
apps/web/              Next.js 16 — API, admin UI, job orchestration
packages/ui/           Shared UI components (Radix + CVA + Storybook)
packages/utils/        Shared utilities (cn, etc.)
packages/tsconfig/     Shared TypeScript configs
runner/                Docker container (clone → execute agent → PR)
specs/                 Product specs
```

## Commands

| Command             | Description                                        |
| ------------------- | -------------------------------------------------- |
| `bun run dev`       | Start all packages in dev mode (Turbopack)         |
| `bun run build`     | Production build (Turborepo cached)                |
| `bun run test`      | Run unit tests (Vitest)                            |
| `bun run test:e2e`  | Run E2E tests (Playwright)                         |
| `bun run lint`      | Lint with Biome                                    |
| `bun run typecheck` | TypeScript type checking                           |
| `bun run format`    | Format with Biome + Prettier (Tailwind class sort) |
| `bun run storybook` | Start Storybook for UI components                  |

### Database (run from `apps/web/`)

| Command               | Description                 |
| --------------------- | --------------------------- |
| `bun run db:generate` | Generate Drizzle migrations |
| `bun run db:migrate`  | Run migrations              |
| `bun run db:push`     | Push schema directly (dev)  |
| `bun run db:studio`   | Open Drizzle Studio         |

## Stack

| Category      | Technology                                         |
| ------------- | -------------------------------------------------- |
| Framework     | Next.js 16 (App Router, Turbopack, React Compiler) |
| Language      | TypeScript (strict)                                |
| Runtime       | Bun 1.3+                                           |
| Monorepo      | Bun workspaces + Turborepo                         |
| Database      | Drizzle ORM + Neon serverless Postgres             |
| Compute       | AWS ECS Fargate Spot                               |
| Secrets       | AWS KMS encryption                                 |
| Billing       | Machine Payments Protocol (FLOPS tokens)           |
| Styling       | Tailwind CSS v4 + shadcn/ui (base-nova)            |
| UI components | Radix primitives + CVA + Storybook 10              |
| Server state  | TanStack Query                                     |
| Client state  | Zustand                                            |
| Validation    | Zod v4                                             |
| Linting       | Biome                                              |
| Testing       | Vitest + React Testing Library + Playwright        |
| Observability | Sentry + PostHog                                   |
| Notifications | Telegram                                           |
| CI/CD         | GitHub Actions                                 |
| Deploy        | Vercel                                             |

## Job Lifecycle

```
pending → provisioning → cloning → executing → finalizing → completed
                                                           → failed
                                                           → timed_out
                                                           → stopped (manual)
                                       interrupted → (auto-resume) → provisioning → ...
```

Jobs are billed per minute: `ceil(duration_minutes) * (hourly_rate / 60)`, capped at the max budget. Unused escrow is refunded on settlement.

## Environment Variables

Copy `.env.example` to `apps/web/.env.local`.

| Variable                    | Required | Description                              |
| --------------------------- | -------- | ---------------------------------------- |
| `DATABASE_URL`              | Yes      | Neon Postgres connection string          |
| `DOBBY_CALLBACK_SECRET`     | Yes      | Shared secret for runner → API callbacks |
| `DOBBY_CALLBACK_URL`        | Yes      | Base URL for runner callbacks            |
| `AWS_ACCESS_KEY_ID`         | Yes      | AWS credentials (ECS + Bedrock)          |
| `AWS_SECRET_ACCESS_KEY`     | Yes      | AWS credentials (ECS + Bedrock)          |
| `ECS_CLUSTER_ARN`           | Yes      | ECS cluster ARN                          |
| `ECS_TASK_DEFINITION_ARN`   | Yes      | ECS task definition ARN                  |
| `ECS_SUBNETS`               | Yes      | Comma-separated subnet IDs               |
| `ECS_SECURITY_GROUPS`       | Yes      | Comma-separated security group IDs       |
| `KMS_KEY_ID`                | Yes      | KMS key ID for secret encryption         |
| `BEDROCK_MODEL_ID`          | No       | Bedrock model ID (default: Claude Opus 4)|
| `MPP_ENDPOINT`              | No       | MPP API endpoint (dev mode if missing)   |
| `MPP_API_KEY`               | No       | MPP API key                              |
| `SESSION_SECRET`            | No       | HMAC key for admin session cookies       |
| `DOBBY_ADMIN_PASSWORD_HASH` | No       | bcrypt hash for admin UI                 |
| `CRON_SECRET`               | No       | Vercel Cron auth for timeout enforcement |
| `NEXT_PUBLIC_SENTRY_DSN`    | No       | Sentry error tracking                    |
| `NEXT_PUBLIC_POSTHOG_KEY`   | No       | PostHog analytics                        |
| `DOBBY_TELEGRAM_BOT_TOKEN`  | No       | Telegram notifications                   |
| `DOBBY_TELEGRAM_CHAT_ID`    | No       | Telegram chat ID                         |

Optional services (Sentry, PostHog, Telegram, MPP) degrade gracefully when keys are missing.

## Deploy

Push to `main` for automatic Vercel deployment. CI runs lint, format check, typecheck, tests, and build on every push and PR.

## Prerequisites

- [Bun](https://bun.sh/) 1.3+
- [Node.js](https://nodejs.org/) 24+
- AWS account with ECS, KMS, and CloudWatch configured
- Neon Postgres database
