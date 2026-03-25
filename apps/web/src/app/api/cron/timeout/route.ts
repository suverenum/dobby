import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import { stopTask } from "../../../../domain/jobs/ecs";
import { resumeJob } from "../../../../domain/jobs/resume";
import { ACTIVE_STATUSES, isValidTransition, type JobStatus } from "../../../../domain/jobs/status";
import { getEnv } from "../../../../lib/env";
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

	// Find active, interrupted, or stale jobs that are overdue:
	// - Active jobs with startedAt before the max duration cutoff, OR
	// - Interrupted jobs that exceeded max duration (resume keeps failing), OR
	// - Jobs stuck in provisioning (startedAt is null) submitted before provisioning cutoff, OR
	// - Pending jobs that were never provisioned (submitted before provisioning cutoff)
	// Note: Resumed provisioning jobs (startedAt is set) are caught by the max duration check.
	const overdueJobs = await db
		.select()
		.from(jobs)
		.where(
			or(
				and(
					inArray(jobs.status, [...ACTIVE_STATUSES] as [string, ...string[]]),
					or(
						lt(jobs.startedAt, cutoff),
						and(isNull(jobs.startedAt), lt(jobs.submittedAt, provisioningCutoff)),
					),
				),
				and(eq(jobs.status, "interrupted" as JobStatus), lt(jobs.startedAt, cutoff)),
				and(eq(jobs.status, "pending"), lt(jobs.submittedAt, provisioningCutoff)),
			),
		);

	const results: { jobId: string; stopped: boolean; error?: string }[] = [];

	for (const job of overdueJobs) {
		try {
			// Stale pending/interrupted jobs should be marked as failed, not timed_out
			const targetStatus: JobStatus =
				job.status === "pending" || job.status === "interrupted" ? "failed" : "timed_out";

			if (!isValidTransition(job.status as JobStatus, targetStatus)) {
				results.push({
					jobId: job.id,
					stopped: false,
					error: `Cannot transition from ${job.status} to ${targetStatus}`,
				});
				continue;
			}

			const now = new Date();

			const updateFields: Record<string, unknown> = {
				status: targetStatus,
				finishedAt: now,
			};

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
						})
						.where(and(eq(jobs.id, job.id), eq(jobs.status, targetStatus)));
					results.push({ jobId: job.id, stopped: false, error: `ECS stop failed: ${err}` });
					continue;
				}
			}

			// Task is confirmed stopped — now clear secrets.
			try {
				await db
					.update(jobs)
					.set({ encryptedGitCredentials: "", encryptedSecrets: null })
					.where(eq(jobs.id, job.id));
			} catch (secretErr) {
				console.error(`Failed to clear secrets for timed-out job ${job.id}:`, secretErr);
			}

			// Send Telegram notification (non-blocking)
			sendNotification(
				{
					...job,
					finishedAt: now,
				},
				targetStatus,
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
