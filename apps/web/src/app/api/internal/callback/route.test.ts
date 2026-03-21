import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock KMS
const mockDecrypt = vi.fn();
vi.mock("../../../../lib/kms", () => ({
	decrypt: (...args: unknown[]) => mockDecrypt(...args),
}));

// Mock ECS provisionTask
const mockProvisionTask = vi.fn();
vi.mock("../../../../domain/jobs/ecs", () => ({
	provisionTask: (...args: unknown[]) => mockProvisionTask(...args),
}));

// Mock MPP settlePayment
const mockSettlePayment = vi.fn();
vi.mock("../../../../lib/mpp", () => ({
	settlePayment: (...args: unknown[]) => mockSettlePayment(...args),
}));

// Mock database
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();

let selectResult: unknown[] = [];

const mockSelectWhere = vi.fn().mockImplementation(() => selectResult);

vi.mock("../../../../db", () => ({
	getDb: () => ({
		update: (...args: unknown[]) => {
			mockUpdate(...args);
			return {
				set: (...setArgs: unknown[]) => {
					mockSet(...setArgs);
					return {
						where: (...whereArgs: unknown[]) => mockUpdateWhere(...whereArgs),
					};
				},
			};
		},
		select: (...args: unknown[]) => {
			mockSelect(...args);
			return {
				from: (...fromArgs: unknown[]) => {
					mockFrom(...fromArgs);
					return {
						where: (...whereArgs: unknown[]) => mockSelectWhere(...whereArgs),
					};
				},
			};
		},
	}),
}));

vi.mock("../../../../db/schema", () => ({
	jobs: {
		id: "id",
		status: "status",
		resumeCount: "resume_count",
	},
}));

const CALLBACK_SECRET = "test-callback-secret";

function makeJob(overrides: Record<string, unknown> = {}) {
	return {
		id: "db_V1StGXR8_Z5jdHi6B-myT",
		status: "executing",
		repository: "https://github.com/org/repo",
		baseBranch: "main",
		workingBranch: "dobby/fix-bug-abc123",
		task: "Fix the login bug",
		existingPrUrl: null,
		prUrl: null,
		encryptedGitCredentials: "encrypted-git-creds",
		encryptedSecrets: null,
		ecsTaskArn: "arn:aws:ecs:us-east-1:123:task/cluster/task-id",
		ecsClusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		logStreamName: null,
		authorizedFlops: "600",
		costFlops: null,
		mppChannelId: "mpp-test",
		submittedAt: new Date("2026-03-21T10:00:00Z"),
		startedAt: new Date("2026-03-21T10:01:00Z"),
		finishedAt: null,
		resumeCount: 0,
		lastCheckpointCommit: null,
		...overrides,
	};
}

describe("POST /api/internal/callback", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		vi.stubEnv("KMS_KEY_ID", "arn:aws:kms:us-east-1:123:key/test");
		vi.stubEnv("AWS_REGION", "us-east-1");
		vi.stubEnv("DOBBY_CALLBACK_SECRET", CALLBACK_SECRET);
		vi.stubEnv("ECS_CLUSTER_ARN", "arn:aws:ecs:us-east-1:123:cluster/dobby");
		vi.stubEnv("ECS_TASK_DEFINITION_ARN", "arn:aws:ecs:us-east-1:123:task-definition/runner:1");
		vi.stubEnv("ECS_SUBNETS", "subnet-abc");
		vi.stubEnv("ECS_SECURITY_GROUPS", "sg-abc");

		mockUpdate.mockReset();
		mockSet.mockReset();
		mockUpdateWhere.mockReset().mockResolvedValue(undefined);
		mockSelect.mockReset();
		mockFrom.mockReset();
		mockSelectWhere.mockReset().mockImplementation(() => selectResult);
		mockDecrypt.mockReset();
		mockProvisionTask.mockReset();
		mockSettlePayment.mockReset().mockResolvedValue({
			settled: true,
			channelId: "mpp-test",
			settledAmount: 0,
			refundedAmount: 0,
		});

		selectResult = [makeJob()];
	});

	function createRequest(body: unknown, headers?: Record<string, string>) {
		return new Request("http://localhost:3000/api/internal/callback", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${CALLBACK_SECRET}`,
				...headers,
			},
			body: JSON.stringify(body),
		});
	}

	const validCompletedBody = {
		jobId: "db_V1StGXR8_Z5jdHi6B-myT",
		status: "completed",
		prUrl: "https://github.com/org/repo/pull/42",
	};

	// For completed callbacks, job must be in "finalizing" status (executing -> finalizing -> completed)
	function setJobFinalizing() {
		selectResult = [makeJob({ status: "finalizing" })];
	}

	it("returns 401 when Authorization header is missing", async () => {
		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody, { Authorization: "" });
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(401);
		const json = await res.json();
		expect(json.error).toBe("Unauthorized");
	});

	it("returns 401 when Authorization header has wrong secret", async () => {
		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody, {
			Authorization: "Bearer wrong-secret",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(401);
	});

	it("returns 400 for invalid JSON body", async () => {
		const { POST } = await import("./route");
		const req = new Request("http://localhost:3000/api/internal/callback", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${CALLBACK_SECRET}`,
			},
			body: "not json",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toBe("Invalid JSON body");
	});

	it("returns 400 when jobId is missing", async () => {
		const { POST } = await import("./route");
		const req = createRequest({ status: "completed" });
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(400);
	});

	it("returns 400 when status is invalid", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "running",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(400);
	});

	it("returns 400 for invalid job ID format", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "invalid-id",
			status: "completed",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toContain("Invalid job ID");
	});

	it("returns 404 when job not found", async () => {
		selectResult = [];
		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.error).toBe("Job not found");
	});

	it("returns 409 for invalid status transition", async () => {
		selectResult = [makeJob({ status: "completed" })];
		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(409);
		const json = await res.json();
		expect(json.error).toContain("Invalid status transition");
	});

	it("updates job status to completed and clears secrets", async () => {
		setJobFinalizing();
		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.ok).toBe(true);

		// Verify update was called with correct fields
		expect(mockSet).toHaveBeenCalledOnce();
		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.status).toBe("completed");
		expect(updateData.prUrl).toBe("https://github.com/org/repo/pull/42");
		expect(updateData.finishedAt).toBeInstanceOf(Date);
		expect(updateData.encryptedGitCredentials).toBe("");
		expect(updateData.encryptedSecrets).toBeNull();
		// Cost should be calculated
		expect(updateData.costFlops).toBeDefined();
	});

	it("updates job status to failed and clears secrets", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "failed",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.status).toBe("failed");
		expect(updateData.encryptedGitCredentials).toBe("");
		expect(updateData.encryptedSecrets).toBeNull();
	});

	it("calculates cost on terminal status when job has startedAt", async () => {
		const startedAt = new Date("2026-03-21T10:00:00Z");
		selectResult = [makeJob({ status: "finalizing", startedAt })];

		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		// costFlops should be a string representation of the cost
		expect(updateData.costFlops).toBeDefined();
		expect(typeof updateData.costFlops).toBe("string");
	});

	it("does not calculate cost when job has no startedAt", async () => {
		selectResult = [makeJob({ status: "finalizing", startedAt: null })];

		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.costFlops).toBeUndefined();
	});

	it("stores prUrl when provided", async () => {
		setJobFinalizing();
		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.prUrl).toBe("https://github.com/org/repo/pull/42");
	});

	it("stores lastCheckpointCommit when provided", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
			lastCheckpointCommit: "abc123def456",
		});
		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.lastCheckpointCommit).toBe("abc123def456");
	});

	it("triggers resume flow on interrupted status", async () => {
		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
			lastCheckpointCommit: "abc123",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);

		// Verify decrypt was called
		expect(mockDecrypt).toHaveBeenCalledWith("encrypted-git-creds");

		// Verify provisionTask was called
		expect(mockProvisionTask).toHaveBeenCalledOnce();
		const provisionArgs = mockProvisionTask.mock.calls[0]!;
		expect(provisionArgs[0].lastCheckpointCommit).toBe("abc123");
		expect(provisionArgs[1].gitToken).toBe("decrypted-git-token");
	});

	it("resumes job with decrypted caller secrets", async () => {
		selectResult = [
			makeJob({
				encryptedSecrets: "encrypted-secrets-blob",
			}),
		];

		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockDecrypt.mockResolvedValueOnce(JSON.stringify({ API_KEY: "secret123" }));
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		// Verify both git creds and secrets were decrypted
		expect(mockDecrypt).toHaveBeenCalledTimes(2);
		expect(mockDecrypt).toHaveBeenCalledWith("encrypted-git-creds");
		expect(mockDecrypt).toHaveBeenCalledWith("encrypted-secrets-blob");

		// Verify provisionTask received decrypted secrets
		const provisionArgs = mockProvisionTask.mock.calls[0]!;
		expect(provisionArgs[1].secrets).toEqual({ API_KEY: "secret123" });
	});

	it("increments resumeCount and updates status to provisioning on resume", async () => {
		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		// First set call: initial status update to interrupted
		// Second set call: resume update to provisioning with resumeCount increment
		// Third set call: new ECS task ARN
		expect(mockSet).toHaveBeenCalledTimes(3);

		const resumeUpdate = mockSet.mock.calls[1]![0] as Record<string, unknown>;
		expect(resumeUpdate.status).toBe("provisioning");
	});

	it("stores new ECS task ARN after resume", async () => {
		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task-id",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		// Third set call: ECS ARN update
		const ecsUpdate = mockSet.mock.calls[2]![0] as Record<string, unknown>;
		expect(ecsUpdate.ecsTaskArn).toBe("arn:aws:ecs:us-east-1:123:task/cluster/new-task-id");
		expect(ecsUpdate.ecsClusterArn).toBe("arn:aws:ecs:us-east-1:123:cluster/dobby");
	});

	it("returns 200 even if resume fails (non-fatal)", async () => {
		mockDecrypt.mockRejectedValueOnce(new Error("KMS unavailable"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it("settles MPP payment on terminal status", async () => {
		setJobFinalizing();
		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		expect(mockSettlePayment).toHaveBeenCalledOnce();
		const [channelId, cost, authorized] = mockSettlePayment.mock.calls[0]!;
		expect(channelId).toBe("mpp-test");
		expect(typeof cost).toBe("number");
		expect(authorized).toBe(600);
	});

	it("does not settle MPP payment when mppChannelId is null", async () => {
		selectResult = [makeJob({ status: "finalizing", mppChannelId: null })];
		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		expect(mockSettlePayment).not.toHaveBeenCalled();
	});

	it("does not fail if MPP settlement throws", async () => {
		setJobFinalizing();
		mockSettlePayment.mockRejectedValueOnce(new Error("MPP down"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		// Allow async settlement error to propagate
		await new Promise((resolve) => setTimeout(resolve, 10));
		consoleSpy.mockRestore();
	});

	it("does not clear secrets on interrupted status", async () => {
		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		// First set call should NOT clear secrets (interrupted is not terminal)
		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.encryptedGitCredentials).toBeUndefined();
		expect(updateData.encryptedSecrets).toBeUndefined();
	});
});
