import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../../db";
import { jobs } from "../../../../../../db/schema";
import { type JobStatus, stopTask, validateTransition } from "../../../../../../domain/jobs";
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

	const now = new Date();
	const updateFields: Record<string, unknown> = {
		status: "stopped",
		finishedAt: now,
	};

	// CAS update to claim the terminal status — secrets are NOT cleared yet
	// so we can revert if stopTask() fails transiently.
	const updated = await db
		.update(jobs)
		.set(updateFields)
		.where(and(eq(jobs.id, id), eq(jobs.status, status)))
		.returning({ id: jobs.id });

	if (updated.length === 0) {
		return NextResponse.json(
			{ error: `Job status changed concurrently (expected: ${status})` },
			{ status: 409 },
		);
	}

	// Stop the ECS task after DB update succeeds.
	// If stopTask() fails transiently, revert the terminal status so the
	// cron timeout handler can catch and retry stopping it.
	if (job.ecsTaskArn) {
		try {
			await stopTask(job);
		} catch (err) {
			console.error(`Failed to stop ECS task for job ${id}:`, err);
			// Revert terminal status so cron/admin can retry
			await db
				.update(jobs)
				.set({
					status,
					finishedAt: null,
				})
				.where(and(eq(jobs.id, id), eq(jobs.status, "stopped" as JobStatus)));
			return NextResponse.json(
				{ error: `Failed to stop ECS task: ${err instanceof Error ? err.message : err}` },
				{ status: 502 },
			);
		}
	}

	// Task is confirmed stopped — now clear secrets.
	try {
		await db
			.update(jobs)
			.set({ encryptedGitCredentials: "", encryptedSecrets: null })
			.where(eq(jobs.id, id));
	} catch (secretErr) {
		console.error(`Failed to clear secrets for stopped job ${id}:`, secretErr);
	}

	// Send Telegram notification (non-blocking)
	sendNotification(
		{
			...job,
			finishedAt: now,
		},
		"stopped",
	).catch(() => {});

	return NextResponse.json({ success: true, status: "stopped" });
}
