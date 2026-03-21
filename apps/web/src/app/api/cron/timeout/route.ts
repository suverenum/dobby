import { and, eq, inArray, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import { calculateJobCost } from "../../../../domain/jobs/billing";
import { stopTask } from "../../../../domain/jobs/ecs";
import { ACTIVE_STATUSES, isValidTransition, type JobStatus } from "../../../../domain/jobs/status";
import { getEnv } from "../../../../lib/env";
import { settlePayment } from "../../../../lib/mpp";
import { verifyBearerToken } from "../../../../lib/session";
import { sendNotification } from "../../../../lib/telegram";

/**
 * Cron endpoint that checks for jobs exceeding DOBBY_MAX_JOB_HOURS and stops them.
 * Configured to run every 5 minutes via vercel.json.
 */
export async function GET(request: Request) {
	const env = getEnv();

	// Verify Vercel Cron secret if configured (Vercel sends Authorization header)
	const authHeader = request.headers.get("Authorization");
	const cronSecret = process.env.CRON_SECRET;
	if (cronSecret && !verifyBearerToken(authHeader, cronSecret)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const db = getDb();
	const maxJobMs = env.DOBBY_MAX_JOB_HOURS * 60 * 60 * 1000;
	const cutoff = new Date(Date.now() - maxJobMs);

	// Find active jobs where startedAt is before the cutoff
	const overdueJobs = await db
		.select()
		.from(jobs)
		.where(
			and(
				inArray(jobs.status, [...ACTIVE_STATUSES] as [string, ...string[]]),
				lt(jobs.startedAt, cutoff),
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

			// Stop the ECS task (sends SIGTERM to container)
			if (job.ecsTaskArn) {
				await stopTask(job);
			}

			const now = new Date();

			// Calculate cost
			const updateFields: Record<string, unknown> = {
				status: "timed_out" as JobStatus,
				finishedAt: now,
			};

			if (job.startedAt) {
				const durationMs = now.getTime() - new Date(job.startedAt).getTime();
				const cost = calculateJobCost(durationMs, env.DOBBY_HOURLY_RATE, env.DOBBY_MAX_JOB_HOURS);
				updateFields.costFlops = cost.toString();
			}

			// Clear encrypted secrets on terminal status
			updateFields.encryptedGitCredentials = "";
			updateFields.encryptedSecrets = null;

			await db.update(jobs).set(updateFields).where(eq(jobs.id, job.id));

			// Settle MPP payment (non-blocking)
			if (job.mppChannelId) {
				const authorizedFlops = Number(job.authorizedFlops) || 0;
				const finalCost = updateFields.costFlops ? Number(updateFields.costFlops) : 0;
				settlePayment(job.mppChannelId, finalCost, authorizedFlops).catch((error) => {
					console.error(`Failed to settle MPP payment for job ${job.id}:`, error);
				});
			}

			// Send Telegram notification (non-blocking)
			sendNotification(
				{
					...job,
					costFlops: (updateFields.costFlops as string) ?? job.costFlops,
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

	return NextResponse.json({
		timedOut: results.filter((r) => r.stopped).length,
		failed: results.filter((r) => !r.stopped).length,
		results,
	});
}
