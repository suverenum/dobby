import { eq, inArray, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import {
	ACTIVE_STATUSES,
	calculateMaxBudget,
	generateJobId,
	hasCapacity,
	provisionTask,
	stopTask,
} from "../../../../domain/jobs";
import { getEnv } from "../../../../lib/env";
import { encrypt } from "../../../../lib/kms";
import { MppError, settlePayment, validatePreauthorization } from "../../../../lib/mpp";
import { sendNotification } from "../../../../lib/telegram";

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
	workingBranch: z
		.string()
		.regex(/^[a-zA-Z0-9._/-]+$/, "workingBranch must be a valid git branch name")
		.optional(),
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
	const suffix = crypto.randomUUID().slice(0, 8);
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

	// Authentication: Bearer token or MPP-Token
	const env = getEnv();
	const authHeader = request.headers.get("Authorization");
	const mppToken = request.headers.get("MPP-Token");

	// Bearer token auth (simple API token)
	if (env.DOBBY_API_TOKEN) {
		const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
		if (bearerToken === env.DOBBY_API_TOKEN) {
			// Authenticated via API token — skip MPP validation
		} else if (!mppToken) {
			return NextResponse.json(
				{ error: "Authorization required. Provide Bearer token or MPP-Token header." },
				{ status: 401 },
			);
		}
	}

	// MPP-Token validation (required if not authenticated via Bearer token)
	const isApiTokenAuth =
		env.DOBBY_API_TOKEN &&
		authHeader?.startsWith("Bearer ") &&
		authHeader.slice(7) === env.DOBBY_API_TOKEN;

	if (!isApiTokenAuth && !mppToken) {
		return NextResponse.json({ error: "MPP-Token header is required" }, { status: 402 });
	}

	// Validate MPP preauthorization covers max budget
	const maxBudget = calculateMaxBudget(env.DOBBY_HOURLY_RATE, env.DOBBY_MAX_JOB_HOURS);
	let mppResult: Awaited<ReturnType<typeof validatePreauthorization>>;
	if (isApiTokenAuth && !mppToken) {
		// API token auth — skip MPP, use placeholder channel
		mppResult = {
			valid: true,
			channelId: `api-token-${crypto.randomUUID().slice(0, 8)}`,
			authorizedAmount: maxBudget,
		};
	} else {
		try {
			mppResult = await validatePreauthorization(mppToken!, maxBudget);
		} catch (error) {
			if (error instanceof MppError) {
				return NextResponse.json({ error: error.message }, { status: 402 });
			}
			throw error;
		}
	}

	if (!mppResult.valid) {
		return NextResponse.json(
			{ error: "MPP preauthorization insufficient for max job budget" },
			{ status: 402 },
		);
	}

	// Check concurrency (include "pending" to prevent burst submissions bypassing the limit)
	const db = getDb();
	const concurrencyStatuses = [...ACTIVE_STATUSES, "pending" as const];
	const activeCountResult = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(jobs)
		.where(inArray(jobs.status, concurrencyStatuses));

	const activeJobCount = activeCountResult[0]?.count ?? 0;

	if (!hasCapacity(activeJobCount, env.DOBBY_ACCOUNT_VCPU_LIMIT, env.DOBBY_VM_CPU)) {
		return NextResponse.json({ error: "At capacity — too many concurrent jobs" }, { status: 429 });
	}

	// Generate job ID and working branch
	const jobId = generateJobId();
	const workingBranch = input.existingPrUrl
		? input.baseBranch // Will be overridden by runner when following existing PR
		: (input.workingBranch ?? generateWorkingBranch(input.task));

	// Encrypt secrets
	const encryptedGitCredentials = await encrypt(input.gitToken);
	const encryptedSecrets = input.secrets ? await encrypt(JSON.stringify(input.secrets)) : null;

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
		authorizedFlops: maxBudget.toString(),
		mppChannelId: mppResult.channelId,
	});

	// Provision Fargate task
	let provisionResult: Awaited<ReturnType<typeof provisionTask>> | undefined;
	try {
		const decryptedSecrets: { gitToken: string; secrets?: Record<string, string> } = {
			gitToken: input.gitToken,
		};
		if (input.secrets) {
			decryptedSecrets.secrets = input.secrets;
		}

		const jobForProvision = {
			id: jobId,
			task: input.task,
			repository: input.repository,
			baseBranch: input.baseBranch,
			workingBranch,
			existingPrUrl: input.existingPrUrl ?? null,
			lastCheckpointCommit: null,
		} as Parameters<typeof provisionTask>[0];

		provisionResult = await provisionTask(jobForProvision, decryptedSecrets);

		// Derive log stream name from task ARN (awslogs format: prefix/container-name/task-id)
		const taskId = provisionResult.taskArn.split("/").pop();
		const logStreamName = taskId ? `runner/dobby-runner/${taskId}` : null;

		await db
			.update(jobs)
			.set({
				status: "provisioning",
				ecsTaskArn: provisionResult.taskArn,
				ecsClusterArn: provisionResult.clusterArn,
				...(logStreamName && { logStreamName }),
			})
			.where(eq(jobs.id, jobId));

		// Send Telegram notification (non-blocking)
		sendNotification(
			{
				id: jobId,
				task: input.task,
				repository: input.repository,
				prUrl: null,
				startedAt: null,
				finishedAt: null,
				costFlops: null,
				resumeCount: 0,
			},
			"provisioning",
		).catch((err) => {
			console.error(`Failed to send Telegram notification for job ${jobId}:`, err);
		});

		return NextResponse.json({ id: jobId, status: "provisioning" }, { status: 201 });
	} catch (error) {
		// Stop orphaned ECS task if it was provisioned but the DB write failed
		if (provisionResult) {
			const orphanedJob = {
				id: jobId,
				ecsTaskArn: provisionResult.taskArn,
				ecsClusterArn: provisionResult.clusterArn,
			} as Parameters<typeof stopTask>[0];
			try {
				await stopTask(orphanedJob);
			} catch (stopErr) {
				console.error(
					`CRITICAL: Failed to stop orphaned ECS task ${provisionResult.taskArn} for job ${jobId} — task may be stranded:`,
					stopErr,
				);
			}
		}

		// Mark job as failed if provisioning fails
		await db
			.update(jobs)
			.set({
				status: "failed",
				finishedAt: new Date(),
				encryptedGitCredentials: "",
				encryptedSecrets: null,
			})
			.where(eq(jobs.id, jobId));

		// Settle MPP payment with zero cost to release preauthorization
		if (mppResult.channelId) {
			settlePayment(mppResult.channelId, 0, maxBudget).catch((settleErr) => {
				console.error(`Failed to settle MPP payment for failed job ${jobId}:`, settleErr);
			});
		}

		console.error(`Failed to provision ECS task for job ${jobId}:`, error);
		return NextResponse.json(
			{ error: "Failed to provision job", id: jobId, status: "failed" },
			{ status: 500 },
		);
	}
}
