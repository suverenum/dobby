import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { jobs } from "../../../../../db/schema";
import { isValidJobId } from "../../../../../domain/jobs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;

	if (!isValidJobId(id)) {
		return NextResponse.json({ error: "Invalid job ID format" }, { status: 400 });
	}

	const db = getDb();
	const result = await db.select().from(jobs).where(eq(jobs.id, id));

	const job = result[0];
	if (!job) {
		return NextResponse.json({ error: "Job not found" }, { status: 404 });
	}

	return NextResponse.json({
		id: job.id,
		status: job.status,
		repository: job.repository,
		baseBranch: job.baseBranch,
		workingBranch: job.workingBranch,
		task: job.task.slice(0, 200),
		existingPrUrl: job.existingPrUrl,
		prUrl: job.prUrl,
		submittedAt: job.submittedAt,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		inputTokens: job.inputTokens,
		outputTokens: job.outputTokens,
		cacheReadTokens: job.cacheReadTokens,
		cacheWriteTokens: job.cacheWriteTokens,
		bedrockCostUsd: job.bedrockCostUsd,
		containerCostUsd: job.containerCostUsd,
		costUsd: job.costUsd,
		resumeCount: job.resumeCount,
	});
}
