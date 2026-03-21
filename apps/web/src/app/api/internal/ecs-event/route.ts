import type { InferSelectModel } from "drizzle-orm";
import { eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import { type DecryptedSecrets, isValidTransition, provisionTask } from "../../../../domain/jobs";
import { getEnv } from "../../../../lib/env";
import { decrypt } from "../../../../lib/kms";

type Job = InferSelectModel<typeof jobs>;

/**
 * Zod schema for the relevant subset of an ECS Task State Change event
 * delivered by EventBridge.
 */
const ecsEventSchema = z.object({
	"detail-type": z.literal("ECS Task State Change"),
	detail: z.object({
		taskArn: z.string().min(1),
		stopCode: z.string().optional(),
		clusterArn: z.string().optional(),
	}),
});

/**
 * Internal webhook endpoint that receives ECS Task State Change events
 * from AWS EventBridge. Detects Spot interruptions and triggers the
 * resume flow for affected jobs.
 */
export async function POST(request: NextRequest) {
	const env = getEnv();

	// Authenticate via shared secret (same as callback endpoint)
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

	const parsed = ecsEventSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Validation failed", details: z.prettifyError(parsed.error) },
			{ status: 400 },
		);
	}

	const event = parsed.data;
	const { taskArn, stopCode } = event.detail;

	// Only handle Spot interruptions
	if (stopCode !== "SpotInterruption") {
		return NextResponse.json({ ok: true, action: "ignored", reason: "not a spot interruption" });
	}

	const db = getDb();

	// Look up job by ECS task ARN
	const jobRows = await db.select().from(jobs).where(eq(jobs.ecsTaskArn, taskArn));
	const job = jobRows[0];
	if (!job) {
		return NextResponse.json({ ok: true, action: "ignored", reason: "no matching job" });
	}

	// Validate that the transition to "interrupted" is valid
	if (!isValidTransition(job.status as Parameters<typeof isValidTransition>[0], "interrupted")) {
		return NextResponse.json({
			ok: true,
			action: "ignored",
			reason: `job status ${job.status} cannot transition to interrupted`,
		});
	}

	// Mark job as interrupted
	await db.update(jobs).set({ status: "interrupted" }).where(eq(jobs.id, job.id));

	// Trigger resume flow (non-fatal — job stays interrupted if resume fails)
	try {
		await resumeJob(job);
	} catch (error) {
		console.error(`Failed to resume job ${job.id} after spot interruption:`, error);
	}

	return NextResponse.json({ ok: true, action: "resumed", jobId: job.id });
}

/**
 * Resume a job after spot interruption by decrypting secrets and
 * provisioning a new Fargate task from the last checkpoint.
 */
async function resumeJob(job: Job): Promise<void> {
	const db = getDb();

	if (!job.encryptedGitCredentials) {
		throw new Error(`Job ${job.id} has no encrypted git credentials for resume`);
	}

	const gitToken = await decrypt(job.encryptedGitCredentials);
	const decryptedSecrets: DecryptedSecrets = { gitToken };

	if (job.encryptedSecrets) {
		decryptedSecrets.secrets = JSON.parse(await decrypt(job.encryptedSecrets));
	}

	// Update job: transition back to provisioning, increment resume count
	const updateFields: Record<string, unknown> = {
		status: "provisioning",
		resumeCount: sql`${jobs.resumeCount} + 1`,
	};
	await db.update(jobs).set(updateFields).where(eq(jobs.id, job.id));

	// Provision new Fargate task with the existing checkpoint
	const jobForProvision = {
		...job,
		lastCheckpointCommit: job.lastCheckpointCommit,
	};

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
