import type { InferSelectModel } from "drizzle-orm";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db";
import type { jobs } from "../../db/schema";
import { jobs as jobsTable } from "../../db/schema";
import { decrypt } from "../../lib/kms";
import type { DecryptedSecrets } from "./ecs";
import { provisionTask } from "./ecs";

type Job = InferSelectModel<typeof jobs>;

/**
 * Resume an interrupted job by decrypting secrets and provisioning a new Fargate task.
 * Used by both the runner callback and the ECS event (spot interruption) handlers.
 */
export async function resumeJob(job: Job, checkpointCommit?: string): Promise<void> {
	const db = getDb();

	if (!job.encryptedGitCredentials) {
		throw new Error(`Job ${job.id} has no encrypted git credentials for resume`);
	}

	const gitToken = await decrypt(job.encryptedGitCredentials);
	const decryptedSecrets: DecryptedSecrets = { gitToken };

	if (job.encryptedSecrets) {
		decryptedSecrets.secrets = JSON.parse(await decrypt(job.encryptedSecrets));
	}

	// Update job with checkpoint and increment resume count
	const updateFields: Record<string, unknown> = {
		status: "provisioning",
		resumeCount: sql`${jobsTable.resumeCount} + 1`,
	};
	if (checkpointCommit) {
		updateFields.lastCheckpointCommit = checkpointCommit;
	}
	await db.update(jobsTable).set(updateFields).where(eq(jobsTable.id, job.id));

	// Build a job-like object for provisionTask with updated checkpoint
	const jobForProvision = {
		...job,
		lastCheckpointCommit: checkpointCommit ?? job.lastCheckpointCommit,
	};

	// Provision new Fargate task
	const result = await provisionTask(jobForProvision, decryptedSecrets);

	// Derive log stream name from task ARN (awslogs format: prefix/container-name/task-id)
	const taskId = result.taskArn.split("/").pop();
	const logStreamName = taskId ? `dobby-runner/dobby-runner/${taskId}` : null;

	// Store new ECS task ARN and log stream name
	await db
		.update(jobsTable)
		.set({
			ecsTaskArn: result.taskArn,
			ecsClusterArn: result.clusterArn,
			...(logStreamName && { logStreamName }),
		})
		.where(eq(jobsTable.id, job.id));
}
