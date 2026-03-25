import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import {
	calculateBedrockCost,
	calculateContainerCost,
	isActiveStatus,
	isTerminalStatus,
	isValidJobId,
	isValidTransition,
	resumeJob,
} from "../../../../domain/jobs";
import { getEnv } from "../../../../lib/env";
import { verifyBearerToken } from "../../../../lib/session";
import { sendNotification } from "../../../../lib/telegram";

const callbackSchema = z.object({
	jobId: z.string().min(1, "jobId is required"),
	status: z.enum(["cloning", "executing", "finalizing", "completed", "failed", "interrupted"]),
	prUrl: z
		.string()
		.url()
		.refine((u) => /^https?:\/\//.test(u), "prUrl must use http(s)")
		.optional(),
	lastCheckpointCommit: z.string().optional(),
	ecsTaskArn: z.string().optional(),
	// Token usage telemetry
	inputTokens: z.number().int().nonnegative().optional(),
	outputTokens: z.number().int().nonnegative().optional(),
	cacheReadTokens: z.number().int().nonnegative().optional(),
	cacheWriteTokens: z.number().int().nonnegative().optional(),
});

export type CallbackInput = z.infer<typeof callbackSchema>;

/**
 * Internal callback endpoint for runners to report status.
 * Authenticated via DOBBY_CALLBACK_SECRET in Authorization header.
 */
export async function POST(request: NextRequest) {
	const env = getEnv();

	// Authenticate via shared secret (timing-safe comparison)
	const authHeader = request.headers.get("Authorization");
	const expectedSecret = env.DOBBY_CALLBACK_SECRET;
	if (!expectedSecret || !verifyBearerToken(authHeader, expectedSecret)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = callbackSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Validation failed", details: z.prettifyError(parsed.error) },
			{ status: 400 },
		);
	}

	const input = parsed.data;

	if (!isValidJobId(input.jobId)) {
		return NextResponse.json({ error: "Invalid job ID format" }, { status: 400 });
	}

	const db = getDb();

	// Look up job
	const jobRows = await db.select().from(jobs).where(eq(jobs.id, input.jobId));
	const job = jobRows[0];
	if (!job) {
		return NextResponse.json({ error: "Job not found" }, { status: 404 });
	}

	// Reject stale callbacks from old ECS tasks. When the runner provides its
	// ecsTaskArn, compare it to the stored ARN — a mismatch means the callback
	// is from a previous task attempt and must be discarded to prevent
	// double-provisioning and stale state overwrites.
	if (input.ecsTaskArn && job.ecsTaskArn && input.ecsTaskArn !== job.ecsTaskArn) {
		return NextResponse.json(
			{ error: `Stale callback: task ARN mismatch for job ${job.id}` },
			{ status: 409 },
		);
	}

	// Handle SIGTERM callbacks for jobs already in a terminal state (stopped/timed_out).
	// The stop/timeout endpoints write the terminal status before sending SIGTERM to allow
	// the runner's SIGTERM handler to persist its last checkpoint and PR URL.
	// This check MUST run before the no-ARN stale guard below, because a legitimate
	// SIGTERM callback from a resumed job (resumeCount > 0) would otherwise be rejected.
	const terminalSigtermCallback =
		(job.status === "stopped" || job.status === "timed_out") && input.status === "interrupted";

	// Reject stale "interrupted" callbacks from previous task attempts after a resume.
	// After resume, the new task's interruptions are handled via ECS events (which match
	// by ARN), so the runner callback arrives on the alreadyInterrupted path below.
	// A callback reporting "interrupted" without ecsTaskArn on a resumed job is from the
	// old dead container and must be rejected to prevent double-provisioning.
	// Also covers the window where resumeJob has CAS'd to "provisioning" but hasn't yet
	// incremented resumeCount — a no-ARN "interrupted" callback during provisioning is
	// always stale (a real interruption would come via ECS event with ARN match).
	if (
		input.status === "interrupted" &&
		!terminalSigtermCallback &&
		!input.ecsTaskArn &&
		((job.resumeCount ?? 0) > 0 || job.status === "provisioning")
	) {
		return NextResponse.json(
			{ error: `Stale callback: no task identity on resumed job ${job.id}` },
			{ status: 409 },
		);
	}

	// Handle race condition: if ECS event already marked the job as interrupted
	// and the runner callback also reports interrupted, skip transition validation
	// and proceed directly to the resume flow.
	const alreadyInterrupted = job.status === "interrupted" && input.status === "interrupted";

	if (
		!alreadyInterrupted &&
		!terminalSigtermCallback &&
		!isValidTransition(job.status as Parameters<typeof isValidTransition>[0], input.status)
	) {
		return NextResponse.json(
			{ error: `Invalid status transition: ${job.status} → ${input.status}` },
			{ status: 409 },
		);
	}

	const now = new Date();

	// Build update fields
	const updateFields: Record<string, unknown> = {
		status: input.status,
	};

	// Set startedAt on first transition to an active status (cloning/executing/finalizing)
	if (!job.startedAt && isActiveStatus(input.status)) {
		updateFields.startedAt = now;
	}

	// Record when the job was interrupted (used by cron for 3-min resume timeout)
	if (input.status === "interrupted") {
		updateFields.interruptedAt = now;
	}

	if (input.prUrl) {
		updateFields.prUrl = input.prUrl;
	}

	if (input.lastCheckpointCommit) {
		updateFields.lastCheckpointCommit = input.lastCheckpointCommit;
	}

	// On terminal status: set finishedAt, clear encrypted secrets
	if (isTerminalStatus(input.status)) {
		updateFields.finishedAt = now;

		// Delete encrypted secrets on terminal status
		updateFields.encryptedGitCredentials = "";
		updateFields.encryptedSecrets = null;
	}

	// Token accumulation: accumulate tokens from this callback with existing values.
	// Must happen after stale-callback guards pass.
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
			{
				inputTokens: totalInput,
				outputTokens: totalOutput,
				cacheReadTokens: totalCacheRead,
				cacheWriteTokens: totalCacheWrite,
			},
			{
				inputPer1M: env.BEDROCK_INPUT_PRICE_PER_1M,
				outputPer1M: env.BEDROCK_OUTPUT_PRICE_PER_1M,
				cacheReadPer1M: env.BEDROCK_CACHE_READ_PRICE_PER_1M,
				cacheWritePer1M: env.BEDROCK_CACHE_WRITE_PRICE_PER_1M,
			},
		);
		updateFields.bedrockCostUsd = bedrockCost.toFixed(6);

		// Container cost from total duration (startedAt to now/finishedAt)
		const jobStartedAt = job.startedAt ?? (updateFields.startedAt as Date | undefined);
		if (jobStartedAt) {
			const finishedAt = (updateFields.finishedAt as Date | undefined) ?? now;
			const durationMs = finishedAt.getTime() - new Date(jobStartedAt).getTime();
			const containerCost = calculateContainerCost(
				durationMs,
				env.DOBBY_VM_CPU,
				env.DOBBY_VM_CPU * 4,
				1,
				{
					vcpuPerHour: env.FARGATE_SPOT_VCPU_PER_HOUR,
					memGbPerHour: env.FARGATE_SPOT_MEM_GB_PER_HOUR,
					ephemeralGbPerHour: env.FARGATE_SPOT_EPHEMERAL_GB_PER_HOUR,
				},
			);
			updateFields.containerCostUsd = containerCost.toFixed(6);
			updateFields.costUsd = (bedrockCost + containerCost).toFixed(6);
		} else {
			updateFields.costUsd = bedrockCost.toFixed(6);
		}
	}

	// For SIGTERM callbacks on terminal jobs (stopped/timed_out), only persist
	// the runner's last checkpoint, PR URL, and token data without changing the status.
	if (terminalSigtermCallback) {
		const sigtermFields: Record<string, unknown> = {};
		if (input.prUrl) sigtermFields.prUrl = input.prUrl;
		if (input.lastCheckpointCommit) sigtermFields.lastCheckpointCommit = input.lastCheckpointCommit;
		// Also persist token accumulation on SIGTERM
		if (updateFields.inputTokens !== undefined) {
			sigtermFields.inputTokens = updateFields.inputTokens;
			sigtermFields.outputTokens = updateFields.outputTokens;
			sigtermFields.cacheReadTokens = updateFields.cacheReadTokens;
			sigtermFields.cacheWriteTokens = updateFields.cacheWriteTokens;
			sigtermFields.bedrockCostUsd = updateFields.bedrockCostUsd;
			if (updateFields.containerCostUsd !== undefined) {
				sigtermFields.containerCostUsd = updateFields.containerCostUsd;
			}
			sigtermFields.costUsd = updateFields.costUsd;
		}
		if (Object.keys(sigtermFields).length > 0) {
			await db.update(jobs).set(sigtermFields).where(eq(jobs.id, input.jobId));
		}
		return NextResponse.json({ ok: true });
	}

	// Skip DB update if job is already interrupted (ECS event handled it),
	// but still persist lastCheckpointCommit so it's not lost if resumeJob fails.
	// Use CAS on status to prevent overwriting concurrent terminal transitions
	// (e.g. admin stop or cron timeout that landed between our read and write).
	if (!alreadyInterrupted) {
		const updated = await db
			.update(jobs)
			.set(updateFields)
			.where(and(eq(jobs.id, input.jobId), eq(jobs.status, job.status)))
			.returning({ id: jobs.id });
		if (updated.length === 0) {
			return NextResponse.json(
				{ error: `Job ${job.id} status changed concurrently (expected: ${job.status})` },
				{ status: 409 },
			);
		}
	} else if (input.lastCheckpointCommit) {
		await db
			.update(jobs)
			.set({ lastCheckpointCommit: input.lastCheckpointCommit })
			.where(eq(jobs.id, input.jobId));
	}

	// On interrupted status: trigger resume flow
	if (input.status === "interrupted") {
		try {
			await resumeJob(job, input.lastCheckpointCommit);
		} catch (error) {
			// Resume failure is non-fatal — job stays interrupted, can be manually retried
			console.error(`Failed to resume job ${job.id}:`, error);
		}
	}

	// Send Telegram notification (non-blocking, errors are logged but not fatal)
	const updatedJob = {
		...job,
		prUrl: (input.prUrl ?? job.prUrl) as string | null,
		inputTokens: (updateFields.inputTokens as number | undefined) ?? job.inputTokens,
		outputTokens: (updateFields.outputTokens as number | undefined) ?? job.outputTokens,
		costUsd: (updateFields.costUsd as string | undefined) ?? job.costUsd,
		finishedAt: (updateFields.finishedAt as Date) ?? job.finishedAt,
	};
	sendNotification(updatedJob, input.status).catch(() => {});

	return NextResponse.json({ ok: true });
}
