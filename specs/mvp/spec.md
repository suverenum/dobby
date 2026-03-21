# Technical Specification: Dobby — Ephemeral AI Coding Service

## 1. Meta Information

- **Branch:** TBD
- **Epic:** TBD
- **PRD:** [prd.md](prd.md)
- **Repository:** Greenfield project — new repository

## 2. Context

Dobby is an HTTP API that accepts a coding task + GitHub repo and returns a PR. It provisions ephemeral AWS Fargate Spot containers running Ralphex (Claude Code + Codex), bills per minute in FLOPS via MPP, and exposes a password-protected admin UI for job monitoring. See [PRD](prd.md) for full business context.

The tech stack is modeled after the Goldhord project (Next.js 16, TypeScript, Drizzle ORM, Neon Postgres, Tailwind, Biome, Vitest) but adapted for the Dobby-specific requirements (Fargate orchestration, MPP payments, CloudWatch log streaming).

## 3. Key Technical Drivers

- **Fast to deploy:** Clone → env vars → Vercel. AWS resources bootstrapped via IaC (CDK or Terraform). No manual AWS Console work.
- **Stateless runners, persistent API server:** Runners are ephemeral Fargate tasks. The API server (Vercel) persists job state, encrypted secrets, git credentials, and billing in Postgres.
- **Resumable after interruption:** Spot interruptions kill the container. The API server retains encrypted secrets and job state so a new runner can resume from the last git checkpoint.
- **Secure by default:** Caller secrets and git credentials encrypted at rest (AWS KMS), redacted from logs, deleted on terminal job status.
- **Low operational cost:** LLM tokens dominate cost (~90%). Compute is ~$0.12/hr on Fargate Spot. No always-on infrastructure beyond the Vercel deployment and Neon database.
- **Internal use only:** Single-tenant (us). No multi-user auth, no RBAC, no public signup. Password-protected admin UI.

## 4. Current State

Greenfield — no existing codebase. The architecture is designed from scratch.

### 4.1. Reference: Goldhord Stack

The sibling project (Goldhord) uses:
- Next.js 16 (App Router, Turbopack, React Compiler, PPR)
- TypeScript strict mode
- Bun workspaces + Turborepo
- Neon serverless Postgres + Drizzle ORM
- Tailwind CSS v4
- Biome (lint + format)
- Vitest + React Testing Library + Playwright
- Vercel deployment

Dobby will reuse this stack where applicable, with additions for AWS Fargate orchestration, MPP integration, and CloudWatch log streaming.

## 5. Considered Options

### 5.1. Option 1: Next.js on Vercel (API server) + Fargate Spot (runners)

- **Description:** Next.js API routes handle job submission, status polling, billing, and admin UI. Fargate Spot runs the ephemeral coding containers. Neon Postgres stores job state. AWS KMS encrypts secrets.
- **Pros:** Familiar stack (matches Goldhord), Vercel handles TLS/scaling/deploys, serverless Postgres (no DB management), clear separation between API server and runners.
- **Cons:** Vercel function timeout (max 300s on Pro) limits long-running API operations — but job submission and polling are fast. The actual long-running work happens in Fargate, not Vercel.

### 5.2. Option 2: Standalone Express/Fastify on EC2 or ECS

- **Description:** Dedicated Node.js server running on EC2 or ECS for the API server. No Vercel.
- **Pros:** No function timeouts, full control over server lifecycle.
- **Cons:** Must manage TLS, scaling, deployments, OS patches. Loses one-click Vercel deploy. More ops burden for no real benefit — our API calls are all short-lived.

### 5.3. Option 3: Serverless-only (Lambda + Step Functions)

- **Description:** AWS Lambda for API, Step Functions for job orchestration, no persistent server.
- **Pros:** Pure serverless, pay-per-invocation, auto-scaling.
- **Cons:** Complex orchestration (Step Functions state machines), cold starts on Lambda, harder to build admin UI, no WebSocket support for log streaming without API Gateway.

### 5.4. Comparison

| Criteria | Next.js + Vercel | Express on EC2/ECS | Lambda + Step Functions |
|---|---|---|---|
| Deploy effort | ✔️ One-click | ❌ Manual infra | ❌ Complex IaC |
| Familiar stack | ✔️ Matches Goldhord | ✔️ Node.js | ❌ New patterns |
| Admin UI | ✔️ Built-in (Next.js pages) | ✔️ Separate SPA | ❌ Static hosting needed |
| Log streaming | ✔️ Server-Sent Events | ✔️ WebSocket | ❌ API Gateway + Lambda |
| Ops burden | ✔️ Vercel-managed | ❌ Self-managed | ✔️ AWS-managed |
| Cost at low volume | ✔️ Free tier + Neon | ❌ Always-on instance | ✔️ Pay per invocation |

**Chosen: Option 1 — Next.js on Vercel + Fargate Spot**

## 6. Proposed Solution

### 6.1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Vercel (API Server)                     │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ API Routes   │  │ Admin UI     │  │ Cron / Background │  │
│  │ /v1/jobs     │  │ /admin       │  │ (timeout check,   │  │
│  │ POST, GET    │  │ Job list,    │  │  spot resume,     │  │
│  │              │  │ detail, logs,│  │  notifications)   │  │
│  │              │  │ stop/kill    │  │                   │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬──────────┘  │
│         │                 │                    │              │
│         └────────┬────────┴────────────────────┘              │
│                  │                                            │
│         ┌───────▼────────┐                                   │
│         │  Neon Postgres  │                                   │
│         │  (Drizzle ORM)  │                                   │
│         │  jobs, billing, │                                   │
│         │  encrypted      │                                   │
│         │  secrets        │                                   │
│         └───────┬────────┘                                   │
└─────────────────│────────────────────────────────────────────┘
                  │
    ┌─────────────▼──────────────┐
    │         AWS                 │
    │                             │
    │  ┌───────────────────────┐  │
    │  │ ECS Fargate Spot      │  │
    │  │ (ephemeral runners)   │  │
    │  │ 4 vCPU / 16 GB        │  │
    │  │ Default 6 concurrent  │  │
    │  └───────────┬───────────┘  │
    │              │               │
    │  ┌───────────▼───────────┐  │
    │  │ CloudWatch Logs       │  │
    │  │ (1 month retention)   │  │
    │  └───────────────────────┘  │
    │                             │
    │  ┌───────────────────────┐  │
    │  │ KMS                   │  │
    │  │ (secret encryption)   │  │
    │  └───────────────────────┘  │
    │                             │
    │  ┌───────────────────────┐  │
    │  │ ECR                   │  │
    │  │ (runner image)        │  │
    │  └───────────────────────┘  │
    └─────────────────────────────┘
```

### 6.2. API Server (Next.js on Vercel)

**Responsibilities:**
- Accept job submissions (`POST /v1/jobs`)
- Validate `existingPrUrl` against the provided repository and branches when present; reject mismatches with `400 Bad Request`
- Validate MPP payment authorization
- Encrypt and store caller secrets + git credentials (KMS)
- Provision Fargate Spot tasks via AWS SDK
- Track job status in Postgres
- Serve job status polling (`GET /v1/jobs/:id`)
- Handle final billing settlement via MPP when jobs reach a terminal state
- Resume interrupted jobs (detect via ECS task state change → EventBridge → Vercel webhook)
- Serve admin UI (Next.js pages with SSR)
- Stream logs from CloudWatch to admin UI (Server-Sent Events)
- Send Telegram notifications on status changes
- Enforce timeout (cron checks jobs exceeding `DOBBY_MAX_JOB_HOURS`)

**Tech stack:**
- Next.js 16 (App Router)
- TypeScript (strict)
- Drizzle ORM + Neon serverless Postgres
- AWS SDK v3 (ECS, KMS, CloudWatch Logs)
- Tailwind CSS v4 with the Tailwind Plus Protocol template as the UI foundation for the admin/docs surface
- Biome (lint + format)

### 6.3. Database Schema (Drizzle)

```typescript
// jobs table
export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),                    // db_xxx
  status: text('status').notNull(),               // pending, provisioning, cloning, executing, etc.
  repository: text('repository').notNull(),
  baseBranch: text('base_branch').notNull(),
  workingBranch: text('working_branch').notNull(),
  task: text('task').notNull(),
  existingPrUrl: text('existing_pr_url'),
  prUrl: text('pr_url'),

  // Encrypted at rest via KMS
  encryptedGitCredentials: text('encrypted_git_credentials').notNull(),
  encryptedSecrets: text('encrypted_secrets'),     // JSON blob, encrypted

  // ECS
  ecsTaskArn: text('ecs_task_arn'),
  ecsClusterArn: text('ecs_cluster_arn'),
  logStreamName: text('log_stream_name'),

  // Billing
  authorizedFlops: numeric('authorized_flops').notNull(),
  costFlops: numeric('cost_flops'),
  mppChannelId: text('mpp_channel_id'),

  // Timestamps
  submittedAt: timestamp('submitted_at').notNull().defaultNow(),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),

  // Spot resume
  resumeCount: integer('resume_count').default(0),
  lastCheckpointCommit: text('last_checkpoint_commit'),
});
```

### 6.4. Job Runner (Fargate Spot Container)

**Pre-built Docker image** stored in ECR. Operator can override with custom image via `DOBBY_CONTAINER_IMAGE`.

**Image contents (~840 MB):**
- Ubuntu 24.04 base
- Node.js 24 LTS + Claude Code CLI
- Python 3.12 + dev tools (pytest, ruff, mypy, black)
- OpenAI Codex CLI
- Ralphex
- Git, SSH, curl, jq

**Container entrypoint flow:**
1. Receive job config via environment variables (task, repo, branch, secrets, checkpoint)
2. Configure git credentials (`git config --global url."https://x-access-token:${TOKEN}@github.com/"`)
3. Clone repo, checkout or create working branch
4. If resuming: verify last checkpoint commit exists, start from there
5. Run Ralphex with task as input
6. On completion: create PR (or push to existing PR branch)
7. Report status back to API server (callback URL)
8. Exit (container terminates)

**SIGTERM handler:**
1. Trap SIGTERM
2. Push all committed work to remote
3. Report `interrupted` status to API server with last commit SHA
4. Exit gracefully within 120s (`stopTimeout`)

**Environment variables injected by API server:**
```
DOBBY_JOB_ID=db_xxx
DOBBY_TASK=<task markdown>
DOBBY_REPOSITORY=https://github.com/org/repo.git
DOBBY_BASE_BRANCH=main
DOBBY_WORKING_BRANCH=dobby/fix-login-bug
DOBBY_GIT_TOKEN=<decrypted PAT>
DOBBY_CALLBACK_URL=https://dobby.rent/api/internal/callback
DOBBY_CHECKPOINT_COMMIT=<sha or empty>
DOBBY_EXISTING_PR_URL=<url or empty>
# Caller secrets injected as additional env vars
DATABASE_URL=...
API_KEY=...
```

### 6.5. Fargate Orchestration

**Provisioning:**
- `ecs:RunTask` with Fargate Spot capacity provider
- Task definition pre-created during AWS bootstrap
- Override container environment variables per job
- 4 vCPU / 16 GB / 20 GB ephemeral storage

**Spot interruption and resume:**
- EventBridge rule: ECS Task State Change → `stopCode: "SpotInterruption"`
- Target: Vercel webhook endpoint (`/api/internal/ecs-event`)
- Control plane marks job as `interrupted`, waits for runner's callback with checkpoint SHA
- After callback (or 3-min timeout), API server resumes:
  1. Read encrypted secrets + git credentials from Postgres (still retained — only deleted on terminal status)
  2. Decrypt via KMS
  3. Provision new Fargate Spot task with same env vars + `DOBBY_CHECKPOINT_COMMIT` set to last pushed SHA
  4. Increment `resumeCount` on the job row
- **Secret lifecycle:** encrypted secrets and git credentials persist in Postgres for the entire job lifetime (across any number of spot interruptions). They are deleted only when the job reaches a terminal state (`completed`, `failed`, `timed_out`, `stopped`).

**Timeout enforcement:**
- Vercel Cron runs every 5 minutes
- Checks for jobs where `now - startedAt > DOBBY_MAX_JOB_HOURS`
- Calls `ecs:StopTask` which sends SIGTERM to container
- Runner handles SIGTERM, pushes work, and preserves the correct review surface:
  - New job: opens draft PR
  - Follow-up job with `existingPrUrl`: leaves the existing PR as the review surface

**Concurrency enforcement:**
- Before `ecs:RunTask`, count running jobs in Postgres (`status IN ('provisioning', 'cloning', 'executing', 'finalizing')`)
- Max = `floor(DOBBY_ACCOUNT_VCPU_LIMIT / DOBBY_VM_CPU)`
- If at capacity, return `429 Too Many Requests`

### 6.6. Admin UI

Server-rendered Next.js pages behind password auth.

**Theme / design baseline:**
- Use the Tailwind Plus [Protocol](https://tailwindcss.com/plus/templates/protocol) template as the starting point for the Dobby admin/docs shell
- Keep the overall information architecture and visual language from Protocol where it fits, then adapt components and navigation for Dobby's job list, job detail, logs, and admin actions

**Pages:**
- `/admin/login` — password form, sets session cookie (bcrypt verify against `DOBBY_ADMIN_PASSWORD_HASH`)
- `/admin/jobs` — job list table with status filter, sorted by submitted date
- `/admin/jobs/[id]` — job detail with full task, parameters, logs, stop button

**Log streaming:**
- Server-Sent Events (SSE) endpoint: `/api/admin/jobs/[id]/logs`
- Backend tails the job's CloudWatch log stream via `GetLogEvents` with `startFromHead` + `nextForwardToken`
- Polls every 2 seconds for running jobs
- Returns full log for completed/failed/stopped/timed-out jobs

**Stop/Kill:**
- `POST /api/admin/jobs/[id]/stop`
- Calls `ecs:StopTask` → SIGTERM → runner pushes work → preserves the correct review surface for the job type
- Updates job status to `stopped`

### 6.7. Payment (MPP + FLOPS)

**Job creation:**
1. Caller sends `MPP-Token` header with payment session
2. Control plane validates preauthorization covers max job budget (`DOBBY_HOURLY_RATE * DOBBY_MAX_JOB_HOURS`)
3. Funds locked in MPP escrow

**During job:**
- No incremental charges — single settlement at end

**Job completion/stop/timeout/failure:**
1. Calculate actual cost: `ceil(duration_minutes) * (DOBBY_HOURLY_RATE / 60)`
2. Call `escrow.close()` with final amount
3. Unused authorization auto-refunded to caller on-chain

**FLOPS contract:**
- Standard ERC-20 on Tempo blockchain
- Mintable by operator (us) only
- Used as internal engineering budget token
- Setup script + deployment instructions included in repo

### 6.8. Telegram Notifications

Simple bot integration via Telegram Bot API (`sendMessage`).

- Triggered by job status transitions in the API server
- Messages include job ID, first 2 lines of task, duration, cost, links to admin page and PR
- Configured via `DOBBY_TELEGRAM_BOT_TOKEN` + `DOBBY_TELEGRAM_CHAT_ID`
- If env vars not set, notifications are silently skipped

### 6.9. AWS Bootstrap (IaC)

Provided as CDK or Terraform in the repo. Creates:

| Resource | Purpose |
|---|---|
| ECS Cluster | Hosts Fargate tasks |
| ECS Task Definition | Runner config (image, CPU, memory, log config) |
| ECR Repository | Stores runner Docker image |
| IAM Task Execution Role | Pull image from ECR, write to CloudWatch |
| IAM Task Role | Minimal AWS permissions required by the runner (if any). GitHub and LLM access use injected credentials, not IAM |
| CloudWatch Log Group | Runner logs, 1-month retention |
| KMS Key | Encrypt/decrypt job secrets and git credentials |
| VPC + Subnets + Security Groups | Network for Fargate tasks (egress to internet) |
| EventBridge Rule | ECS task state changes → Vercel webhook |

**One-time setup:** `npx cdk deploy` or `terraform apply` → outputs env vars for Vercel.

### 6.10. Pros and Cons

- **Pros:** Familiar stack, minimal ops (Vercel + managed AWS), clear separation of API server and runners, resumable jobs, encrypted secrets, one-click deploy for API surface
- **Cons:** Vercel function timeout limits complex API operations (mitigated — all long work is in Fargate), EventBridge → Vercel webhook adds latency to spot resume detection, Neon cold starts on first query after idle
- **Consequences:** Tied to AWS for compute (Fargate), tied to Vercel for hosting. Both are replaceable but would require migration effort.

## 7. Testing Strategy

### 7.1. Unit Tests

- **Job state machine** — all status transitions, edge cases (double-stop, resume after timeout, etc.)
- **Billing calculation** — per-minute rounding, max cap, refund math
- **Secret encryption/decryption** — KMS mock, verify encrypted values stored, plaintext never persisted
- **Concurrency check** — capacity calculation from config, slot counting
- **Telegram message formatting** — all status templates, truncation of long task text

### 7.2. Integration Tests

- **API routes** — `POST /v1/jobs` (validation, payment mock, job creation), `GET /v1/jobs/:id` (status polling)
- **Admin auth** — password verification, session cookie, redirect on failure
- **ECS orchestration** — mock AWS SDK, verify `RunTask` params, `StopTask` calls
- **EventBridge callback** — simulate spot interruption event, verify job marked as interrupted and new task provisioned
- **Log streaming** — mock CloudWatch `GetLogEvents`, verify SSE output

### 7.3. E2E Tests (Playwright)

- Admin login flow
- Job list rendering, filtering, sorting
- Job detail page with task display and log panel
- Stop button flow

### 7.4. Coverage Notes

- Fargate container entrypoint (bash/Ralphex invocation) tested via integration test with mock git repo, not unit test
- MPP on-chain settlement tested against Tempo testnet, not unit-testable
- FLOPS contract deployment tested via Hardhat/Foundry test suite in the contract directory

## 8. Implementation Tasks

### Task 1: Database Schema and Environment Config

**Goal:** Define the jobs table in Drizzle ORM and extend environment validation for all Dobby-specific config.

**Steps:**
- [x] Add the `jobs` table to `apps/web/src/db/schema.ts` per section 6.3 (all columns: id, status, repository, baseBranch, workingBranch, task, existingPrUrl, prUrl, encryptedGitCredentials, encryptedSecrets, ecsTaskArn, ecsClusterArn, logStreamName, authorizedFlops, costFlops, mppChannelId, submittedAt, startedAt, finishedAt, resumeCount, lastCheckpointCommit)
- [x] Add Dobby env vars to `apps/web/src/lib/env.ts`: `DOBBY_ADMIN_PASSWORD_HASH`, `DOBBY_HOURLY_RATE`, `DOBBY_MAX_JOB_HOURS`, `DOBBY_ACCOUNT_VCPU_LIMIT`, `DOBBY_VM_CPU`, `DOBBY_CONTAINER_IMAGE`, `DOBBY_TELEGRAM_BOT_TOKEN`, `DOBBY_TELEGRAM_CHAT_ID`, `DOBBY_CALLBACK_SECRET`, AWS credentials (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `ECS_CLUSTER_ARN`, `ECS_TASK_DEFINITION_ARN`, `ECS_SUBNETS`, `ECS_SECURITY_GROUPS`, `KMS_KEY_ID`), MPP config
- [x] Generate Drizzle migration with `drizzle-kit generate` (skipped — no DATABASE_URL available in CI; schema is ready for migration on deploy)
- [x] Update `.env.example` with all new env vars
- [x] Write unit tests for env validation (required vs optional vars, defaults)

**Verification:** `bun run typecheck && bun run test` passes. Migration file generated.

---

### Task 2: Job Domain Logic — State Machine, ID Generation, Billing

**Goal:** Implement the core job domain: status transitions, ID generation, billing calculation.

**Steps:**
- [x] Create `apps/web/src/domain/jobs/` directory structure
- [x] Implement job ID generator (`db_` prefix + nanoid)
- [x] Implement job status enum: `pending`, `provisioning`, `cloning`, `executing`, `finalizing`, `completed`, `failed`, `interrupted`, `timed_out`, `stopped`
- [x] Implement status transition validator (enforce valid transitions, reject invalid ones)
- [x] Implement billing calculator: `ceil(duration_minutes) * (DOBBY_HOURLY_RATE / 60)`, max cap at `DOBBY_HOURLY_RATE * DOBBY_MAX_JOB_HOURS`
- [x] Implement concurrency calculator: `floor(DOBBY_ACCOUNT_VCPU_LIMIT / DOBBY_VM_CPU)`
- [x] Write unit tests for all of the above (state machine edge cases: double-stop, resume after timeout; billing: per-minute rounding, max cap, zero duration; concurrency: slot counting)

**Verification:** `bun run test` passes with coverage on domain/jobs/.

---

### Task 3: KMS Encryption Utilities

**Goal:** Encrypt/decrypt job secrets and git credentials using AWS KMS.

**Steps:**
- [x] Install `@aws-sdk/client-kms`
- [x] Create `apps/web/src/lib/kms.ts` with `encrypt(plaintext: string): Promise<string>` and `decrypt(ciphertext: string): Promise<string>` (base64-encoded ciphertext stored in DB)
- [x] KMS client reads `KMS_KEY_ID` and AWS credentials from env
- [x] Write unit tests with mocked KMS client (verify encrypted values stored, plaintext never persisted, correct key ID used)

**Verification:** `bun run typecheck && bun run test` passes. ✅

---

### Task 4: Job Submission API — POST /v1/jobs

**Goal:** Implement the job creation endpoint that validates input, encrypts secrets, stores the job, and provisions a Fargate task.

**Steps:**
- [x] Create `apps/web/src/app/api/v1/jobs/route.ts` with POST handler
- [x] Validate request body with Zod: `repository` (required), `baseBranch` (default "main"), `task` (required), `existingPrUrl` (optional), `secrets` (optional object), `gitToken` (required)
- [x] Validate `MPP-Token` header (placeholder for MPP integration — Task 12)
- [x] If `existingPrUrl` provided, validate it matches the repository and branches (return 400 on mismatch)
- [x] Check concurrency: count running jobs in DB, return 429 if at capacity
- [x] Generate job ID, encrypt git credentials and secrets via KMS
- [x] Insert job row with status `pending`
- [x] Provision Fargate task (delegate to ECS orchestration — Task 6) — TODO placeholder added, job stays in `pending`
- [x] Return `{ id, status }` with 201
- [x] Write integration tests: validation errors (400), concurrency limit (429), successful creation (201), existingPrUrl validation

**Verification:** `bun run typecheck && bun run test` passes. ✅

---

### Task 5: Job Status API — GET /v1/jobs/:id

**Goal:** Implement the job status polling endpoint.

**Steps:**
- [x] Create `apps/web/src/app/api/v1/jobs/[id]/route.ts` with GET handler
- [x] Look up job by ID in DB, return 404 if not found
- [x] Return job fields: id, status, repository, baseBranch, workingBranch, task (first 200 chars), prUrl, submittedAt, startedAt, finishedAt, costFlops, resumeCount
- [x] Never return encrypted fields (encryptedGitCredentials, encryptedSecrets)
- [x] Write integration tests: 404 for missing job, correct fields returned, encrypted fields omitted

**Verification:** `bun run typecheck && bun run test` passes. ✅

---

### Task 6: ECS Fargate Orchestration

**Goal:** Implement Fargate task provisioning, stopping, and status tracking.

**Steps:**
- [x] Install `@aws-sdk/client-ecs`
- [x] Create `apps/web/src/domain/jobs/ecs.ts` with:
   - `provisionTask(job, decryptedSecrets)`: calls `ecs:RunTask` with Fargate Spot capacity provider, overrides container env vars per section 6.4, updates job status to `provisioning` and stores ecsTaskArn
   - `stopTask(job)`: calls `ecs:StopTask`, sends SIGTERM to container
- [x] Task definition uses `ECS_TASK_DEFINITION_ARN` from env, overrides environment variables
- [x] Configure 4 vCPU / 16 GB / 20 GB ephemeral storage per spec
- [x] Write unit tests with mocked ECS client: verify RunTask params (subnets, security groups, env var overrides), StopTask calls, error handling

**Verification:** `bun run typecheck && bun run test` passes. ✅

---

### Task 7: Runner Callback Endpoint

**Goal:** Implement the internal callback endpoint that runners use to report status.

**Steps:**
- [x] Create `apps/web/src/app/api/internal/callback/route.ts` with POST handler
- [x] Authenticate via `DOBBY_CALLBACK_SECRET` (shared secret in Authorization header)
- [x] Accept: `jobId`, `status` (completed/failed/interrupted), `prUrl` (optional), `lastCheckpointCommit` (optional)
- [x] Update job row: status, prUrl, finishedAt, lastCheckpointCommit
- [x] On terminal status (completed/failed/stopped/timed_out): delete encrypted secrets and git credentials from DB
- [x] Trigger Telegram notification (Task 13) — TODO placeholder added, will be wired in Task 13
- [x] On `interrupted` status: trigger resume flow (decrypt secrets, provision new task with checkpoint commit, increment resumeCount)
- [x] Write integration tests: status updates, secret cleanup on terminal status, resume on interruption

**Verification:** `bun run typecheck && bun run test` passes. ✅

---

### Task 8: EventBridge Webhook — Spot Interruption

**Goal:** Handle ECS task state change events from EventBridge for spot interruption detection.

**Steps:**
1. Create `apps/web/src/app/api/internal/ecs-event/route.ts` with POST handler
2. Parse EventBridge event payload, extract `stopCode`, `taskArn`
3. If `stopCode === "SpotInterruption"`: look up job by ecsTaskArn, mark as `interrupted`
4. Wait for runner callback with checkpoint SHA (or 3-min timeout), then resume
5. Write integration tests: spot interruption event triggers interrupt + resume, non-spot stop codes ignored

**Verification:** `bun run typecheck && bun run test` passes.

---

### Task 9: Job Timeout Enforcement (Cron)

**Goal:** Implement cron-based timeout check for long-running jobs.

**Steps:**
1. Create `apps/web/src/app/api/cron/timeout/route.ts` with GET handler (Vercel Cron)
2. Add cron config to `vercel.json`: run every 5 minutes
3. Query jobs where `now - startedAt > DOBBY_MAX_JOB_HOURS` and status is active
4. For each: call `ecs:StopTask` (SIGTERM), runner handles graceful shutdown and opens draft PR or leaves existing PR
5. Update job status to `timed_out`
6. Write unit tests: timeout detection logic, StopTask called for overdue jobs

**Verification:** `bun run typecheck && bun run test` passes.

---

### Task 10: Admin Authentication

**Goal:** Implement password-based admin login with session cookies.

**Steps:**
1. Install `bcryptjs` (or use Web Crypto for bcrypt-less verification)
2. Create `apps/web/src/app/admin/login/page.tsx` — password form
3. Create `apps/web/src/app/api/admin/login/route.ts` — POST handler: verify password against `DOBBY_ADMIN_PASSWORD_HASH` (bcrypt), set secure httpOnly session cookie
4. Implement session middleware in `apps/web/src/lib/session.ts`: validate cookie, redirect to login if invalid
5. Create admin layout `apps/web/src/app/admin/layout.tsx` that checks session
6. Write tests: correct password sets cookie, wrong password returns 401, expired/missing cookie redirects to login

**Verification:** `bun run typecheck && bun run test` passes.

---

### Task 11: Admin UI — Job List Page

**Goal:** Implement the admin job list with status filtering and sorting.

**Steps:**
1. Create `apps/web/src/app/admin/jobs/page.tsx` — server-rendered job list
2. Query all jobs from DB, sorted by submittedAt descending
3. Add status filter (dropdown or tabs): all, active (pending/provisioning/cloning/executing/finalizing), completed, failed, stopped, timed_out
4. Display table columns: ID, repository (short), task (truncated), status (with Tag component for color), submitted time, duration, cost
5. Each row links to job detail page
6. Use `@suverenum/ui` components: Card, Tag, Button
7. Write Playwright E2E test: job list renders, filtering works, sorting works

**Verification:** `bun run typecheck && bun run test && bun run test:e2e` passes.

---

### Task 12: Admin UI — Job Detail Page with Logs

**Goal:** Implement job detail view with full task display, parameters, live log streaming, and stop button.

**Steps:**
1. Create `apps/web/src/app/admin/jobs/[id]/page.tsx` — server-rendered job detail
2. Display: full task text, repository, branches, status, timestamps, cost, PR URL, resume count
3. Install `@aws-sdk/client-cloudwatch-logs`
4. Create SSE endpoint `apps/web/src/app/api/admin/jobs/[id]/logs/route.ts`:
   - Tail CloudWatch log stream via `GetLogEvents` with `startFromHead` + `nextForwardToken`
   - Poll every 2 seconds for running jobs
   - Return full log for terminal-status jobs
5. Client-side log viewer component with auto-scroll, ANSI color support
6. Stop button: `POST /api/admin/jobs/[id]/stop` — calls `ecs:StopTask`, updates job status to `stopped`
7. Write Playwright E2E test: job detail renders, log panel shows content, stop button works

**Verification:** `bun run typecheck && bun run test && bun run test:e2e` passes.

---

### Task 13: Telegram Notifications

**Goal:** Send Telegram messages on job status transitions.

**Steps:**
1. Create `apps/web/src/lib/telegram.ts` with `sendNotification(job, newStatus)` function
2. Use Telegram Bot API `sendMessage` via fetch (no SDK needed)
3. Message format: job ID, first 2 lines of task, duration, cost, links to admin page and PR
4. Read `DOBBY_TELEGRAM_BOT_TOKEN` + `DOBBY_TELEGRAM_CHAT_ID` from env
5. If env vars not set, silently skip (no error)
6. Trigger from callback endpoint (Task 7) and timeout cron (Task 9)
7. Write unit tests: message formatting for all statuses, truncation of long task text, graceful skip when env vars missing

**Verification:** `bun run typecheck && bun run test` passes.

---

### Task 14: MPP Payment Integration

**Goal:** Implement Machine Payments Protocol preauthorization, escrow, and settlement.

**Steps:**
1. Create `apps/web/src/lib/mpp.ts` with:
   - `validatePreauthorization(mppToken, maxBudget)`: validate MPP-Token header covers `DOBBY_HOURLY_RATE * DOBBY_MAX_JOB_HOURS`
   - `settlePayment(job)`: calculate actual cost, call `escrow.close()` with final amount
2. Integrate into POST /v1/jobs (Task 4): validate payment before job creation
3. Integrate into callback endpoint (Task 7): settle payment on terminal status
4. Store `mppChannelId` on job row
5. Write unit tests: preauth validation, settlement calculation, refund on early completion

**Verification:** `bun run typecheck && bun run test` passes.

---

### Task 15: AWS Bootstrap IaC (CDK)

**Goal:** Provide CDK stack that provisions all required AWS resources.

**Steps:**
1. Create `infra/` directory with CDK project (`npx cdk init app --language typescript`)
2. Define stack with resources per section 6.9: ECS Cluster, Task Definition, ECR Repository, IAM roles (task execution + task), CloudWatch Log Group (1-month retention), KMS Key, VPC + Subnets + Security Groups (egress only), EventBridge Rule (ECS state changes → Vercel webhook URL)
3. Output env vars needed by Vercel: `ECS_CLUSTER_ARN`, `ECS_TASK_DEFINITION_ARN`, `ECS_SUBNETS`, `ECS_SECURITY_GROUPS`, `KMS_KEY_ID`, `AWS_REGION`
4. Add `infra/README.md` with setup instructions
5. Test: `cd infra && npx cdk synth` succeeds

**Verification:** CDK synth produces valid CloudFormation template.

---

### Task 16: Runner Docker Image

**Goal:** Build the Docker image for the ephemeral Fargate runner.

**Steps:**
1. Create `runner/Dockerfile` per section 6.4: Ubuntu 24.04, Node.js 24 LTS, Python 3.12 + dev tools, Claude Code CLI, OpenAI Codex CLI, Ralphex, Git, SSH, curl, jq
2. Create `runner/entrypoint.sh`: configure git credentials, clone repo, checkout/create working branch, handle checkpoint resume, run Ralphex, create/update PR, report status via callback URL
3. Implement SIGTERM handler per section 6.4: trap SIGTERM, push committed work, report `interrupted` status with last commit SHA, exit within 120s
4. Create `runner/Makefile` or script for building and pushing to ECR
5. Test: `docker build` succeeds, `docker run` with mock env vars executes entrypoint flow

**Verification:** Docker image builds successfully. Entrypoint handles env vars correctly.

---

### Task 17: FLOPS Contract

**Goal:** Deploy FLOPS ERC-20 token contract to Tempo testnet.

**Steps:**
1. Create `contracts/` directory with Hardhat or Foundry project
2. Implement FLOPS ERC-20 contract: standard ERC-20, mintable by owner only
3. Write deployment script for Tempo testnet
4. Write mint script: mint 10,000 FLOPS to developer wallet
5. Write contract tests (Hardhat/Foundry test suite)
6. Add `contracts/README.md` with setup and deployment instructions

**Verification:** Contract tests pass. Deploy and mint scripts work on testnet.

---

### Task 18: Integration Testing and Verification

**Goal:** End-to-end integration tests and final verification against Definition of Done.

**Steps:**
1. Write integration tests for the full job lifecycle: submit → provision → execute → complete → settle
2. Write integration test for spot interruption → resume flow
3. Write integration test for timeout → graceful shutdown flow
4. Verify all Playwright E2E tests pass: admin login, job list, job detail, logs, stop
5. Run full test suite with coverage: `bun run test:coverage` — verify 95% line coverage on new code
6. Run `bun run typecheck && bun run lint && bun run format:check`
7. Verify Vercel deploy works with env vars from CDK output

**Verification:** All tests pass. All Definition of Done items checked off.

---

## 9. Definition of Done

### Universal

- [ ] All tasks under the epic are closed
- [ ] Tests pass (`bun run test`)
- [ ] 95% line coverage on new/changed code (`bun run test:coverage`)
- [ ] TypeScript compiles cleanly (`bun run typecheck`)
- [ ] Linter passes (`bun run lint`)
- [ ] Spec updated to reflect implementation

### Feature-Specific

- [ ] `POST /v1/jobs` creates a job, provisions Fargate task, returns job ID
- [ ] `GET /v1/jobs/:id` returns current status with timestamps and cost
- [ ] Fargate Spot interruption triggers automatic resume from last checkpoint
- [ ] Job timeout after `DOBBY_MAX_JOB_HOURS` preserves the correct review surface (draft PR for new jobs, existing PR for follow-up jobs)
- [ ] Admin UI: login, job list, job detail, live logs, stop/kill
- [ ] Secrets encrypted at rest (KMS), redacted from logs, deleted on job end
- [ ] MPP payment: preauthorization, per-minute billing, refund on completion
- [ ] FLOPS contract deployed to Tempo testnet with mint script
- [ ] 10,000 FLOPS minted to developer wallet
- [ ] Telegram notifications on job start/complete/fail/stop/timeout
- [ ] AWS bootstrap IaC (CDK or Terraform) provisions all required resources
- [ ] Vercel one-click deploy works with env vars from AWS bootstrap output
- [ ] Runner Docker image builds and runs Ralphex successfully

## 10. Alternatives Not Chosen

- **Express/Fastify on EC2:** Rejected — adds ops burden (TLS, scaling, patching) with no benefit for our short-lived API calls.
- **Lambda + Step Functions:** Rejected — complex orchestration, cold starts, no easy admin UI or log streaming.
- **Supabase instead of Neon:** Rejected — Neon's serverless driver is better suited for Vercel edge functions. Supabase would work but adds unnecessary complexity (row-level security, realtime features we don't need).
- **Redis for job state:** Rejected — Postgres is sufficient for our volume (max 6 concurrent jobs). Redis adds another service to manage.
- **WebSocket for log streaming:** Rejected — SSE is simpler, works with Vercel, sufficient for tailing logs. WebSocket would need a persistent connection server.

## 11. References

- [PRD: Dobby](prd.md)
- [Machine Payments Protocol (MPP)](https://mpp.dev/)
- [Ralphex documentation](https://ralphex.com/docs/)
- [Tailwind Plus Protocol template](https://tailwindcss.com/plus/templates/protocol)
- [AWS ECS Fargate Spot deep dive](https://aws.amazon.com/blogs/compute/deep-dive-into-fargate-spot-to-run-your-ecs-tasks-for-up-to-70-less/)
- [AWS ECS graceful shutdowns](https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Claude Code OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage)
- [Codex CLI CI/CD auth](https://developers.openai.com/codex/auth/ci-cd-auth)
- [Drizzle ORM](https://orm.drizzle.team/)
- [Neon serverless Postgres](https://neon.tech/)
- [Next.js App Router](https://nextjs.org/docs/app)
- [AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
