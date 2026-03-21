import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import { isValidTransition } from "../../../../domain/jobs";
import { getEnv } from "../../../../lib/env";
import { verifyBearerToken } from "../../../../lib/session";

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

	// Mark job as interrupted — resume is handled by the runner callback endpoint
	// which has the checkpoint commit SHA from the runner's SIGTERM handler
	await db.update(jobs).set({ status: "interrupted" }).where(eq(jobs.id, job.id));

	return NextResponse.json({ ok: true, action: "marked_interrupted", jobId: job.id });
}
