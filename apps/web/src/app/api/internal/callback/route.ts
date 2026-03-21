import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import {
	calculateJobCost,
	isActiveStatus,
	isTerminalStatus,
	isValidJobId,
	isValidTransition,
	resumeJob,
} from "../../../../domain/jobs";
import { getEnv } from "../../../../lib/env";
import { settlePayment } from "../../../../lib/mpp";
import { verifyBearerToken } from "../../../../lib/session";
import { sendNotification } from "../../../../lib/telegram";

const callbackSchema = z.object({
	jobId: z.string().min(1, "jobId is required"),
	status: z.enum(["cloning", "executing", "finalizing", "completed", "failed", "interrupted"]),
	prUrl: z.string().url().optional(),
	lastCheckpointCommit: z.string().optional(),
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

	// Handle race condition: if ECS event already marked the job as interrupted
	// and the runner callback also reports interrupted, skip transition validation
	// and proceed directly to the resume flow.
	const alreadyInterrupted = job.status === "interrupted" && input.status === "interrupted";

	if (
		!alreadyInterrupted &&
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

	if (input.prUrl) {
		updateFields.prUrl = input.prUrl;
	}

	if (input.lastCheckpointCommit) {
		updateFields.lastCheckpointCommit = input.lastCheckpointCommit;
	}

	// On terminal status: set finishedAt, calculate cost, settle payment, clear encrypted secrets
	if (isTerminalStatus(input.status)) {
		updateFields.finishedAt = now;

		// Calculate cost if job was started
		let cost = 0;
		if (job.startedAt) {
			const durationMs = now.getTime() - new Date(job.startedAt).getTime();
			cost = calculateJobCost(durationMs, env.DOBBY_HOURLY_RATE, env.DOBBY_MAX_JOB_HOURS);
			updateFields.costFlops = cost.toString();
		}

		// Settle MPP payment (non-blocking — errors logged but not fatal)
		if (job.mppChannelId) {
			const authorizedFlops = Number(job.authorizedFlops) || 0;
			settlePayment(job.mppChannelId, cost, authorizedFlops).catch((error) => {
				console.error(`Failed to settle MPP payment for job ${job.id}:`, error);
			});
		}

		// Delete encrypted secrets on terminal status
		updateFields.encryptedGitCredentials = "";
		updateFields.encryptedSecrets = null;
	}

	// Skip DB update if job is already interrupted (ECS event handled it)
	if (!alreadyInterrupted) {
		await db.update(jobs).set(updateFields).where(eq(jobs.id, input.jobId));
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
		costFlops: (updateFields.costFlops as string) ?? job.costFlops,
		finishedAt: (updateFields.finishedAt as Date) ?? job.finishedAt,
	};
	sendNotification(updatedJob, input.status).catch(() => {});

	return NextResponse.json({ ok: true });
}
