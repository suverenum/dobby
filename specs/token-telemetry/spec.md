# Technical Specification: Token Usage & Real Cost Tracking

## 1. Meta Information

- **Branch:** `feat/token-telemetry`
- **Epic:** TBD
- **PRD:** N/A (internal cost visibility)

## 2. Context

Dobby uses AWS Bedrock (Claude Opus 4) which charges per token. Currently there is zero visibility into actual costs — the existing FLOPS per-minute billing model is a placeholder for future MPP integration and doesn't reflect real spend. We need to replace it with actual token-based cost tracking.

## 3. Key Technical Drivers

- **Real cost:** Track actual AWS Bedrock cost per job in USD
- **Token visibility:** Know input/output/cache token counts per job
- **Incremental accumulation:** Jobs can span multiple containers (Spot interruptions), tokens must accumulate across runs
- **Simplicity:** Remove unused FLOPS billing logic, replace with real cost
- **Backward compatibility:** Existing jobs keep their data, new fields are nullable

## 4. Current State

### 4.1. Billing Model (to be removed)

Time-based FLOPS: `ceil(duration_minutes) * (DOBBY_HOURLY_RATE / 60)`, capped at `DOBBY_HOURLY_RATE * DOBBY_MAX_JOB_HOURS`.
- Files: `apps/web/src/domain/jobs/billing.ts`, `apps/web/src/lib/mpp.ts`
- Env vars: `DOBBY_HOURLY_RATE`, `DOBBY_MAX_JOB_HOURS`, `MPP_ENDPOINT`, `MPP_API_KEY`
- DB fields: `authorizedFlops`, `costFlops`, `mppChannelId`

### 4.2. Callback Schema

The runner sends `{jobId, status, prUrl?, lastCheckpointCommit?, ecsTaskArn?}` — no token data.
- File: `apps/web/src/app/api/internal/callback/route.ts`

### 4.3. Runner

Bash entrypoint runs `opencode run "..."`. Output goes to CloudWatch via ECS awslogs driver.
- File: `runner/entrypoint.sh`
- Dependencies available: `jq`, `sqlite3` (both in Dockerfile)

### 4.4. AWS Bedrock Pricing (Anthropic models, on-demand, us-east-1)

| Model | Input /1M | Output /1M | Cache write (5m) /1M | Cache write (1h) /1M | Cache read /1M |
|-------|-----------|------------|----------------------|----------------------|----------------|
| Claude Sonnet 4 | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| Claude Sonnet 4 Long Context | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| Claude Opus 4 | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 |
| Claude Opus 4 Long Context | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 |

We currently use Claude Opus 4 (Bedrock model ID: `us.anthropic.claude-opus-4-6-v1`, the `-6` is a Bedrock version suffix, not the model name).

## 5. Proposed Solution

Replace FLOPS billing with real token-based cost tracking. The runner queries OpenCode's SQLite database after execution, sends token counts in the callback, and the web app calculates and stores the actual Bedrock cost in USD.

### 5.1. DB Schema Changes

**Remove** old billing columns:
- `authorizedFlops` (note: currently `NOT NULL` — deploy code changes before running migration)
- `costFlops`
- `mppChannelId`

**Add** token tracking columns to the `jobs` table:

```ts
// In Drizzle schema (apps/web/src/db/schema.ts):
inputTokens: integer("input_tokens"),
outputTokens: integer("output_tokens"),
cacheReadTokens: integer("cache_read_tokens"),
cacheWriteTokens: integer("cache_write_tokens"),
bedrockCostUsd: numeric("bedrock_cost_usd", { precision: 12, scale: 6 }),
containerCostUsd: numeric("container_cost_usd", { precision: 12, scale: 6 }),
costUsd: numeric("cost_usd", { precision: 12, scale: 6 }), // total: bedrock + container
```

All nullable — existing jobs keep null values. Token counts use `integer` (max ~2.1 billion, sufficient for per-job usage).

**Deployment order:** Deploy code changes first (remove column from INSERT/SELECT), then run migration to drop old columns. This avoids INSERT failures from referencing dropped columns.

### 5.2. Remove FLOPS Billing

**Delete files:**
- `apps/web/src/domain/jobs/billing.ts`
- `apps/web/src/domain/jobs/billing.test.ts`
- `apps/web/src/lib/mpp.ts`
- `apps/web/src/lib/mpp.test.ts`

**Remove from env.ts:**
- `DOBBY_HOURLY_RATE`
- `DOBBY_MAX_JOB_HOURS`
- `MPP_ENDPOINT`
- `MPP_API_KEY`

**Remove FLOPS/MPP logic from:**
- `apps/web/src/app/api/v1/jobs/route.ts` (preauthorization, maxBudget, settlement, MPP-Token auth path)
- `apps/web/src/app/api/v1/jobs/route.test.ts` (authorizedFlops, mppChannelId in fixtures)
- `apps/web/src/app/api/internal/callback/route.ts` (costFlops calculation, MPP settlement)
- `apps/web/src/app/api/internal/callback/route.test.ts` (costFlops, mppChannelId in fixtures)
- `apps/web/src/app/api/admin/jobs/[id]/stop/route.ts` (costFlops calculation, MPP settlement, revert path)
- `apps/web/src/app/api/admin/jobs/[id]/stop/route.test.ts` (costFlops, mppChannelId in fixtures)
- `apps/web/src/app/api/cron/timeout/route.ts` (costFlops calculation, MPP settlement, revert path)
- `apps/web/src/app/api/cron/timeout/route.test.ts` (costFlops, authorizedFlops in fixtures)
- `apps/web/src/app/api/internal/ecs-event/route.test.ts` (authorizedFlops, costFlops, mppChannelId in fixtures)
- `apps/web/src/app/api/v1/jobs/[id]/route.ts` (costFlops in response)
- `apps/web/src/app/api/v1/jobs/[id]/route.test.ts` (costFlops in fixtures)
- `apps/web/src/domain/jobs/index.ts` (barrel exports for billing functions)
- `apps/web/src/domain/jobs/ecs.test.ts` (authorizedFlops, costFlops, mppChannelId in fixtures)

**Update `TelegramNotificationJob` interface:**
- `apps/web/src/lib/telegram.ts` — remove `costFlops`, add `inputTokens`, `outputTokens`, `costUsd`
- `apps/web/src/lib/telegram.test.ts` — update fixtures

### 5.3. Cost Calculation

New file: `apps/web/src/domain/jobs/cost.ts`

#### Bedrock Cost (token-based)

```ts
interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

interface BedrockPricing {
    inputPer1M: number;      // default: 5.00 (Opus 4)
    outputPer1M: number;     // default: 25.00 (Opus 4)
    cacheReadPer1M: number;  // default: 0.50 (Opus 4)
    cacheWritePer1M: number; // default: 6.25 (Opus 4, 5m TTL)
}

export function calculateBedrockCost(usage: TokenUsage, pricing: BedrockPricing): number {
    return (
        (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
        (usage.outputTokens / 1_000_000) * pricing.outputPer1M +
        ((usage.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheReadPer1M +
        ((usage.cacheWriteTokens ?? 0) / 1_000_000) * pricing.cacheWritePer1M
    );
}
```

#### Container Cost (time-based)

Fargate Spot pricing is fixed per container size. We always run the same config (derived from `DOBBY_VM_CPU`, which is an existing env var that must NOT be removed):
- 4 vCPU × $0.01334058/hr = $0.05336/hr
- 16 GB RAM (4 GB per vCPU) × $0.00146489/hr = $0.02344/hr
- 1 GB ephemeral (21 GB total - 20 GB base) × $0.000111/hr = $0.000111/hr
- **Total: ~$0.077/hr**

Note: memory is `DOBBY_VM_CPU * 4` and ephemeral overage is `21 - 20 = 1`. If ECS config changes, these values must be updated to match.

```ts
interface FargatePricing {
    vcpuPerHour: number;     // default: 0.01334058 (Spot, us-east-1)
    memGbPerHour: number;    // default: 0.00146489 (Spot, us-east-1)
    ephemeralGbPerHour: number; // default: 0.000111 (per GB over 20GB)
}

export function calculateContainerCost(
    durationMs: number,
    vcpu: number,
    memGb: number,
    ephemeralGbOverBase: number,
    pricing: FargatePricing,
): number {
    const hours = durationMs / 3_600_000;
    return hours * (
        vcpu * pricing.vcpuPerHour +
        memGb * pricing.memGbPerHour +
        ephemeralGbOverBase * pricing.ephemeralGbPerHour
    );
}
```

Pricing env vars:

```ts
BEDROCK_INPUT_PRICE_PER_1M: z.coerce.number().default(5.00),
BEDROCK_OUTPUT_PRICE_PER_1M: z.coerce.number().default(25.00),
BEDROCK_CACHE_READ_PRICE_PER_1M: z.coerce.number().default(0.50),
BEDROCK_CACHE_WRITE_PRICE_PER_1M: z.coerce.number().default(6.25),
FARGATE_SPOT_VCPU_PER_HOUR: z.coerce.number().default(0.01334058),
FARGATE_SPOT_MEM_GB_PER_HOUR: z.coerce.number().default(0.00146489),
FARGATE_SPOT_EPHEMERAL_GB_PER_HOUR: z.coerce.number().default(0.000111),
```

### 5.4. Callback Schema Extension

```ts
const callbackSchema = z.object({
    jobId: z.string().min(1),
    status: z.enum([...]),
    prUrl: z.string().url().optional(),
    lastCheckpointCommit: z.string().optional(),
    ecsTaskArn: z.string().optional(),
    // Token usage telemetry
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
});
```

### 5.5. Runner Token Extraction

Keep `opencode run` in default format (readable logs for CloudWatch). After OpenCode finishes (or is interrupted), query its SQLite database to sum all token usage.

OpenCode stores per-message token data in `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db`:

```json
{"role":"assistant","cost":0.15,"tokens":{"total":23589,"input":3,"output":143,"reasoning":0,"cache":{"read":0,"write":23443}}}
```

Each container is fresh, so all messages in the DB belong to the current job — no session filtering needed.

Reusable function called from both normal completion and SIGTERM handler:

```bash
extract_token_usage() {
  OPENCODE_DB="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"

  if [[ -f "${OPENCODE_DB}" ]]; then
    TOKEN_DATA=$(sqlite3 "${OPENCODE_DB}" "
      SELECT json_object(
        'inputTokens', COALESCE(SUM(json_extract(data, '$.tokens.input')), 0),
        'outputTokens', COALESCE(SUM(json_extract(data, '$.tokens.output')), 0),
        'cacheReadTokens', COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0),
        'cacheWriteTokens', COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0)
      )
      FROM message
      WHERE json_extract(data, '$.role') = 'assistant'
    " 2>/dev/null || echo "{}")

    INPUT_TOKENS=$(echo "${TOKEN_DATA}" | jq -r '.inputTokens // 0')
    OUTPUT_TOKENS=$(echo "${TOKEN_DATA}" | jq -r '.outputTokens // 0')
    CACHE_READ_TOKENS=$(echo "${TOKEN_DATA}" | jq -r '.cacheReadTokens // 0')
    CACHE_WRITE_TOKENS=$(echo "${TOKEN_DATA}" | jq -r '.cacheWriteTokens // 0')
  else
    INPUT_TOKENS=0
    OUTPUT_TOKENS=0
    CACHE_READ_TOKENS=0
    CACHE_WRITE_TOKENS=0
  fi
}
```

The `callback()` helper function in the entrypoint must be updated to accept the token fields as additional JSON key-value pairs. Called from both paths:

```bash
handle_sigterm() {
  extract_token_usage
  callback "interrupted" \
    "\"inputTokens\": ${INPUT_TOKENS}" \
    "\"outputTokens\": ${OUTPUT_TOKENS}" \
    "\"cacheReadTokens\": ${CACHE_READ_TOKENS}" \
    "\"cacheWriteTokens\": ${CACHE_WRITE_TOKENS}"
}

# Normal completion
extract_token_usage
callback "completed" \
  "\"inputTokens\": ${INPUT_TOKENS}" \
  "\"outputTokens\": ${OUTPUT_TOKENS}" \
  "\"cacheReadTokens\": ${CACHE_READ_TOKENS}" \
  "\"cacheWriteTokens\": ${CACHE_WRITE_TOKENS}"
```

**Why SQLite instead of `--format json`:** The `--format json` flag replaces readable output with raw JSON events, which would break the CloudWatch log viewer in the admin UI.

### 5.6. Callback Route: Incremental Token Accumulation

A single job can span multiple containers (Spot interruptions, auto-resume). Each container reports its partial token counts. The callback route **increments** existing values — if null/zero, sets; if already has data, adds.

Token accumulation must only happen after the stale-callback guards pass (existing `ecsTaskArn` matching logic).

```ts
if (input.inputTokens !== undefined || input.outputTokens !== undefined) {
    const existingInput = Number(job.inputTokens) || 0;
    const existingOutput = Number(job.outputTokens) || 0;
    const existingCacheRead = Number(job.cacheReadTokens) || 0;
    const existingCacheWrite = Number(job.cacheWriteTokens) || 0;

    const totalInput = existingInput + (input.inputTokens ?? 0);
    const totalOutput = existingOutput + (input.outputTokens ?? 0);
    const totalCacheRead = existingCacheRead + (input.cacheReadTokens ?? 0);
    const totalCacheWrite = existingCacheWrite + (input.cacheWriteTokens ?? 0);

    updateFields.inputTokens = totalInput;
    updateFields.outputTokens = totalOutput;
    updateFields.cacheReadTokens = totalCacheRead;
    updateFields.cacheWriteTokens = totalCacheWrite;

    // Always recalculate Bedrock cost from accumulated totals (avoids float drift)
    const bedrockCost = calculateBedrockCost(
        { inputTokens: totalInput, outputTokens: totalOutput,
          cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite },
        { inputPer1M: env.BEDROCK_INPUT_PRICE_PER_1M, ... }
    );
    updateFields.bedrockCostUsd = bedrockCost.toFixed(6);

    // Container cost from total duration (startedAt to now/finishedAt)
    if (job.startedAt) {
        const finishedAt = updateFields.finishedAt ?? new Date();
        const durationMs = finishedAt.getTime() - new Date(job.startedAt).getTime();
        const containerCost = calculateContainerCost(
            durationMs, env.DOBBY_VM_CPU, env.DOBBY_VM_CPU * 4, 1,
            { vcpuPerHour: env.FARGATE_SPOT_VCPU_PER_HOUR, ... }
        );
        updateFields.containerCostUsd = containerCost.toFixed(6);
        updateFields.costUsd = (bedrockCost + containerCost).toFixed(6);
    } else {
        updateFields.costUsd = bedrockCost.toFixed(6);
    }
}
```

**Example: Job with 2 Spot interruptions (3 runs total)**

Bedrock cost only shown (container cost omitted for clarity):

| Run | Status | Input (this run) | Output (this run) | DB input_tokens | DB output_tokens | DB bedrock_cost_usd |
|-----|--------|-----------------|-------------------|----------------|-----------------|---------------------|
| 1 | interrupted | 50,000 | 10,000 | 50,000 | 10,000 | $0.500000 |
| 2 | interrupted | 80,000 | 20,000 | 130,000 | 30,000 | $1.400000 |
| 3 | completed | 40,000 | 15,000 | 170,000 | 45,000 | $1.975000 |

Run 3 check: (170K × $5/1M) + (45K × $25/1M) = $0.85 + $1.125 = $1.975. `costUsd` would add the container cost on top.

### 5.7. API Response

`GET /api/v1/jobs/:id` response:

```ts
{
    id, status, repository, task, prUrl,
    startedAt, finishedAt,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    bedrockCostUsd,
    containerCostUsd,
    costUsd,         // total: bedrock + container
}
```

### 5.8. Admin UI Changes

On the job detail page, replace FLOPS cost with real cost breakdown:

| Metric | Value |
|--------|-------|
| Duration | 8m 30s |
| Input tokens | 125,000 |
| Output tokens | 45,000 |
| Cache read tokens | 80,000 |
| Cache write tokens | 30,000 |
| Bedrock cost | $3.52 |
| Container cost | $0.01 |
| **Total cost** | **$3.53** |

### 5.9. Telegram Notification

Update `TelegramNotificationJob` interface: remove `costFlops`, `resumeCount`; add `inputTokens`, `outputTokens`, `costUsd`. Update all call sites that construct the notification job object (callback route, stop route, timeout route, job creation route).

Add cost to completed notifications (only if `costUsd` is available):

```
✅ Job done — 8m 30s
db_WODxYC7J
suverenum/dobby

Add input validation to the /api/users endpoint
125K in / 45K out · $3.53

📦 PR-42
```

Token formatting: `< 1000` → raw number, `≥ 1000` → "1.2K", `≥ 1,000,000` → "1.2M". Cost: `$X.XX` (2 decimal places for display).

### 5.10. Job Submission (simplified)

Remove MPP preauthorization from `POST /api/v1/jobs`. The route already has Bearer token auth. The entire MPP-Token auth path is removed (including the 402 response for missing MPP-Token when Bearer auth fails). No budget calculation needed — cost is tracked after the fact, not pre-authorized.

### 5.11. Pros and Cons

- **Pros:** Real cost visibility; simpler billing code; accurate per-job cost; handles Spot interruptions; no fake FLOPS math
- **Cons:** Depends on OpenCode SQLite schema (may change); no pre-authorization (can't cap spend per job); pricing env vars need manual updates
- **Consequences:** When MPP is ready, we add it back on top of real cost data instead of fake FLOPS. The actual token counts make future pricing models much easier.

## 6. Testing Strategy (95%+ coverage target)

### 6.1. Unit Tests — `cost.test.ts`

**`calculateBedrockCost()`:**
- Standard usage: 100K input, 50K output, 200K cache read, 80K cache write → correct USD
- Zero tokens across all fields → $0.00
- Only input tokens (output/cache zero) → correct partial cost
- Only output tokens → correct partial cost
- Only cache read tokens → correct partial cost
- Only cache write tokens → correct partial cost
- Missing cache fields (undefined) → treated as zero
- Large token counts (100M+) → no overflow, correct calculation
- Fractional results: verify precision to 6 decimal places

**`calculateContainerCost()`:**
- Standard: 8m30s, 4 vCPU, 16 GB, 1 GB ephemeral → correct USD
- Zero duration → $0.00
- Very short duration (1 second) → correct fractional cost
- Very long duration (6 hours max) → correct cost
- Different vCPU counts (1, 2, 4, 8) → scales linearly
- Zero ephemeral overage → no ephemeral cost component

### 6.2. Unit Tests — `callback/route.test.ts` (token-specific)

**Token acceptance:**
- Callback with all token fields → stored correctly
- Callback with only inputTokens/outputTokens (no cache fields) → cache columns set to 0 (not null), because accumulation logic runs
- Callback with no token fields → existing behavior, no token columns touched
- Callback with zero token values → stored as 0, not null

**Incremental accumulation:**
- First callback (null in DB) + tokens → sets values (null treated as 0)
- Second callback (existing values in DB) + tokens → sums correctly
- Third callback → sums again (3 runs total)
- Callback with zero tokens + existing values → no change to totals
- Callback with tokens + null existing → treated as 0 + new

**Cost calculation on accumulation:**
- bedrockCostUsd recalculated from accumulated totals, not summed from partial costs
- containerCostUsd calculated from total duration (startedAt to finishedAt)
- costUsd = bedrockCostUsd + containerCostUsd
- Missing startedAt → containerCostUsd is null, costUsd = bedrockCostUsd only

**Status-specific behavior:**
- "completed" callback with tokens → tokens stored, cost calculated
- "interrupted" callback with tokens → tokens stored, cost calculated (partial)
- "failed" callback with tokens → tokens stored, cost calculated (partial)
- "cloning" callback (no tokens expected) → no token columns touched
- "executing" callback (no tokens expected) → no token columns touched

**Stale callback guard:**
- Tokens only accumulated after stale-callback check passes

### 6.3. Unit Tests — `telegram.test.ts` (token-specific)

- Completed job with tokens and cost → shows "125K in / 45K out · $3.53"
- Completed job without tokens (null) → no token line shown
- Completed job with zero tokens → no token line shown
- Failed job with partial tokens → shows partial token line
- Token formatting: 999 → "999", 1,234 → "1.2K", 1,234,567 → "1.2M"
- Cost formatting: 0.001 → "$0.00", 3.52 → "$3.52", 123.45 → "$123.45"

### 6.4. Unit Tests — `cost.ts` edge cases

- Pricing env vars: default values used when not set
- Custom pricing: override via env vars, verify calculation uses overrides
- All pricing at zero → $0.00 regardless of tokens

### 6.5. Unit Tests — API response (`GET /api/v1/jobs/:id`)

- Job with all token fields → included in response
- Job with null token fields (old job) → fields returned as null, no crash
- Job with partial token fields → included as-is

### 6.6. Unit Tests — Job submission (`POST /api/v1/jobs`)

- Verify MPP preauthorization removed — no 402 for missing MPP-Token when Bearer auth used
- Verify no costFlops, authorizedFlops in response
- Verify no mppChannelId stored

### 6.7. Integration Tests

- Submit job → callback with tokens → GET job → verify token fields and costs match
- Submit job → 3 callbacks (interrupted, interrupted, completed) each with tokens → verify accumulation
- Submit job → callback without tokens → GET job → token fields are null, no error
- Old jobs in DB (no token columns before migration) → GET job → null token fields, no crash

### 6.8. Admin UI Tests

- Job detail with token data → renders cost breakdown section
- Job detail without token data (old job) → renders "—" or hides section
- Job detail with partial data (container cost but no tokens) → renders available data

## 7. Definition of Done

### Universal

- [ ] Tests pass (`bun run test`)
- [ ] TypeScript compiles cleanly (`bun run typecheck`)
- [ ] Linter passes (`bun run lint`)
- [ ] Spec updated to reflect implementation (if diverged)

### Feature-Specific

- [ ] FLOPS billing code removed (billing.ts, mpp.ts, related env vars, all test fixtures)
- [ ] DB migration: remove old columns, add token columns (nullable)
- [ ] Callback route accepts token data and accumulates incrementally
- [ ] Bedrock + container cost calculated from accumulated token totals and duration
- [ ] `GET /api/v1/jobs/:id` returns token and cost fields
- [ ] Runner extracts token usage from OpenCode SQLite DB
- [ ] Runner sends tokens on both normal completion and SIGTERM
- [ ] Runner Docker image rebuilt and pushed to ECR (with sqlite3 dependency)
- [ ] Admin job detail page shows cost breakdown
- [ ] Telegram notification includes token/cost summary
- [ ] Existing jobs without token data display correctly (null handling)
- [ ] Job submission works without MPP preauthorization
- [ ] Code deployed before migration runs (deployment order)

## 8. References

- [AWS Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/) — Anthropic section
- [AWS Fargate Spot Pricing](https://aws.amazon.com/fargate/pricing/) — us-east-1
- Claude Opus 4 on Bedrock: $5/M input, $25/M output, $6.25/M cache write (5m), $0.50/M cache read
- OpenCode SQLite DB: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db`, table `message`, field `data` contains `tokens` and `cost`
- Current billing code: `apps/web/src/domain/jobs/billing.ts`
- Current callback route: `apps/web/src/app/api/internal/callback/route.ts`
- DB schema: `apps/web/src/db/schema.ts`
