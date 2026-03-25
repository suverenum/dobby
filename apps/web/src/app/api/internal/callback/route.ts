import { and, eq } from "drizzle-orm";
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
	prUrl: z
		.string()
		.url()
		.refine((u) => /^https?:\/\//.test(u), "prUrl must use http(s)")
		.optional(),
	lastCheckpointCommit: z.string().optional(),
	ecsTaskArn: z.string().optional(),
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

		// Delete encrypted secrets on terminal status
		updateFields.encryptedGitCredentials = "";
		updateFields.encryptedSecrets = null;
	}

	// For SIGTERM callbacks on terminal jobs (stopped/timed_out), only persist
	// the runner's last checkpoint and PR URL without changing the status.
	// This preserves the review surface per the spec.
	if (terminalSigtermCallback) {
		const sigtermFields: Record<string, unknown> = {};
		if (input.prUrl) sigtermFields.prUrl = input.prUrl;
		if (input.lastCheckpointCommit) sigtermFields.lastCheckpointCommit = input.lastCheckpointCommit;
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

	// Settle MPP payment after DB update succeeds (non-blocking — errors logged but not fatal)
	if (isTerminalStatus(input.status) && job.mppChannelId) {
		const authorizedFlops = Number(job.authorizedFlops) || 0;
		const cost = updateFields.costFlops ? Number(updateFields.costFlops) : 0;
		settlePayment(job.mppChannelId, cost, authorizedFlops).catch((error) => {
			console.error(`Failed to settle MPP payment for job ${job.id}:`, error);
		});
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
