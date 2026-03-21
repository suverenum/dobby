import { inArray, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import {
	ACTIVE_STATUSES,
	calculateMaxBudget,
	generateJobId,
	hasCapacity,
} from "../../../../domain/jobs";
import { getEnv } from "../../../../lib/env";
import { encrypt } from "../../../../lib/kms";

const GITHUB_PR_URL_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/;

const jobSubmissionSchema = z.object({
	repository: z
		.string()
		.min(1, "repository is required")
		.regex(
			/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/,
			"repository must be a valid GitHub HTTPS URL",
		),
	baseBranch: z.string().default("main"),
	task: z.string().min(1, "task is required"),
	existingPrUrl: z
		.string()
		.regex(GITHUB_PR_URL_RE, "existingPrUrl must be a valid GitHub PR URL")
		.optional(),
	secrets: z.record(z.string(), z.string()).optional(),
	gitToken: z.string().min(1, "gitToken is required"),
});

export type JobSubmissionInput = z.infer<typeof jobSubmissionSchema>;

function normalizeRepoUrl(url: string): string {
	return url.replace(/\.git$/, "").toLowerCase();
}

function extractRepoFromPrUrl(prUrl: string): string | null {
	const match = prUrl.match(GITHUB_PR_URL_RE);
	if (!match) return null;
	return `https://github.com/${match[1]}`.toLowerCase();
}

function generateWorkingBranch(task: string): string {
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.slice(0, 40);
	const suffix = Math.random().toString(36).slice(2, 8);
	return `dobby/${slug}-${suffix}`;
}

export async function POST(request: NextRequest) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = jobSubmissionSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Validation failed", details: z.prettifyError(parsed.error) },
			{ status: 400 },
		);
	}

	const input = parsed.data;

	// Validate existingPrUrl matches repository
	if (input.existingPrUrl) {
		const prRepo = extractRepoFromPrUrl(input.existingPrUrl);
		const normalizedRepo = normalizeRepoUrl(input.repository);
		if (prRepo !== normalizedRepo) {
			return NextResponse.json(
				{
					error: "existingPrUrl does not match the provided repository",
				},
				{ status: 400 },
			);
		}
	}

	// MPP-Token validation (placeholder — full implementation in Task 14)
	const mppToken = request.headers.get("MPP-Token");
	if (!mppToken) {
		return NextResponse.json({ error: "MPP-Token header is required" }, { status: 401 });
	}

	const env = getEnv();

	// Check concurrency
	const db = getDb();
	const activeCountResult = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(jobs)
		.where(inArray(jobs.status, [...ACTIVE_STATUSES]));

	const activeJobCount = activeCountResult[0]?.count ?? 0;

	if (!hasCapacity(activeJobCount, env.DOBBY_ACCOUNT_VCPU_LIMIT, env.DOBBY_VM_CPU)) {
		return NextResponse.json({ error: "At capacity — too many concurrent jobs" }, { status: 429 });
	}

	// Generate job ID and working branch
	const jobId = generateJobId();
	const workingBranch = input.existingPrUrl
		? input.baseBranch // Will be overridden by runner when following existing PR
		: generateWorkingBranch(input.task);

	// Encrypt secrets
	const encryptedGitCredentials = await encrypt(input.gitToken);
	const encryptedSecrets = input.secrets ? await encrypt(JSON.stringify(input.secrets)) : null;

	// Calculate authorized budget
	const authorizedFlops = calculateMaxBudget(env.DOBBY_HOURLY_RATE, env.DOBBY_MAX_JOB_HOURS);

	// Insert job row
	await db.insert(jobs).values({
		id: jobId,
		status: "pending",
		repository: input.repository,
		baseBranch: input.baseBranch,
		workingBranch,
		task: input.task,
		existingPrUrl: input.existingPrUrl ?? null,
		encryptedGitCredentials,
		encryptedSecrets,
		authorizedFlops: authorizedFlops.toString(),
		mppChannelId: mppToken,
	});

	// TODO: Provision Fargate task (Task 6) — will call provisionTask() here
	// For now, job stays in "pending" status until ECS orchestration is implemented

	return NextResponse.json({ id: jobId, status: "pending" }, { status: 201 });
}
