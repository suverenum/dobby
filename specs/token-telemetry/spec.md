# Technical Specification: Token Usage & Real Cost Tracking

## 1. Meta Information

- **Branch:** `feat/token-telemetry`
- **Epic:** TBD
- **PRD:** N/A (internal cost visibility)

## 2. Context

Dobby uses AWS Bedrock (Claude Opus 4.6) which charges per token. Currently there is zero visibility into actual costs — the existing FLOPS per-minute billing model is a placeholder for future MPP integration and doesn't reflect real spend. We need to replace it with actual token-based cost tracking.

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
- Env vars: `DOBBY_HOURLY_RATE`, `DOBBY_MAX_JOB_HOURS`
- DB fields: `authorizedFlops`, `costFlops`, `mppChannelId`

### 4.2. Callback Schema

The runner sends `{jobId, status, prUrl?, lastCheckpointCommit?, ecsTaskArn?}` — no token data.
- File: `apps/web/src/app/api/internal/callback/route.ts`

### 4.3. Runner

Bash entrypoint runs `opencode run "..."`. Output goes to CloudWatch via ECS awslogs driver.
- File: `runner/entrypoint.sh`

### 4.4. AWS Bedrock Pricing (Anthropic models, on-demand, us-east-1)

| Model | Input /1M | Output /1M | Cache write (5m) /1M | Cache write (1h) /1M | Cache read /1M |
|-------|-----------|------------|----------------------|----------------------|----------------|
| Claude Sonnet 4.6 | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| Claude Sonnet 4.6 Long Context | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| Claude Opus 4.6 | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 |
| Claude Opus 4.6 Long Context | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 |

We currently use Claude Opus 4.6 (`us.anthropic.claude-opus-4-6-v1`).

## 5. Proposed Solution

Replace FLOPS billing with real token-based cost tracking. The runner queries OpenCode's SQLite database after execution, sends token counts in the callback, and the web app calculates and stores the actual Bedrock cost in USD.

### 5.1. DB Schema Changes

**Remove** old billing columns:
- `authorizedFlops`
- `costFlops`
- `mppChannelId`

**Add** token tracking columns to the `jobs` table:

```ts
// In Drizzle schema (apps/web/src/db/schema.ts):
inputTokens: bigint("input_tokens", { mode: "number" }),
outputTokens: bigint("output_tokens", { mode: "number" }),
cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
costUsd: numeric("cost_usd"),
```

All nullable — existing jobs keep null values.

### 5.2. Remove FLOPS Billing

**Delete:**
- `apps/web/src/domain/jobs/billing.ts` (calculateJobCost, calculateMaxBudget)
- `apps/web/src/domain/jobs/billing.test.ts`
- `apps/web/src/lib/mpp.ts` (validatePreauthorization, settlePayment)
- `apps/web/src/lib/mpp.test.ts`

**Remove from env.ts:**
- `DOBBY_HOURLY_RATE`
- `DOBBY_MAX_JOB_HOURS`
- `MPP_ENDPOINT`

**Remove FLOPS/MPP logic from:**
- `apps/web/src/app/api/v1/jobs/route.ts` (preauthorization, maxBudget, settlement on failure)
- `apps/web/src/app/api/internal/callback/route.ts` (costFlops calculation, MPP settlement)
- `apps/web/src/app/api/admin/jobs/[id]/stop/route.ts` (costFlops calculation, MPP settlement)
- `apps/web/src/app/api/cron/timeout/route.ts` (costFlops calculation, MPP settlement)

### 5.3. Bedrock Cost Calculation

New file: `apps/web/src/domain/jobs/cost.ts`

```ts
interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

interface BedrockPricing {
    inputPer1M: number;      // default: 5.00 (Opus 4.6)
    outputPer1M: number;     // default: 25.00 (Opus 4.6)
    cacheReadPer1M: number;  // default: 0.50 (Opus 4.6)
    cacheWritePer1M: number; // default: 6.25 (Opus 4.6, 5m TTL)
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

Pricing env vars with defaults:

```ts
BEDROCK_INPUT_PRICE_PER_1M: z.coerce.number().default(5.00),
BEDROCK_OUTPUT_PRICE_PER_1M: z.coerce.number().default(25.00),
BEDROCK_CACHE_READ_PRICE_PER_1M: z.coerce.number().default(0.50),
BEDROCK_CACHE_WRITE_PRICE_PER_1M: z.coerce.number().default(6.25),
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

OpenCode stores per-message token data in `~/.local/share/opencode/opencode.db`:

```json
{"role":"assistant","cost":0.15,"tokens":{"total":23589,"input":3,"output":143,"reasoning":0,"cache":{"read":0,"write":23443}}}
```

Each container is fresh, so all messages in the DB belong to the current job — no session filtering needed.

Reusable function called from both normal completion and SIGTERM handler:

```bash
extract_token_usage() {
  OPENCODE_DB="${HOME}/.local/share/opencode/opencode.db"

  if [[ -f "${OPENCODE_DB}" ]]; then
    TOKEN_DATA=$(sqlite3 "${OPENCODE_DB}" "
      SELECT json_object(
        'inputTokens', COALESCE(SUM(json_extract(data, '\$.tokens.input')), 0),
        'outputTokens', COALESCE(SUM(json_extract(data, '\$.tokens.output')), 0),
        'cacheReadTokens', COALESCE(SUM(json_extract(data, '\$.tokens.cache.read')), 0),
        'cacheWriteTokens', COALESCE(SUM(json_extract(data, '\$.tokens.cache.write')), 0)
      )
      FROM message
      WHERE json_extract(data, '\$.role') = 'assistant'
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

Called from both paths:

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

    // Always recalculate cost from accumulated totals (avoids float drift)
    updateFields.costUsd = calculateBedrockCost(
        { inputTokens: totalInput, outputTokens: totalOutput,
          cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite },
        { inputPer1M: env.BEDROCK_INPUT_PRICE_PER_1M, ... }
    ).toFixed(6);
}
```

**Example: Job with 2 Spot interruptions (3 runs total)**

| Run | Status | Input (this run) | Output (this run) | DB input_tokens | DB output_tokens | DB cost_usd |
|-----|--------|-----------------|-------------------|----------------|-----------------|-------------|
| 1 | interrupted | 50,000 | 10,000 | 50,000 | 10,000 | $0.50 |
| 2 | interrupted | 80,000 | 20,000 | 130,000 | 30,000 | $1.40 |
| 3 | completed | 40,000 | 15,000 | 170,000 | 45,000 | $1.98 |

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
    costUsd,
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
| Cost (USD) | $3.52 |

### 5.9. Telegram Notification

Add cost to completed notifications (only if available):

```
✅ Job done — 8m 30s
db_WODxYC7J
suverenum/dobby

Add input validation to the /api/users endpoint
125K in / 45K out · $3.52

PR: https://github.com/suverenum/dobby/pull/42
```

### 5.10. Job Submission (simplified)

Remove MPP preauthorization from `POST /api/v1/jobs`. The route already has Bearer token auth. No budget calculation needed — cost is tracked after the fact, not pre-authorized.

### Pros and Cons

- **Pros:** Real cost visibility; simpler billing code; accurate per-job cost; handles Spot interruptions; no fake FLOPS math
- **Cons:** Depends on OpenCode SQLite schema (may change); no pre-authorization (can't cap spend per job); pricing env vars need manual updates
- **Consequences:** When MPP is ready, we add it back on top of real cost data instead of fake FLOPS. The actual token counts make future pricing models much easier.

## 6. Testing Strategy

### 6.1. Unit Tests

- `cost.test.ts`: Test `calculateBedrockCost()` with various token counts, zero values, missing cache tokens
- `callback/route.test.ts`: Test callback with token fields; verify incremental accumulation (null → set, existing → add); verify cost calculation
- `telegram.test.ts`: Test notification format with and without token/cost data

### 6.2. Integration Tests

- Submit job, send callback with token data, verify `GET /api/v1/jobs/:id` returns correct totals
- Send multiple callbacks (simulating Spot interruptions), verify tokens accumulate
- Verify existing callbacks without token fields still work

## 7. Definition of Done

### Universal

- [ ] Tests pass (`bun run test`)
- [ ] TypeScript compiles cleanly (`bun run typecheck`)
- [ ] Linter passes (`bun run lint`)
- [ ] Spec updated to reflect implementation (if diverged)

### Feature-Specific

- [ ] FLOPS billing code removed (billing.ts, mpp.ts, related env vars)
- [ ] DB migration: remove old columns, add token columns (nullable)
- [ ] Callback route accepts token data and accumulates incrementally
- [ ] Bedrock cost calculated from accumulated token totals
- [ ] `GET /api/v1/jobs/:id` returns token and cost fields
- [ ] Runner extracts token usage from OpenCode SQLite DB
- [ ] Runner sends tokens on both normal completion and SIGTERM
- [ ] Runner Docker image rebuilt and pushed to ECR
- [ ] Admin job detail page shows cost breakdown
- [ ] Telegram notification includes token/cost summary
- [ ] Existing jobs without token data display correctly (null handling)
- [ ] Job submission works without MPP preauthorization

## 8. References

- [AWS Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/) — Anthropic section
- Claude Opus 4.6 on Bedrock: $5/M input, $25/M output, $6.25/M cache write (5m), $0.50/M cache read
- OpenCode SQLite DB: `~/.local/share/opencode/opencode.db`, table `message`, field `data` contains `tokens` and `cost`
- Current billing code: `apps/web/src/domain/jobs/billing.ts`
- Current callback route: `apps/web/src/app/api/internal/callback/route.ts`
- DB schema: `apps/web/src/db/schema.ts`
