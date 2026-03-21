import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnv } from "../../../../lib/env";

// Mock dependencies
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockUpdateWhere = vi.fn();

vi.mock("../../../../db", () => ({
	getDb: () => ({
		select: mockSelect,
		update: mockUpdate,
	}),
}));

const mockStopTask = vi.fn();

vi.mock("../../../../domain/jobs/ecs", () => ({
	stopTask: (...args: unknown[]) => mockStopTask(...args),
}));

function setRequiredEnv() {
	vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
	vi.stubEnv("AWS_REGION", "us-east-1");
	vi.stubEnv("DOBBY_MAX_JOB_HOURS", "6");
	vi.stubEnv("DOBBY_HOURLY_RATE", "100");
	vi.stubEnv("ECS_CLUSTER_ARN", "arn:aws:ecs:us-east-1:123456789:cluster/dobby");
}

function makeJob(overrides: Record<string, unknown> = {}) {
	return {
		id: "db_testjob123456789012",
		status: "executing",
		repository: "https://github.com/org/repo",
		baseBranch: "main",
		workingBranch: "dobby/fix-bug",
		task: "Fix the login bug",
		existingPrUrl: null,
		prUrl: null,
		encryptedGitCredentials: "encrypted-creds",
		encryptedSecrets: "encrypted-secrets",
		ecsTaskArn: "arn:aws:ecs:us-east-1:123456789:task/dobby/task123",
		ecsClusterArn: "arn:aws:ecs:us-east-1:123456789:cluster/dobby",
		logStreamName: null,
		authorizedFlops: "600",
		costFlops: null,
		mppChannelId: null,
		submittedAt: new Date("2026-03-20T00:00:00Z"),
		startedAt: new Date("2026-03-20T00:05:00Z"),
		finishedAt: null,
		resumeCount: 0,
		lastCheckpointCommit: null,
		...overrides,
	};
}

function setupDbChain(overdueJobs: ReturnType<typeof makeJob>[]) {
	mockWhere.mockResolvedValue(overdueJobs);
	mockFrom.mockReturnValue({ where: mockWhere });
	mockSelect.mockReturnValue({ from: mockFrom });

	mockUpdateWhere.mockResolvedValue(undefined);
	mockSet.mockReturnValue({ where: mockUpdateWhere });
	mockUpdate.mockReturnValue({ set: mockSet });
}

describe("GET /api/cron/timeout", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.unstubAllEnvs();
		_resetEnv();
	});

	it("returns 401 when CRON_SECRET is set and Authorization header is missing", async () => {
		setRequiredEnv();
		vi.stubEnv("CRON_SECRET", "my-cron-secret");

		const { GET } = await import("./route");

		const request = new Request("http://localhost/api/cron/timeout");
		const response = await GET(request);

		expect(response.status).toBe(401);
	});

	it("returns 401 when CRON_SECRET is set and Authorization header is wrong", async () => {
		setRequiredEnv();
		vi.stubEnv("CRON_SECRET", "my-cron-secret");

		const { GET } = await import("./route");

		const request = new Request("http://localhost/api/cron/timeout", {
			headers: { Authorization: "Bearer wrong-secret" },
		});
		const response = await GET(request);

		expect(response.status).toBe(401);
	});

	it("allows request when CRON_SECRET matches", async () => {
		setRequiredEnv();
		vi.stubEnv("CRON_SECRET", "my-cron-secret");
		setupDbChain([]);

		const { GET } = await import("./route");

		const request = new Request("http://localhost/api/cron/timeout", {
			headers: { Authorization: "Bearer my-cron-secret" },
		});
		const response = await GET(request);

		expect(response.status).toBe(200);
	});

	it("allows request when CRON_SECRET is not set", async () => {
		setRequiredEnv();
		setupDbChain([]);

		const { GET } = await import("./route");

		const request = new Request("http://localhost/api/cron/timeout");
		const response = await GET(request);

		expect(response.status).toBe(200);
	});

	it("returns empty results when no overdue jobs found", async () => {
		setRequiredEnv();
		setupDbChain([]);

		const { GET } = await import("./route");

		const request = new Request("http://localhost/api/cron/timeout");
		const response = await GET(request);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.timedOut).toBe(0);
		expect(body.failed).toBe(0);
		expect(body.results).toEqual([]);
	});

	it("stops overdue jobs and updates their status to timed_out", async () => {
		setRequiredEnv();
		const job = makeJob();
		setupDbChain([job]);
		mockStopTask.mockResolvedValue(undefined);

		const { GET } = await import("./route");

		const request = new Request("http://localhost/api/cron/timeout");
		const response = await GET(request);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.timedOut).toBe(1);
		expect(body.failed).toBe(0);

		// Verify stopTask was called
		expect(mockStopTask).toHaveBeenCalledOnce();
		expect(mockStopTask.mock.calls[0]![0].id).toBe(job.id);

		// Verify job was updated
		expect(mockUpdate).toHaveBeenCalled();
		expect(mockSet).toHaveBeenCalled();
		const updateArg = mockSet.mock.calls[0]![0];
		expect(updateArg.status).toBe("timed_out");
		expect(updateArg.finishedAt).toBeInstanceOf(Date);
		expect(updateArg.encryptedGitCredentials).toBe("");
		expect(updateArg.encryptedSecrets).toBeNull();
	});

	it("calculates cost for timed-out jobs with startedAt", async () => {
		setRequiredEnv();
		const startedAt = new Date(Date.now() - 7 * 60 * 60 * 1000); // 7 hours ago
		const job = makeJob({ startedAt });
		setupDbChain([job]);
		mockStopTask.mockResolvedValue(undefined);

		const { GET } = await import("./route");

		const request = new Request("http://localhost/api/cron/timeout");
		const response = await GET(request);

		expect(response.status).toBe(200);

		const updateArg = mockSet.mock.calls[0]![0];
		// Cost should be capped at hourlyRate * maxJobHours = 100 * 6 = 600
		expect(updateArg.costFlops).toBeDefined();
		const cost = Number.parseFloat(updateArg.costFlops);
		expect(cost).toBeGreaterThan(0);
		expect(cost).toBeLessThanOrEqual(600); // Max cap
	});

	it("handles multiple overdue jobs", async () => {
		setRequiredEnv();
		const job1 = makeJob({ id: "db_job1_1234567890123" });
		const job2 = makeJob({ id: "db_job2_1234567890123" });
		setupDbChain([job1, job2]);
		mockStopTask.mockResolvedValue(undefined);

		const { GET } = await import("./route");

		const request = new Request("http://localhost/api/cron/timeout");
		const response = await GET(request);

		const body = await response.json();
		expect(body.timedOut).toBe(2);
		expect(body.results).toHaveLength(2);
		expect(mockStopTask).toHaveBeenCalledTimes(2);
	});

	it("skips stopTask for jobs without ecsTaskArn", async () => {
		setRequiredEnv();
		const job = makeJob({ ecsTaskArn: null });
		setupDbChain([job]);

		const { GET } = await import("./route");

		const request = new Request("http://localhost/api/cron/timeout");
		const response = await GET(request);

		const body = await response.json();
		expect(body.timedOut).toBe(1);
		expect(mockStopTask).not.toHaveBeenCalled();

		// Still updates status
		const updateArg = mockSet.mock.calls[0]![0];
		expect(updateArg.status).toBe("timed_out");
	});

	it("handles stopTask errors gracefully and reports failure", async () => {
		setRequiredEnv();
		const job = makeJob();
		setupDbChain([job]);
		mockStopTask.mockRejectedValue(new Error("ECS service unavailable"));

		const { GET } = await import("./route");

		const request = new Request("http://localhost/api/cron/timeout");
		const response = await GET(request);

		const body = await response.json();
		expect(body.timedOut).toBe(0);
		expect(body.failed).toBe(1);
		expect(body.results[0].error).toBe("ECS service unavailable");
	});

	it("clears encrypted secrets on timeout", async () => {
		setRequiredEnv();
		const job = makeJob();
		setupDbChain([job]);
		mockStopTask.mockResolvedValue(undefined);

		const { GET } = await import("./route");

		const request = new Request("http://localhost/api/cron/timeout");
		await GET(request);

		const updateArg = mockSet.mock.calls[0]![0];
		expect(updateArg.encryptedGitCredentials).toBe("");
		expect(updateArg.encryptedSecrets).toBeNull();
	});
});
