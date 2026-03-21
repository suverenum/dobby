import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../../db";
import { jobs } from "../../../../../../db/schema";
import {
	isActiveStatus,
	type JobStatus,
	stopTask,
	validateTransition,
} from "../../../../../../domain/jobs";
import { validateAdminSession } from "../../../../../../lib/session";

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

	if (!isActiveStatus(status)) {
		return NextResponse.json({ error: `Cannot stop job in status: ${status}` }, { status: 409 });
	}

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

	// Update job status
	await db
		.update(jobs)
		.set({
			status: "stopped",
			finishedAt: new Date(),
		})
		.where(eq(jobs.id, id));

	return NextResponse.json({ success: true, status: "stopped" });
}
