# PRD: Dobby — Ephemeral AI Coding Service

## 1. Meta Information

- **Branch:** TBD
- **Epic:** TBD
- **Repository:** Greenfield project — will be implemented in a separate, new repository

## 2. What

An HTTP API with stateless job runners and a persistent API server. The API accepts a coding task, a GitHub repository, a base branch, and a working branch — and returns a pull request URL. Optionally, a caller can attach a follow-up job to an existing PR instead of opening a new one. The API server stores job metadata, billing state, encrypted job secrets, encrypted git credentials, and logs long enough to support polling, retries, resume after interruption, and an internal admin UI. For each job, the service provisions an ephemeral AWS Fargate container, runs Ralphex (wrapping Claude Code and Codex), and destroys the container on completion. Payment is per job in FLOPS via MPP. The operator deploys the API/admin surface to Vercel and points it at preconfigured AWS resources. The caller does not manage infrastructure.

## 3. Motivation

To get an AI coding agent to work on your repo today, you need to manage compute, provision environments, handle API tokens for LLM providers, and wire up git access — before any code gets written. You're paying for seats, managing infrastructure, or both.

What's missing is a simple caller-facing API: give it a task, a GitHub repo, a base branch, and a working branch — get a PR back. Pay per job. Don't think about containers, model tokens, or environment setup.

### Existing Solutions

- **Devin API** (cognition.ai) — REST API for task→PR and session automation. Not self-hostable. Uses organization/service-user setup and ACU-based billing ($2.25/ACU on Core, bundled ACUs on Teams).
- **Google Jules API** — REST API for task→PR, currently in alpha. Not self-hostable. Requires Jules source setup via the Jules web app and GitHub app, pricing not yet clearly documented.
- **Sweep AI** — GitHub App that turns issues into PRs. No direct HTTP API. Seat-based pricing ($10–60/mo).
- **OpenHands** — Open-source, self-hostable, but not a service. You provision your own compute and LLM API keys.
- **Ralphex** — Local CLI tool with multi-agent review. No API, no hosted service — runs entirely on your machine.
- **E2B / Modal / Fly.io** — Raw compute infrastructure. You build the agent orchestration yourself.

All existing solutions either require you to manage infrastructure, lock you into a vendor-specific workspace or account model, or don't expose a simple task→PR API.

### Competitive Landscape

| | Dobby | Devin API | Google Jules API | Sweep AI | OpenHands |
|---|---|---|---|---|---|
| **API: task→PR** | Yes | Yes | Yes (alpha) | No (GitHub App) | No (manual) |
| **Caller needs a persistent session** | No | Yes | Yes | No | No |
| **Self-hostable** | Yes (provided AWS bootstrap + deploy) | No | No | Partial | Yes (manage infra) |
| **Pay-per-job** | Yes | $2.25/ACU or bundled ACUs | TBD (alpha) | Seat ($10–60/mo) | Free (you pay LLM + compute) |
| **Caller provides repo creds** | Yes | No (workspace/service-user setup) | No (Jules source + GitHub app setup) | No (GitHub App) | N/A (local) |
| **Deploy effort** | AWS bootstrap + env vars + Vercel | N/A | N/A | GitHub App install | Docker + LLM keys + infra |

## 4. User Stories

### Caller (engineer submitting jobs)

1. As a caller, I want to POST a task, GitHub repo URL, base branch, and working branch and get a PR back so that I don't have to provision any infrastructure to run coding agents.
2. As a caller, I want to pass secrets needed for the task so that the agent can run tests and builds that require credentials.
3. As a caller, I want to poll job status so that I know when my PR is ready without blocking.
4. As a caller, I want to pay per job in FLOPS so that spending is tracked per task against our engineering budget.
5. As a caller, I want the agent to follow validation guardrails already in the repo so that I don't need to specify test/lint commands separately.
6. As a caller, I want a stable job ID and poll URL so that I can track the job I submitted from my own tooling without blocking.
7. As a caller, I want to optionally point a follow-up job at an existing PR so that review comments can be addressed on the same branch instead of opening a duplicate PR.

### Operator (us, deploying the service)

8. As an operator, I want to deploy in minutes by applying the included AWS bootstrap template and setting env vars so that infrastructure setup is bounded and repeatable.
9. As an operator, I want a one-click Vercel deployment option for the API/admin surface once AWS bootstrap is complete so that I can get running quickly.
10. As an operator, I want to configure payment (wallet, FLOPS contract, hourly rate) so that I can control internal billing.
11. As an operator, I want to specify a custom Docker image for the job runner so that I can control the agent environment.
12. As an operator, I want to configure the VM type/size for job containers so that I can balance cost and performance.
13. As an operator, I want a simple internal admin page to view all jobs (status, duration, task, logs) so that I can track what's running and what's done.

## 5. User Flow

### Job Execution Flow

```
Caller                    Dobby API Server                 AWS Fargate
   │                                │                               │
   │ POST /v1/jobs (task, repo,     │                               │
   │   base_branch, working_branch, │                               │
   │   creds, secrets, optional     │                               │
   │   existing_pr_url)             │                               │
   │ + MPP auth for max job budget  │                               │
   │ ──────────────────────────►    │                               │
   │                                │  validate payment auth        │
   │                                │  persist job + encrypted      │
   │                                │  secrets + git credentials    │
   │                                │  provision ECS Spot task      │
   │                                │ ─────────────────────────►    │
   │    { job_id, status, poll_url }│                               │
   │ ◄──────────────────────────    │                               │
   │                                │                               │ clone repo
   │                                │                               │ create or checkout working branch
   │                                │                               │ inject secrets
   │                                │                               │ run Ralphex
   │ GET /v1/jobs/:id (polling)     │                               │ (1-8 hours)
   │ ──────────────────────────►    │                               │
   │    { status: "executing" }     │                               │
   │ ◄──────────────────────────    │                               │
   │                                │                               │ create PR if needed
   │                                │    PR URL + completion        │
   │                                │ ◄─────────────────────────    │
   │                                │  settle final payment         │
   │                                │  delete encrypted secrets     │
   │                                │  and git credentials          │
   │                                │  terminate container          │
   │ GET /v1/jobs/:id               │                               │
   │ ──────────────────────────►    │                               │
   │    { status: "completed",      │                               │
   │      pr_url: "..." }          │                               │
   │ ◄──────────────────────────    │                               │
```

### Spot Interruption Flow

```
AWS sends SIGTERM (2-min notice) → Agent pushes latest safe checkpoint → Container terminates
→ Dobby provisions new Fargate Spot task → Agent clones and resumes from the last pushed checkpoint → Continues
```

### Job Statuses

```
pending → provisioning → cloning → executing → finalizing → completed
                                             → interrupted → provisioning (resume)
                                             → timed_out
                                             → stopped (manual kill)
                                             → failed (at any stage)
```

| Status | Description |
|---|---|
| `pending` | Payment validated, waiting for Fargate capacity under the operator's configured concurrency limit |
| `provisioning` | ECS Spot task being created |
| `cloning` | Container up, cloning repo and setting up branch |
| `executing` | Agent running the task |
| `finalizing` | Agent done, opening a new PR if needed or finalizing an existing PR job before completion |
| `completed` | Final PR URL recorded, container terminated, payment settled |
| `failed` | Unrecoverable error (bad credentials, clone failed, agent crashed) |
| `timed_out` | Hit 8hr limit. Partial work preserved by opening a draft PR for a new job or leaving the existing PR as the review surface for a follow-up job |
| `interrupted` | Spot reclaimed, last pushed checkpoint preserved, resuming in new container |
| `stopped` | Manually killed via admin page. Commits pushed and the appropriate review surface preserved for the job type |

**Note:** If all configured runner slots are full, the API returns a `429 Too Many Requests` error — no job is created, no status is assigned. Default configuration is 6 concurrent jobs with `4 vCPU` runners on a `32 vCPU` account limit.

## 6. Definition of Done

1. Given a valid POST to `/v1/jobs` without `existing_pr_url` and with task, GitHub repo, base branch, working branch, and git credentials, When the job completes, Then a PR is opened from the working branch into the base branch.
2. Given a valid POST to `/v1/jobs` with `existing_pr_url`, When the referenced PR matches the provided repo and branches and the job completes, Then new commits are pushed to that existing PR branch and the same `pr_url` is returned rather than opening a duplicate PR.
3. Given a job is in progress, When the caller polls `GET /v1/jobs/:id`, Then the current status is returned.
4. Given the caller includes secrets and git credentials in the job request, When the job runs and later terminates, Then both are stored only in encrypted form for the lifetime of the job, are redacted from logs, and are deleted when the job finishes, fails, times out, or is stopped.
5. Given a Fargate Spot interruption (SIGTERM), When the container receives the signal, Then the latest pushed checkpoint is preserved before termination and a new container resumes from that checkpoint using the encrypted job secrets and git credentials retained by the API server.
6. Given a job exceeds the max lifetime (`DOBBY_MAX_JOB_HOURS`, default `8`), When the timeout fires, Then the agent pushes commits and either opens a draft PR for a new job or leaves the existing PR as the review surface for a follow-up job.
7. Given the caller's FLOPS preauthorization is insufficient, When they POST a job, Then the API returns a payment error before provisioning.
8. Given the operator has completed the required AWS bootstrap and set env vars, When they deploy the API/admin surface to Vercel, Then the service is operational and accepting jobs.
9. Given the configured runner capacity is already fully consumed, When another job is submitted, Then the API returns a capacity error.
10. Given an operator navigates to the admin page and enters the correct password, When they view the job list, Then they see all jobs with ID, status, timestamps, duration, task, and log access.
11. Given an incorrect password, When an operator tries to access the admin page, Then access is denied.
12. Given a running job, When an operator clicks stop/kill in the admin page, Then the container is terminated, commits are pushed, and either a draft PR is opened for a new job or the existing PR remains the review surface for a follow-up job.
13. Given a running job, When an operator views its logs in the admin page, Then they see live-streaming container output with configured secret redaction applied.
14. Given a Telegram bot token and chat ID are configured, When a job starts, completes, fails, stops, or times out, Then a notification is sent to the configured Telegram chat.
15. Given a configured FLOPS contract and operator wallet, When a job completes, stops, times out, or fails, Then the final billing outcome and any refund are settled and recorded on the job according to the failure policy.

## 7. Out of Scope

- External customers — internal use only (us), paying in FLOPS
- Caller-selectable agent — agent is fixed by operator config, not per-job
- Caller-provided LLM API keys — operator manages all keys
- Real stablecoin payments (USDC, etc.) — FLOPS only
- Multi-cloud support (GCP, Azure) — AWS Fargate only for now
- Advanced admin features (analytics, user management, role-based access)
- SDK (Python, TypeScript) — API-first, SDKs later

## 8. References

- [Machine Payments Protocol (MPP)](https://mpp.dev/)
- [Ralphex](https://ralphex.com/) — autonomous Claude Code loop for plan execution and code review
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Codex CLI CI/CD auth](https://developers.openai.com/codex/auth/ci-cd-auth)
- [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/)
- [Devin API](https://docs.devin.ai/api-reference/overview)
- [Google Jules API](https://developers.google.com/jules/api)
- [E2B sandboxes](https://e2b.dev/)

## 9. FAQs

**Can callers pick a custom container?**
No. The operator configures the container image (via Docker registry URL). We provide a pre-built image. This is an operator-level setting, not per-job.

**Can callers pick VM type/size?**
Not yet. VM type/size is set by the operator in config. May be exposed via API later.

**Can callers bring their own LLM API keys?**
No. LLM API keys are set by the operator. The caller pays per job and doesn't manage keys.

**What git credentials does the caller pass?**
A **GitHub Fine-Grained Personal Access Token** (PAT). The caller creates one at GitHub Settings → Developer settings → Fine-grained tokens with:
- **Repository access:** Only select repositories (the target repo)
- **Permissions:** Contents: Read & Write, Pull requests: Read & Write
- **Expiration:** Up to 366 days

The token is passed as `git_credentials` in the job request. The container uses it for `git clone`, `git push`, and GitHub API calls (create PR). Deploy keys and SSH keys are not supported — they can't create PRs via the GitHub API.

**Can the operator use Claude/Codex subscriptions instead of API keys?**
Yes. Both support subscription-based auth in containers, avoiding per-token API billing:
- **Claude Code:** Follow Anthropic's current headless/container authentication guidance and set `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in operator-managed secrets.
- **Codex CLI:** API keys are preferred for automation. If the operator chooses ChatGPT-managed Codex auth instead, seed the runner with `~/.codex/auth.json` and persist the refreshed file between jobs on trusted infrastructure.

Do not rely on short-lived interactive login state inside ephemeral containers. Subscription-based auth only works if the operator follows the vendor's supported headless/container flow and persists any refreshed credentials outside the runner.

**How does payment work?**
At job creation, the caller preauthorizes the operator-configured max job budget (default: 8 hours at the configured hourly rate). The job is billed per minute, and the unused authorized amount is refunded on-chain via MPP escrow when the job completes, stops, or times out. Example at `5 FLOPS/hr`: authorize `40.00`, run for `2h 40m`, charge `13.33`, refund `26.67`.

**What happens if a job fails?**
Failed jobs are billed only for elapsed runtime up to the failure point, with unused authorized funds refunded via MPP escrow. Example at `5 FLOPS/hr`: if the job fails after `6m`, charge `0.50`, refund the remainder. If the failure occurs before the runner starts (for example, payment validation or capacity rejection), no job is created and no charge is captured.

**What happens on Fargate Spot interruption?**
AWS sends SIGTERM with a 2-minute warning. Agent progress that has been pushed to git is preserved. Dobby provisions a new container and the agent resumes from the last pushed checkpoint. Uncommitted in-memory work may be lost unless the runner checkpointed it before interruption.

**How many concurrent jobs?**
Concurrency is derived from the operator's configured runner size and available AWS account quota. Default configuration is max 6 concurrent jobs (`4 vCPU` runners on a `32 vCPU` account limit). If no capacity is available, the API returns an error and the caller retries later.

## 10. Appendix

### A. API Design

#### Create Job

```http
POST /v1/jobs
MPP-Token: <payment-session-token>
Content-Type: application/json

{
  "repository": "https://github.com/org/repo.git",
  "base_branch": "main",
  "working_branch": "dobby/fix-login-bug",
  "task": "## Fix login bug\n\nUsers report 500 error when...",
  "git_credentials": "github_pat_xxxxxxxxxxxx",
  "secrets": {
    "DATABASE_URL": "postgres://...",
    "API_KEY": "sk_live_..."
  },
  "existing_pr_url": null
}
```

`existing_pr_url` is optional. When provided, the job resumes work against that existing PR and pushes additional commits to the same working branch instead of opening a new PR. The `repository`, `base_branch`, and `working_branch` fields must match the existing PR metadata or the request is rejected with `400 Bad Request`.

**Response:**
```json
{
  "job_id": "db_abc123",
  "status": "pending",
  "authorized_flops": "40.00",
  "poll_url": "/v1/jobs/db_abc123"
}
```

#### Job Status

```http
GET /v1/jobs/db_abc123
```

```json
{
  "job_id": "db_abc123",
  "status": "completed",
  "pr_url": "https://github.com/org/repo/pull/42",
  "submitted_at": "2026-03-19T10:00:00Z",
  "finished_at": "2026-03-19T12:40:00Z",
  "duration_seconds": 9600,
  "cost_flops": "13.33"
}
```

### B. Deployment Configuration

```bash
git clone https://github.com/org/dobby
cp .env.example .env

# AWS
DOBBY_AWS_REGION=us-east-1
DOBBY_AWS_ACCESS_KEY_ID=...
DOBBY_AWS_SECRET_ACCESS_KEY=...
DATABASE_URL=...                  # Persistent job/billing state
DOBBY_KMS_KEY_ID=...            # Encrypt per-job secrets at rest

# LLM Authentication (pick one per provider)
CLAUDE_CODE_OAUTH_TOKEN=...      # Claude headless/container auth (optional)
ANTHROPIC_API_KEY=...            # OR Anthropic API key (pay-per-token)
CODEX_AUTH_JSON=...              # Codex trusted-runner auth cache (optional)
OPENAI_API_KEY=...               # OR OpenAI API key (pay-per-token)

# Payment
DOBBY_WALLET_ADDRESS=0x...
DOBBY_FLOPS_CONTRACT=0x...   # FLOPS token contract address
DOBBY_HOURLY_RATE=5            # FLOPS per hour
DOBBY_MAX_JOB_HOURS=8          # Runtime cap used for timeout and default authorization

# Admin
DOBBY_ADMIN_PASSWORD_HASH=...  # bcrypt hash of admin password
DOBBY_TELEGRAM_BOT_TOKEN=...  # Telegram bot token for notifications
DOBBY_TELEGRAM_CHAT_ID=...    # Telegram chat/group ID

# Container
DOBBY_CONTAINER_IMAGE=...      # Docker registry URL (optional, we provide default)
DOBBY_VM_CPU=4                 # vCPUs for job containers
DOBBY_VM_MEMORY=16384          # Memory in MB (16 GB)
DOBBY_ACCOUNT_VCPU_LIMIT=32    # Account quota used to derive max concurrency
```

Deploy the API/admin surface to Vercel with one click, or `docker compose up -d` for self-managed hosting.

Required AWS bootstrap, provided as repo-managed IaC or created ahead of time:
- ECS cluster and Fargate task definition for the runner
- Task execution role, task role, and least-privilege IAM policies
- Networking for tasks (subnets, security groups, egress)
- CloudWatch log group for runner logs
- KMS-backed secret storage for encrypted per-job secrets

Vercel hosts the HTTP API and admin UI. AWS hosts the job runners and supporting runtime infrastructure.

### C. Operator Cost Model

**All-in cost: ~$4–5 per hour per job.** LLM tokens are ~90% of the cost.

| Duration | Compute (Fargate Spot) | LLM (Opus ~$3/hr) | **Total** |
|---|---|---|---|
| **1 hour** | ~$0.12 | ~$3 | **~$3–5** |
| **3 hours** | ~$0.35 | ~$9 | **~$9–14** |
| **6 hours** | ~$0.70 | ~$18 | **~$19–24** |
| **8 hours** | ~$0.93 | ~$24 | **~$25–32** |

Ralphex's 5 parallel review agents add ~$2–5 in LLM calls on top.

**Compute:** Fargate Spot 4 vCPU / 16 GB. On-demand $0.23/hr, Spot ~$0.12/hr. Billed per second, 1-min minimum. 20 GB ephemeral storage free.

**LLM:** Opus 4.6 — $15/M input, $75/M output (incl. thinking), $1.50/M cache reads. Thinking tokens at $75/M are the biggest cost driver. ~$3/hr with warm cache, ~$5/hr cold.

**Container image:** ~840 MB. Ubuntu 24.04 (150 MB) + Node.js 24 LTS (193 MB) + Claude Code (56 MB) + Python 3.12 (334 MB) + Codex CLI (1 MB) + Ralphex (1 MB) + Git/SSH/curl (28 MB) + dev tools (75 MB).

### D. Token Usage Observability

Both Claude Code and Codex CLI support **OpenTelemetry** natively.

| Agent | Key metrics | Configuration |
|---|---|---|
| **Claude Code** | `claude_code.token.usage`, `claude_code.cost.usage` (USD) | `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp` |
| **Codex CLI** | `input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens` | `[otel]` section in `~/.codex/config.toml` |

Dobby container sets OTel env vars pointing to operator's collector for internal cost tracking and monitoring.

### E. Secrets and Git Credentials

Secrets and git credentials are never stored in plaintext and are retained only for the lifetime of the job:
1. Caller passes secrets and `git_credentials` in the job request
2. Control plane encrypts them at rest so a resumed job can be relaunched after interruption
3. Runtime injects only the values needed by the ephemeral container
4. Logs are redacted before storage/display
5. Encrypted materials are deleted when the job completes, fails, times out, or is manually stopped

Security: callers send raw secret values and git credentials over TLS, the API server encrypts them before persistence, log sinks apply redaction, containers are isolated, and IAM is scoped to only the AWS resources needed by the API server and ECS task.

### F. Admin Page

Simple operator-only password-protected page to view jobs. No user management — single shared password stored as hashed env var.

**Auth:** `DOBBY_ADMIN_PASSWORD_HASH` in Vercel env vars (bcrypt hash). Browser prompts for password, session cookie after login.

#### Screen 1: Login

```
┌──────────────────────────────────────────┐
│              Dobby Admin               │
│                                          │
│  Password: [••••••••••••]                │
│                                          │
│            [ Log in ]                    │
│                                          │
└──────────────────────────────────────────┘
```

#### Screen 2: Job List

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Dobby Admin                                                    [ Filter ▾ ]  │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Status: [ All ▾ ]                                                              │
├────────┬───────────┬─────────────┬─────────────┬────────┬───────────────────────┤
│ Job ID │ Status    │ Submitted   │ Duration    │ FLOPS │ Repository            │
├────────┼───────────┼─────────────┼─────────────┼────────┼───────────────────────┤
│ db_007 │ 🟢 execu │ 19 Mar 14:  │ 1h 23m (li │ ~7 suv │ org/repo-a            │
│        │  ting     │  02         │  ve)        │ (live) │ fix-auth-bug          │
│        │           │             │             │        │ [Logs] [Stop]         │
├────────┼───────────┼─────────────┼─────────────┼────────┼───────────────────────┤
│ db_006 │ ✅ compl │ 19 Mar 10:  │ 2h 40m      │ 13.33  │ org/repo-b            │
│        │  eted     │  00         │             │        │ add-payments → PR #42 │
│        │           │             │             │        │ [Logs]                │
├────────┼───────────┼─────────────┼─────────────┼────────┼───────────────────────┤
│ db_005 │ ❌ faile │ 18 Mar 16:  │ 0h 02m      │ 0.17   │ org/repo-c            │
│        │  d        │  30         │             │        │ refactor-db           │
│        │           │             │             │        │ [Logs]                │
├────────┼───────────┼─────────────┼─────────────┼────────┼───────────────────────┤
│ db_004 │ ⏸ stopp │ 18 Mar 09:  │ 4h 12m      │ 21.00  │ org/repo-a            │
│        │  ed       │  15         │             │        │ new-feature → Draft   │
│        │           │             │             │        │ [Logs]                │
└────────┴───────────┴─────────────┴─────────────┴────────┴───────────────────────┘
```

#### Screen 3: Job Detail

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  ← Back to jobs                                                                 │
│                                                                                 │
│  Job db_007                                              Status: 🟢 executing   │
│                                                                                 │
│  Repository:  github.com/org/repo-a                                             │
│  Branch:      fix-auth-bug (from main)                                          │
│  Submitted:   19 Mar 2026, 14:02 UTC                                            │
│  Duration:    1h 23m (running)                                                  │
│  Cost:        ~7 FLOPS (running)                                                │
│  PR:          —                                                                 │
│                                                                                 │
│  ┌─ Task ──────────────────────────────────────────────────────────────────┐     │
│  │ ## Fix authentication bug                                              │     │
│  │                                                                        │     │
│  │ Users report 500 error when resetting password. The token              │     │
│  │ validation in auth middleware doesn't handle expired tokens...          │     │
│  └────────────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
│                                                        [ Stop Job ]             │
│                                                                                 │
│  ┌─ Live Logs ─────────────────────────────────────────────────────────────┐    │
│  │ 14:02:01  Cloning repository...                                        │    │
│  │ 14:02:05  Creating branch fix-auth-bug from main                       │    │
│  │ 14:02:06  Starting Ralphex...                                          │    │
│  │ 14:02:08  [ralphex] Loading plan from task...                          │    │
│  │ 14:02:10  [ralphex] Task 1/3: Investigate token validation             │    │
│  │ 14:15:22  [ralphex] Task 1/3: Complete ✓                              │    │
│  │ 14:15:23  [ralphex] Committing progress...                             │    │
│  │ 14:15:25  [ralphex] Task 2/3: Fix expired token handling               │    │
│  │ 15:20:44  [ralphex] Task 2/3: Complete ✓                              │    │
│  │ 15:20:45  [ralphex] Task 3/3: Add regression tests                    │    │
│  │ 15:25:01  [claude] Running: npm test                                   │    │
│  │ 15:25:12  [claude] 47 tests passed, 0 failed                          │    │
│  │ █                                                              (live)  │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

#### Screen 4: Completed Job (with PR link)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  ← Back to jobs                                                                 │
│                                                                                 │
│  Job db_006                                              Status: ✅ completed   │
│                                                                                 │
│  Repository:  github.com/org/repo-b                                             │
│  Branch:      add-payments (from main)                                          │
│  Submitted:   19 Mar 2026, 10:00 UTC                                            │
│  Finished:    19 Mar 2026, 12:40 UTC                                            │
│  Duration:    2h 40m                                                            │
│  Cost:        13.33 FLOPS                                                      │
│  PR:          github.com/org/repo-b/pull/42                                     │
│                                                                                 │
│  ┌─ Task ──────────────────────────────────────────────────────────────────┐     │
│  │ ## Add payment processing                                              │     │
│  │                                                                        │     │
│  │ Integrate Stripe payment processing for subscription billing...        │     │
│  └────────────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
│  ┌─ Logs ──────────────────────────────────────────────────────────────────┐    │
│  │ 10:00:01  Cloning repository...                                        │    │
│  │ 10:00:04  Creating branch add-payments from main                       │    │
│  │ 10:00:05  Starting Ralphex...                                          │    │
│  │ ...                                                                    │    │
│  │ 12:39:50  [ralphex] All tasks complete. Creating PR...                 │    │
│  │ 12:39:55  PR created: github.com/org/repo-b/pull/42                   │    │
│  │ 12:40:00  Container terminating.                                       │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### G. Ralphex Configuration

Ralphex must be configured to **retry on token rate limits** when using subscription tokens (Claude Pro/Max, Codex subscription). Subscription plans have hourly token caps — Ralphex has built-in retry/wait functionality for this. The container image should ship with this enabled by default so jobs don't fail when hitting the limit, they just pause and resume.

### H. Telegram Notifications

Dobby sends updates to a configured Telegram chat via bot API.

**Env vars:**
- `DOBBY_TELEGRAM_BOT_TOKEN` — Telegram bot token
- `DOBBY_TELEGRAM_CHAT_ID` — Target chat/group ID

**Messages:**

Job started:
```
🧦 Dobby started working on task #db_abc123

Fix authentication bug
Users report 500 error on password reset

[View job](https://dobby.example.com/admin/jobs/db_abc123)
```

Job completed:
```
✅ Dobby completed task #db_abc123 in 2h 40m

Fix authentication bug
Users report 500 error on password reset

Cost: 13.33 FLOPS
[View PR](https://github.com/org/repo-a/pull/42) · [View job](https://dobby.example.com/admin/jobs/db_abc123)
```

Job failed:
```
❌ Dobby failed task #db_abc123 after 0h 02m

Fix authentication bug
Users report 500 error on password reset

Error: Clone failed — invalid git credentials
[View job](https://dobby.example.com/admin/jobs/db_abc123)
```

Job stopped:
```
⏸ Dobby was stopped on task #db_abc123 after 4h 12m

Fix authentication bug
Users report 500 error on password reset

Cost: 21.00 FLOPS
[View draft PR](https://github.com/org/repo-a/pull/43) · [View job](https://dobby.example.com/admin/jobs/db_abc123)
```

Job timed out:
```
⏰ Dobby timed out on task #db_abc123 after 8h 00m

Fix authentication bug
Users report 500 error on password reset

Cost: 40.00 FLOPS
[View draft PR](https://github.com/org/repo-a/pull/44) · [View job](https://dobby.example.com/admin/jobs/db_abc123)
```

### I. Decisions

- **Partial completion** — On timeout, agent pushes commits and opens a **draft PR** for a new job. For a follow-up job with `existing_pr_url`, the same PR remains the review surface.
- **Concurrent jobs** — Derived from `DOBBY_VM_CPU` and `DOBBY_ACCOUNT_VCPU_LIMIT`. Default is **6** concurrent jobs (`4 vCPU` runners on a `32 vCPU` account limit). No capacity → error, retry later.
- **Log retention** — CloudWatch, 1 month.
- **PR review integration** — Follow-up job can pass `existing_pr_url`. The provided `repository`, `base_branch`, and `working_branch` must match that PR or the request is rejected. Agent picks up review comments and pushes fixes to the same working branch. This requires the prior job record and PR metadata to remain in the API server.
- **Customer** — Internal only (us). Paying in FLOPS. No external customers for now.
