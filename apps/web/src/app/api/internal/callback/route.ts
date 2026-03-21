import { eq, type InferSelectModel, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import {
	calculateJobCost,
	type DecryptedSecrets,
	isTerminalStatus,
	isValidJobId,
	isValidTransition,
	provisionTask,
} from "../../../../domain/jobs";
import { getEnv } from "../../../../lib/env";
import { decrypt } from "../../../../lib/kms";
import { sendNotification } from "../../../../lib/telegram";

type Job = InferSelectModel<typeof jobs>;

const callbackSchema = z.object({
	jobId: z.string().min(1, "jobId is required"),
	status: z.enum(["completed", "failed", "interrupted"]),
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

	// Authenticate via shared secret
	const authHeader = request.headers.get("Authorization");
	const expectedSecret = env.DOBBY_CALLBACK_SECRET;
	if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
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

	// Validate status transition
	if (!isValidTransition(job.status as Parameters<typeof isValidTransition>[0], input.status)) {
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

	if (input.prUrl) {
		updateFields.prUrl = input.prUrl;
	}

	if (input.lastCheckpointCommit) {
		updateFields.lastCheckpointCommit = input.lastCheckpointCommit;
	}

	// On terminal status: set finishedAt, calculate cost, clear encrypted secrets
	if (isTerminalStatus(input.status)) {
		updateFields.finishedAt = now;

		// Calculate cost if job was started
		if (job.startedAt) {
			const durationMs = now.getTime() - new Date(job.startedAt).getTime();
			const cost = calculateJobCost(durationMs, env.DOBBY_HOURLY_RATE, env.DOBBY_MAX_JOB_HOURS);
			updateFields.costFlops = cost.toString();
		}

		// Delete encrypted secrets on terminal status
		updateFields.encryptedGitCredentials = "";
		updateFields.encryptedSecrets = null;
	}

	await db.update(jobs).set(updateFields).where(eq(jobs.id, input.jobId));

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

/**
 * Resume an interrupted job by decrypting secrets and provisioning a new Fargate task.
 */
async function resumeJob(job: Job, checkpointCommit?: string): Promise<void> {
	const db = getDb();

	// Decrypt credentials for the new task
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
		resumeCount: sql`${jobs.resumeCount} + 1`,
	};
	if (checkpointCommit) {
		updateFields.lastCheckpointCommit = checkpointCommit;
	}
	await db.update(jobs).set(updateFields).where(eq(jobs.id, job.id));

	// Build a job-like object for provisionTask with updated checkpoint
	const jobForProvision = {
		...job,
		lastCheckpointCommit: checkpointCommit ?? job.lastCheckpointCommit,
	};

	// Provision new Fargate task
	const result = await provisionTask(jobForProvision, decryptedSecrets);

	// Store new ECS task ARN
	await db
		.update(jobs)
		.set({
			ecsTaskArn: result.taskArn,
			ecsClusterArn: result.clusterArn,
		})
		.where(eq(jobs.id, job.id));
}
