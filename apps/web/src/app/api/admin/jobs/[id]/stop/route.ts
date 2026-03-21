import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../../db";
import { jobs } from "../../../../../../db/schema";
import {
	calculateJobCost,
	type JobStatus,
	stopTask,
	validateTransition,
} from "../../../../../../domain/jobs";
import { getEnv } from "../../../../../../lib/env";
import { settlePayment } from "../../../../../../lib/mpp";
import { validateAdminSession } from "../../../../../../lib/session";
import { sendNotification } from "../../../../../../lib/telegram";

export async function POST(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
	const valid = await validateAdminSession();
	if (!valid) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id } = await params;
	const db = getDb();

	const rows = await db.select().from(jobs).where(eq(jobs.id, id));
	const job = rows[0];
	if (!job) {
		return NextResponse.json({ error: "Job not found" }, { status: 404 });
	}

	const status = job.status as JobStatus;

	try {
		validateTransition(status, "stopped");
	} catch {
		return NextResponse.json(
			{ error: `Cannot transition from ${status} to stopped` },
			{ status: 409 },
		);
	}

	// Stop the ECS task if it has one
	if (job.ecsTaskArn) {
		try {
			await stopTask(job);
		} catch (err) {
			// Log but don't fail — the task may already be stopped
			console.error(`Failed to stop ECS task for job ${id}:`, err);
		}
	}

	const env = getEnv();
	const now = new Date();
	const updateFields: Record<string, unknown> = {
		status: "stopped",
		finishedAt: now,
		encryptedGitCredentials: "",
		encryptedSecrets: null,
	};

	// Calculate cost if job was started
	let cost = 0;
	if (job.startedAt) {
		const durationMs = now.getTime() - new Date(job.startedAt).getTime();
		cost = calculateJobCost(durationMs, env.DOBBY_HOURLY_RATE, env.DOBBY_MAX_JOB_HOURS);
		updateFields.costFlops = cost.toString();
	}

	await db.update(jobs).set(updateFields).where(eq(jobs.id, id));

	// Settle MPP payment after DB update succeeds (non-blocking)
	if (job.mppChannelId) {
		const authorizedFlops = Number(job.authorizedFlops) || 0;
		settlePayment(job.mppChannelId, cost, authorizedFlops).catch((error) => {
			console.error(`Failed to settle MPP payment for job ${id}:`, error);
		});
	}

	// Send Telegram notification (non-blocking)
	sendNotification(
		{
			...job,
			costFlops: (updateFields.costFlops as string) ?? job.costFlops,
			finishedAt: now,
		},
		"stopped",
	).catch(() => {});

	return NextResponse.json({ success: true, status: "stopped" });
}
