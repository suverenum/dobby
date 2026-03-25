# Technical Specification: Token Usage Telemetry

## 1. Meta Information

- **Branch:** `feat/token-telemetry`
- **Epic:** TBD
- **PRD:** N/A (internal cost visibility)

## 2. Context

Dobby bills callers per-minute in FLOPS tokens but pays AWS per-token via Bedrock. There is zero visibility into actual LLM costs per job. We need to track input/output token counts from the runner, store them in the DB, and expose them through the API and admin UI so we can calculate real cost and verify profitability.

## 3. Key Technical Drivers

- **Cost visibility:** Know the actual AWS Bedrock cost per job (input + output tokens × price per token)
- **Profitability analysis:** Compare FLOPS revenue (time-based) vs. Bedrock cost (token-based) per job
- **Minimal runner changes:** The runner is a bash script + OpenCode; token extraction must be simple
- **Backward compatibility:** Existing jobs without token data should continue to work
- **No billing model change yet:** This is telemetry only — the FLOPS per-minute billing model stays, we just add visibility

## 4. Current State

### 4.1. Billing Model

Time-based: `ceil(duration_minutes) * (DOBBY_HOURLY_RATE / 60)`, capped at `DOBBY_HOURLY_RATE * DOBBY_MAX_JOB_HOURS`.
- Default: 100 FLOPS/hour, max 6 hours = 600 FLOPS max budget
- Cost calculated server-side from `finishedAt - startedAt`
- File: `apps/web/src/domain/jobs/billing.ts`

### 4.2. Callback Schema

The runner sends `{jobId, status, prUrl?, lastCheckpointCommit?, ecsTaskArn?}` — no token data.
- File: `apps/web/src/app/api/internal/callback/route.ts`

### 4.3. DB Schema

`costFlops` (numeric, nullable) is the only cost field. No token usage columns.
- File: `apps/web/src/db/schema.ts`

### 4.4. Runner

Bash entrypoint runs `opencode run "..."` and pipes stdout to CloudWatch. OpenCode writes to stdout but doesn't report token usage to a file by default.
- File: `runner/entrypoint.sh`

### 4.5. AWS Bedrock Pricing (Anthropic models, on-demand, us-east-1)

| Model | Input /1M | Output /1M | Cache write (5m) /1M | Cache write (1h) /1M | Cache read /1M |
|-------|-----------|------------|----------------------|----------------------|----------------|
| Claude Sonnet 4.6 | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| Claude Sonnet 4.6 Long Context | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| Claude Opus 4.6 | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 |
| Claude Opus 4.6 Long Context | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 |

We currently use Claude Opus 4.6 (`us.anthropic.claude-opus-4-6-v1`).

## 5. Considered Options

### 5.1. Option 1: Parse OpenCode stdout for token usage

- **Description:** OpenCode may log token usage summaries to stdout. Parse the CloudWatch logs after job completion to extract totals.
- **Pros:** No runner changes needed; works retroactively on existing logs
- **Cons:** Fragile — depends on OpenCode log format; no structured data; async parsing adds complexity; may not include per-call breakdown

### 5.2. Option 2: Runner extracts tokens from OpenCode output and reports via callback

- **Description:** After OpenCode finishes, the runner parses its output or session data for token totals, then includes them in the final callback payload.
- **Pros:** Structured data in callback; minimal infra changes; real-time (no async parsing)
- **Cons:** Depends on OpenCode exposing token usage in a parseable format

### 5.3. Option 3: Query AWS Bedrock CloudWatch metrics after job completion

- **Description:** Use AWS CloudWatch metrics (Bedrock publishes `InputTokenCount` and `OutputTokenCount` per model invocation) to aggregate token usage per ECS task after the job finishes.
- **Pros:** Authoritative data from AWS; doesn't depend on OpenCode format; captures all Bedrock calls
- **Cons:** CloudWatch metrics have ~5min delay; requires correlating ECS task → Bedrock invocations (no built-in link); complex aggregation; may need custom dimensions

### 5.4. Option 4: Use AWS Bedrock invocation logging to S3

- **Description:** Enable Bedrock model invocation logging to S3. Each API call is logged with full token counts. Post-process logs after job completion.
- **Pros:** Most accurate; captures all calls including retries; AWS-native
- **Cons:** Setup overhead (S3 bucket, log config); async processing (logs arrive with delay); extra AWS cost; overkill for MVP

### 5.5. Comparison

| Criteria              | Option 1 (Parse stdout) | Option 2 (Callback) | Option 3 (CW Metrics) | Option 4 (S3 Logs) |
|-----------------------|------------------------|---------------------|----------------------|-------------------|
| Accuracy              | Low                    | Medium              | High                 | Highest           |
| Implementation effort | Medium                 | Low                 | High                 | High              |
| Real-time             | No                     | Yes                 | No (~5min delay)     | No (~15min delay) |
| Runner changes        | None                   | Small               | None                 | None              |
| Dependency on OpenCode| High                   | Medium              | None                 | None              |

## 6. Proposed Solution

**Option 2 (Callback)** for MVP, with **Option 3 (CW Metrics)** as a future cross-check.

The runner extracts token usage from OpenCode's session data after execution, includes it in the final callback, the web app stores it, and the admin UI displays it.

### 6.1. DB Schema Changes

Add token tracking columns to the `jobs` table:

```sql
ALTER TABLE jobs ADD COLUMN input_tokens bigint;
ALTER TABLE jobs ADD COLUMN output_tokens bigint;
ALTER TABLE jobs ADD COLUMN cache_read_tokens bigint;
ALTER TABLE jobs ADD COLUMN cache_write_tokens bigint;
ALTER TABLE jobs ADD COLUMN bedrock_cost_usd numeric;
```

In Drizzle schema (`apps/web/src/db/schema.ts`):

```ts
inputTokens: bigint("input_tokens", { mode: "number" }),
outputTokens: bigint("output_tokens", { mode: "number" }),
cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
bedrockCostUsd: numeric("bedrock_cost_usd"),
```

All nullable — existing jobs keep null values.

### 6.2. Callback Schema Extension

Extend the callback route to accept optional token usage fields:

```ts
const callbackSchema = z.object({
    jobId: z.string().min(1),
    status: z.enum([...]),
    prUrl: z.string().url().optional(),
    lastCheckpointCommit: z.string().optional(),
    ecsTaskArn: z.string().optional(),
    // NEW: token usage telemetry
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
});
```

### 6.3. Bedrock Cost Calculation

Add cost calculation function to `apps/web/src/domain/jobs/billing.ts`:

```ts
interface BedrockTokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

interface BedrockPricing {
    inputPer1M: number;   // default: 5.00 (Opus 4.6)
    outputPer1M: number;  // default: 25.00 (Opus 4.6)
    cacheReadPer1M: number;  // default: 0.50 (Opus 4.6)
    cacheWritePer1M: number; // default: 6.25 (Opus 4.6, 5m TTL)
}

function calculateBedrockCost(usage: BedrockTokenUsage, pricing: BedrockPricing): number {
    return (
        (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
        (usage.outputTokens / 1_000_000) * pricing.outputPer1M +
        ((usage.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheReadPer1M +
        ((usage.cacheWriteTokens ?? 0) / 1_000_000) * pricing.cacheWritePer1M
    );
}
```

Pricing constants stored as env vars with defaults:

```ts
BEDROCK_INPUT_PRICE_PER_1M: z.coerce.number().default(5.00),
BEDROCK_OUTPUT_PRICE_PER_1M: z.coerce.number().default(25.00),
BEDROCK_CACHE_READ_PRICE_PER_1M: z.coerce.number().default(0.50),
BEDROCK_CACHE_WRITE_PRICE_PER_1M: z.coerce.number().default(6.25),
```

### 6.4. Runner Token Extraction

OpenCode's `run --format json` outputs structured JSON events to stdout. Each LLM step emits a `step_finish` event with token counts:

```json
{"type":"step_finish","sessionID":"ses_xxx","part":{
  "cost":0.143,
  "tokens":{"total":22976,"input":2,"output":5,"reasoning":0,"cache":{"read":0,"write":22969}}
}}
```

The runner captures the JSON stream, sums all `step_finish` token counts, and includes them in the final callback.

In `runner/entrypoint.sh`, replace the current `opencode run` invocation:

```bash
# Run OpenCode in JSON mode to capture token usage
opencode run --format json "${RALPH_PROMPT}" 2>/dev/null | tee /tmp/opencode-output.json &

OPENCODE_PID=$!
wait $OPENCODE_PID || { ... }

# Extract total token usage from all step_finish events
TOKEN_DATA=$(grep '"type":"step_finish"' /tmp/opencode-output.json \
  | jq -s '{
    inputTokens: [.[].part.tokens.input // 0] | add,
    outputTokens: [.[].part.tokens.output // 0] | add,
    reasoningTokens: [.[].part.tokens.reasoning // 0] | add,
    cacheReadTokens: [.[].part.tokens.cache.read // 0] | add,
    cacheWriteTokens: [.[].part.tokens.cache.write // 0] | add,
    cost: [.[].part.cost // 0] | add
  }' 2>/dev/null || echo "{}")

INPUT_TOKENS=$(echo "${TOKEN_DATA}" | jq -r '.inputTokens // 0')
OUTPUT_TOKENS=$(echo "${TOKEN_DATA}" | jq -r '.outputTokens // 0')
CACHE_READ_TOKENS=$(echo "${TOKEN_DATA}" | jq -r '.cacheReadTokens // 0')
CACHE_WRITE_TOKENS=$(echo "${TOKEN_DATA}" | jq -r '.cacheWriteTokens // 0')
```

**Verified:** OpenCode's `--format json` reliably emits `step_finish` events with `cost` and `tokens` fields for every LLM call, including subagent calls. The `cost` field is OpenCode's own cost calculation based on the model's pricing.

### 6.5. Callback Route Processing

In the callback route, on terminal status:

```ts
// Calculate Bedrock cost if token data is provided
if (input.inputTokens !== undefined || input.outputTokens !== undefined) {
    const bedrockCost = calculateBedrockCost(
        {
            inputTokens: input.inputTokens ?? 0,
            outputTokens: input.outputTokens ?? 0,
            cacheReadTokens: input.cacheReadTokens,
            cacheWriteTokens: input.cacheWriteTokens,
        },
        {
            inputPer1M: env.BEDROCK_INPUT_PRICE_PER_1M,
            outputPer1M: env.BEDROCK_OUTPUT_PRICE_PER_1M,
            cacheReadPer1M: env.BEDROCK_CACHE_READ_PRICE_PER_1M,
            cacheWritePer1M: env.BEDROCK_CACHE_WRITE_PRICE_PER_1M,
        }
    );
    updateFields.inputTokens = input.inputTokens ?? 0;
    updateFields.outputTokens = input.outputTokens ?? 0;
    updateFields.cacheReadTokens = input.cacheReadTokens ?? null;
    updateFields.cacheWriteTokens = input.cacheWriteTokens ?? null;
    updateFields.bedrockCostUsd = bedrockCost.toFixed(6);
}
```

### 6.6. API Response Extension

Add to `GET /api/v1/jobs/:id` response:

```ts
inputTokens: job.inputTokens,
outputTokens: job.outputTokens,
cacheReadTokens: job.cacheReadTokens,
cacheWriteTokens: job.cacheWriteTokens,
bedrockCostUsd: job.bedrockCostUsd,
```

### 6.7. Admin UI Changes

On the job detail page (`apps/web/src/app/admin/jobs/[id]/page.tsx`), add a "Cost Breakdown" section:

| Metric | Value |
|--------|-------|
| Duration | 8m 30s |
| FLOPS charged | 15 |
| Input tokens | 125,000 |
| Output tokens | 45,000 |
| Cache read tokens | 80,000 |
| Cache write tokens | 30,000 |
| Bedrock cost (USD) | $3.52 |
| Margin | $X.XX (FLOPS revenue - Bedrock cost) |

### 6.8. Telegram Notification Update

Add Bedrock cost to the notification (only if available):

```
✅ Job done — 8m 30s
db_WODxYC7J
suverenum/dobby

Add input validation to the /api/users endpoint
Tokens: 125K in / 45K out · $3.52

PR: https://github.com/suverenum/dobby/pull/42
```

### 6.K+1. Pros and Cons

- **Pros:** Real cost visibility per job; simple implementation; backward compatible; enables profitability analysis
- **Cons:** Depends on OpenCode session format (may break with updates); token extraction is best-effort (could miss tokens from subagent calls); Bedrock pricing hardcoded as env defaults (needs manual updates when pricing changes)
- **Consequences:** Can inform future billing model changes (switch from per-minute to per-token or hybrid); enables setting DOBBY_HOURLY_RATE based on actual costs

## 7. Testing Strategy

### 7.1. Unit Tests

- `billing.test.ts`: Test `calculateBedrockCost()` with various token counts, zero values, missing cache tokens
- `callback/route.test.ts`: Test callback with and without token fields; verify DB update includes token data and computed cost
- `telegram.test.ts`: Test notification format with and without token data

### 7.2. Integration Tests

- Submit a job, send callback with token data, verify `GET /api/v1/jobs/:id` returns token fields and bedrock cost
- Verify existing callbacks without token fields still work (backward compat)

## 8. Definition of Done

### Universal (always required)

- [ ] Tests pass (`bun run test`)
- [ ] TypeScript compiles cleanly (`bun run typecheck`)
- [ ] Linter passes (`bun run lint`)
- [ ] Spec updated to reflect implementation (if diverged)

### Feature-Specific

- [ ] DB migration adds token columns (nullable)
- [ ] Callback route accepts and stores token usage
- [ ] Bedrock cost calculated and stored automatically
- [ ] `GET /api/v1/jobs/:id` returns token and cost fields
- [ ] Runner extracts token usage from OpenCode session data
- [ ] Runner Docker image rebuilt and pushed to ECR
- [ ] Admin job detail page shows cost breakdown
- [ ] Telegram notification includes token summary (when available)
- [ ] Existing jobs without token data display correctly (null handling)

## 9. Alternatives Not Chosen

- **Option 1 (Parse stdout):** Too fragile, depends on unstructured log format
- **Option 3 (CloudWatch Metrics):** Too complex for MVP, 5-min delay, hard to correlate ECS task → Bedrock calls
- **Option 4 (S3 invocation logs):** Most accurate but heavy setup, async processing, overkill for cost visibility

## 10. References

- [AWS Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/) — Anthropic section
- Claude Opus 4.6 on Bedrock: $5/M input, $25/M output, $6.25/M cache write (5m), $0.50/M cache read
- Current billing code: `apps/web/src/domain/jobs/billing.ts`
- Current callback route: `apps/web/src/app/api/internal/callback/route.ts`
- DB schema: `apps/web/src/db/schema.ts`
