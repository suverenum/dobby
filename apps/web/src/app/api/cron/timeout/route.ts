import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import { calculateJobCost } from "../../../../domain/jobs/billing";
import { stopTask } from "../../../../domain/jobs/ecs";
import { resumeJob } from "../../../../domain/jobs/resume";
import { ACTIVE_STATUSES, isValidTransition, type JobStatus } from "../../../../domain/jobs/status";
import { getEnv } from "../../../../lib/env";
import { settlePayment } from "../../../../lib/mpp";
import { verifyBearerToken } from "../../../../lib/session";
import { sendNotification } from "../../../../lib/telegram";

/** How long to wait for a runner callback before the cron auto-resumes an interrupted job */
const INTERRUPTED_RESUME_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes (per spec)

/** How long a provisioning job can wait before being considered stalled */
const PROVISIONING_STALL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Cron endpoint that:
 * 1. Checks for jobs exceeding DOBBY_MAX_JOB_HOURS and stops them.
 * 2. Detects provisioning jobs that never received a callback (stalled).
 * 3. Auto-resumes interrupted jobs whose runner callback never arrived.
 * Configured to run every 5 minutes via vercel.json.
 */
export async function GET(request: Request) {
	const env = getEnv();

	// Verify Vercel Cron secret (Vercel sends Authorization header)
	const authHeader = request.headers.get("Authorization");
	const cronSecret = env.CRON_SECRET;
	if (!cronSecret || !verifyBearerToken(authHeader, cronSecret)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const db = getDb();
	const maxJobMs = env.DOBBY_MAX_JOB_HOURS * 60 * 60 * 1000;
	const cutoff = new Date(Date.now() - maxJobMs);
	const provisioningCutoff = new Date(Date.now() - PROVISIONING_STALL_TIMEOUT_MS);

	// Find active jobs that are overdue:
	// - Jobs with startedAt before the max duration cutoff, OR
	// - Jobs stuck in provisioning (startedAt is null) submitted before provisioning cutoff, OR
	// - Resumed jobs stuck in provisioning (startedAt is set) interrupted before provisioning cutoff
	const overdueJobs = await db
		.select()
		.from(jobs)
		.where(
			and(
				inArray(jobs.status, [...ACTIVE_STATUSES] as [string, ...string[]]),
				or(
					lt(jobs.startedAt, cutoff),
					and(isNull(jobs.startedAt), lt(jobs.submittedAt, provisioningCutoff)),
					and(eq(jobs.status, "provisioning"), lt(jobs.interruptedAt, provisioningCutoff)),
				),
			),
		);

	const results: { jobId: string; stopped: boolean; error?: string }[] = [];

	for (const job of overdueJobs) {
		try {
			// Skip if transition to timed_out is not valid (e.g., finalizing can only go to completed/failed/stopped)
			if (!isValidTransition(job.status as JobStatus, "timed_out")) {
				results.push({
					jobId: job.id,
					stopped: false,
					error: `Cannot transition from ${job.status} to timed_out`,
				});
				continue;
			}

			const now = new Date();

			// Calculate cost
			const updateFields: Record<string, unknown> = {
				status: "timed_out" as JobStatus,
				finishedAt: now,
			};

			let costFlops: string | undefined;
			if (job.startedAt) {
				const durationMs = now.getTime() - new Date(job.startedAt).getTime();
				const cost = calculateJobCost(durationMs, env.DOBBY_HOURLY_RATE, env.DOBBY_MAX_JOB_HOURS);
				costFlops = cost.toString();
				updateFields.costFlops = costFlops;
			}

			// CAS update to claim the terminal status — secrets are NOT cleared yet
			// so we can revert if stopTask() fails transiently.
			const updated = await db
				.update(jobs)
				.set(updateFields)
				.where(and(eq(jobs.id, job.id), eq(jobs.status, job.status as JobStatus)))
				.returning({ id: jobs.id });

			if (updated.length === 0) {
				results.push({
					jobId: job.id,
					stopped: false,
					error: `Job status changed concurrently (expected: ${job.status})`,
				});
				continue;
			}

			// Stop the ECS task after DB update succeeds (sends SIGTERM to container).
			// If stopTask() fails transiently, revert the terminal status so the next
			// cron run can retry — prevents orphaned running containers.
			if (job.ecsTaskArn) {
				try {
					await stopTask(job);
				} catch (err) {
					console.error(`Failed to stop ECS task for job ${job.id}:`, err);
					// Revert terminal status so cron can retry on next cycle
					await db
						.update(jobs)
						.set({
							status: job.status as JobStatus,
							finishedAt: null,
							costFlops: job.costFlops,
						})
						.where(and(eq(jobs.id, job.id), eq(jobs.status, "timed_out" as JobStatus)));
					results.push({ jobId: job.id, stopped: false, error: `ECS stop failed: ${err}` });
					continue;
				}
			}

			// Task is confirmed stopped — now clear secrets and settle payment.
			// Both operations must be attempted even if one fails, to avoid
			// stranding secrets or leaving payments unsettled.
			try {
				await db
					.update(jobs)
					.set({ encryptedGitCredentials: "", encryptedSecrets: null })
					.where(eq(jobs.id, job.id));
			} catch (secretErr) {
				console.error(`Failed to clear secrets for timed-out job ${job.id}:`, secretErr);
			}

			// Settle MPP payment (non-blocking)
			if (job.mppChannelId) {
				const authorizedFlops = Number(job.authorizedFlops) || 0;
				const finalCost = costFlops ? Number(costFlops) : 0;
				settlePayment(job.mppChannelId, finalCost, authorizedFlops).catch((error) => {
					console.error(`Failed to settle MPP payment for job ${job.id}:`, error);
				});
			}

			// Send Telegram notification (non-blocking)
			sendNotification(
				{
					...job,
					costFlops: costFlops ?? job.costFlops,
					finishedAt: now,
				},
				"timed_out",
			).catch(() => {});

			results.push({ jobId: job.id, stopped: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.error(`Failed to timeout job ${job.id}:`, message);
			results.push({ jobId: job.id, stopped: false, error: message });
		}
	}

	// Auto-resume interrupted jobs whose runner callback never arrived (3-min timeout per spec)
	const interruptedCutoff = new Date(Date.now() - INTERRUPTED_RESUME_TIMEOUT_MS);
	const stuckInterruptedJobs = await db
		.select()
		.from(jobs)
		.where(
			and(eq(jobs.status, "interrupted" as JobStatus), lt(jobs.interruptedAt, interruptedCutoff)),
		);

	const resumeResults: { jobId: string; resumed: boolean; error?: string }[] = [];
	for (const job of stuckInterruptedJobs) {
		try {
			await resumeJob(job, job.lastCheckpointCommit ?? undefined);
			resumeResults.push({ jobId: job.id, resumed: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.error(`Failed to auto-resume interrupted job ${job.id}:`, message);
			resumeResults.push({ jobId: job.id, resumed: false, error: message });
		}
	}

	return NextResponse.json({
		timedOut: results.filter((r) => r.stopped).length,
		failed: results.filter((r) => !r.stopped).length,
		results,
		resumed: resumeResults.filter((r) => r.resumed).length,
		resumeFailed: resumeResults.filter((r) => !r.resumed).length,
		resumeResults,
	});
}
