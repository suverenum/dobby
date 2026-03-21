import type { InferSelectModel } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../db";
import type { jobs } from "../../db/schema";
import { jobs as jobsTable } from "../../db/schema";
import { decrypt } from "../../lib/kms";
import type { DecryptedSecrets } from "./ecs";
import { provisionTask, stopTask } from "./ecs";

type Job = InferSelectModel<typeof jobs>;

/**
 * Resume an interrupted job by decrypting secrets and provisioning a new Fargate task.
 * Used by both the runner callback and the cron timeout handlers.
 *
 * Uses an atomic compare-and-swap (status = 'interrupted' -> 'provisioning') to prevent
 * double-provisioning when both the callback and cron race to resume the same job.
 * All subsequent writes also use CAS on the expected status to prevent overwriting
 * concurrent terminal transitions (e.g. admin stop, cron timeout).
 */
export async function resumeJob(job: Job, checkpointCommit?: string): Promise<void> {
	const db = getDb();

	if (!job.encryptedGitCredentials) {
		throw new Error(`Job ${job.id} has no encrypted git credentials for resume`);
	}

	// Atomically claim the job by transitioning interrupted -> provisioning.
	// Clear the old ecsTaskArn so that stale ECS events or callbacks from the
	// previous task cannot match during provisioning and cause resume churn.
	// If another caller already claimed it, this update affects 0 rows.
	const claimed = await db
		.update(jobsTable)
		.set({ status: "provisioning", ecsTaskArn: null })
		.where(and(eq(jobsTable.id, job.id), eq(jobsTable.status, "interrupted")))
		.returning({ id: jobsTable.id });

	if (claimed.length === 0) {
		throw new Error(`Job ${job.id} is no longer in interrupted state (already claimed)`);
	}

	let result: Awaited<ReturnType<typeof provisionTask>>;
	try {
		const gitToken = await decrypt(job.encryptedGitCredentials);
		const decryptedSecrets: DecryptedSecrets = { gitToken };

		if (job.encryptedSecrets) {
			decryptedSecrets.secrets = JSON.parse(await decrypt(job.encryptedSecrets));
		}

		// Build a job-like object for provisionTask with updated checkpoint
		const jobForProvision = {
			...job,
			lastCheckpointCommit: checkpointCommit ?? job.lastCheckpointCommit,
		};

		// Provision new Fargate task
		result = await provisionTask(jobForProvision, decryptedSecrets);
	} catch (error) {
		// Decrypt or provisioning failed — revert to interrupted so the cron can retry later.
		// Use CAS to avoid overwriting a concurrent terminal transition (e.g. admin stop).
		await db
			.update(jobsTable)
			.set({ status: "interrupted" })
			.where(and(eq(jobsTable.id, job.id), eq(jobsTable.status, "provisioning")));
		throw error;
	}

	// Derive log stream name from task ARN (awslogs format: prefix/container-name/task-id)
	const taskId = result.taskArn.split("/").pop();
	const logStreamName = taskId ? `dobby-runner/dobby-runner/${taskId}` : null;

	// Update job with checkpoint, increment resume count, and store new task ARN.
	// Use CAS on status = 'provisioning' to avoid overwriting a concurrent terminal
	// transition (e.g. admin stop wrote 'stopped' while provisionTask was in flight).
	const updateFields: Record<string, unknown> = {
		resumeCount: sql`${jobsTable.resumeCount} + 1`,
		ecsTaskArn: result.taskArn,
		ecsClusterArn: result.clusterArn,
		...(logStreamName && { logStreamName }),
	};
	if (checkpointCommit) {
		updateFields.lastCheckpointCommit = checkpointCommit;
	}

	const updated = await db
		.update(jobsTable)
		.set(updateFields)
		.where(and(eq(jobsTable.id, job.id), eq(jobsTable.status, "provisioning")))
		.returning({ id: jobsTable.id });

	if (updated.length === 0) {
		// Job was moved to a terminal state while we were provisioning.
		// Stop the newly created ECS task to avoid an orphan.
		const orphanedJob = {
			id: job.id,
			ecsTaskArn: result.taskArn,
			ecsClusterArn: result.clusterArn,
		} as Parameters<typeof stopTask>[0];
		let orphanStopped = false;
		try {
			await stopTask(orphanedJob);
			orphanStopped = true;
		} catch (stopErr) {
			console.error(
				`CRITICAL: Failed to stop orphaned ECS task ${result.taskArn} for job ${job.id} — task may be stranded:`,
				stopErr,
			);
		}
		throw new Error(
			orphanStopped
				? `Job ${job.id} was moved to a terminal state during resume; stopped orphaned task ${result.taskArn}`
				: `Job ${job.id} was moved to a terminal state during resume; FAILED to stop orphaned task ${result.taskArn}`,
		);
	}
}
