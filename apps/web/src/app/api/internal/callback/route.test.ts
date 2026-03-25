import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock KMS
const mockDecrypt = vi.fn();
vi.mock("../../../../lib/kms", () => ({
	decrypt: (...args: unknown[]) => mockDecrypt(...args),
}));

// Mock ECS provisionTask and stopTask
const mockProvisionTask = vi.fn();
const mockStopTask = vi.fn();
vi.mock("../../../../domain/jobs/ecs", () => ({
	provisionTask: (...args: unknown[]) => mockProvisionTask(...args),
	stopTask: (...args: unknown[]) => mockStopTask(...args),
}));

// Mock database
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();

let selectResult: unknown[] = [];

const mockSelectWhere = vi.fn().mockImplementation(() => selectResult);

const mockReturning = vi.fn();

vi.mock("../../../../db", () => ({
	getDb: () => ({
		update: (...args: unknown[]) => {
			mockUpdate(...args);
			return {
				set: (...setArgs: unknown[]) => {
					mockSet(...setArgs);
					return {
						where: (...whereArgs: unknown[]) => {
							const whereResult = mockUpdateWhere(...whereArgs);
							// Return a thenable that also supports .returning() for CAS queries
							const obj = Promise.resolve(whereResult);
							Object.assign(obj, {
								returning: (...retArgs: unknown[]) => mockReturning(...retArgs),
							});
							return obj;
						},
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
		inputTokens: null,
		outputTokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
		bedrockCostUsd: null,
		containerCostUsd: null,
		costUsd: null,
		submittedAt: new Date("2026-03-21T10:00:00Z"),
		startedAt: new Date("2026-03-21T10:01:00Z"),
		finishedAt: null,
		resumeCount: 0,
		lastCheckpointCommit: null,
		interruptedAt: null,
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
		mockReturning.mockReset().mockResolvedValue([{ id: "db_V1StGXR8_Z5jdHi6B-myT" }]);
		mockSelect.mockReset();
		mockFrom.mockReset();
		mockSelectWhere.mockReset().mockImplementation(() => selectResult);
		mockDecrypt.mockReset();
		mockProvisionTask.mockReset();

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

	it("accepts intermediate status cloning and sets startedAt", async () => {
		selectResult = [makeJob({ status: "provisioning", startedAt: null })];
		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "cloning",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.status).toBe("cloning");
		expect(updateData.startedAt).toBeInstanceOf(Date);
	});

	it("does not overwrite startedAt on subsequent intermediate status", async () => {
		const existingStartedAt = new Date("2026-03-21T10:01:00Z");
		selectResult = [makeJob({ status: "cloning", startedAt: existingStartedAt })];
		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "executing",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.status).toBe("executing");
		expect(updateData.startedAt).toBeUndefined();
	});

	it("handles race condition: resumes when job is already interrupted", async () => {
		selectResult = [makeJob({ status: "interrupted" })];
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
		// Should trigger resume even though job was already interrupted
		expect(mockProvisionTask).toHaveBeenCalledOnce();
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

	it("does not set token fields when no token data in callback", async () => {
		setJobFinalizing();

		const { POST } = await import("./route");
		const req = createRequest(validCompletedBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.inputTokens).toBeUndefined();
		expect(updateData.outputTokens).toBeUndefined();
	});

	it("accumulates token data when provided in callback", async () => {
		setJobFinalizing();
		const { POST } = await import("./route");
		const req = createRequest({
			...validCompletedBody,
			inputTokens: 50000,
			outputTokens: 10000,
			cacheReadTokens: 30000,
			cacheWriteTokens: 5000,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.inputTokens).toBe(50000);
		expect(updateData.outputTokens).toBe(10000);
		expect(updateData.cacheReadTokens).toBe(30000);
		expect(updateData.cacheWriteTokens).toBe(5000);
		expect(updateData.bedrockCostUsd).toBeDefined();
		expect(updateData.costUsd).toBeDefined();
	});

	it("accumulates tokens with existing values (incremental)", async () => {
		selectResult = [
			makeJob({
				status: "finalizing",
				inputTokens: 50000,
				outputTokens: 10000,
				cacheReadTokens: 20000,
				cacheWriteTokens: 5000,
			}),
		];
		const { POST } = await import("./route");
		const req = createRequest({
			...validCompletedBody,
			inputTokens: 30000,
			outputTokens: 5000,
			cacheReadTokens: 10000,
			cacheWriteTokens: 3000,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.inputTokens).toBe(80000); // 50K + 30K
		expect(updateData.outputTokens).toBe(15000); // 10K + 5K
		expect(updateData.cacheReadTokens).toBe(30000); // 20K + 10K
		expect(updateData.cacheWriteTokens).toBe(8000); // 5K + 3K
	});

	it("treats null existing tokens as zero for accumulation", async () => {
		selectResult = [makeJob({ status: "finalizing" })]; // all token fields null
		const { POST } = await import("./route");
		const req = createRequest({
			...validCompletedBody,
			inputTokens: 100,
			outputTokens: 200,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.inputTokens).toBe(100);
		expect(updateData.outputTokens).toBe(200);
		expect(updateData.cacheReadTokens).toBe(0);
		expect(updateData.cacheWriteTokens).toBe(0);
	});

	it("calculates bedrock cost from accumulated totals", async () => {
		setJobFinalizing();
		const { POST } = await import("./route");
		const req = createRequest({
			...validCompletedBody,
			inputTokens: 1000000, // 1M input = $5
			outputTokens: 0,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(Number(updateData.bedrockCostUsd)).toBeCloseTo(5.0, 4);
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
		expect(mockDecrypt).toHaveBeenCalledWith("encrypted-git-creds");
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

		expect(mockDecrypt).toHaveBeenCalledTimes(2);
		expect(mockDecrypt).toHaveBeenCalledWith("encrypted-git-creds");
		expect(mockDecrypt).toHaveBeenCalledWith("encrypted-secrets-blob");

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

		expect(mockSet).toHaveBeenCalledTimes(3);
		const claimUpdate = mockSet.mock.calls[1]![0] as Record<string, unknown>;
		expect(claimUpdate.status).toBe("provisioning");
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

	it("rejects stale callback when ecsTaskArn does not match", async () => {
		selectResult = [
			makeJob({ status: "cloning", ecsTaskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task" }),
		];
		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
			ecsTaskArn: "arn:aws:ecs:us-east-1:123:task/cluster/old-task",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(409);
		const json = await res.json();
		expect(json.error).toContain("Stale callback");
		expect(mockProvisionTask).not.toHaveBeenCalled();
	});

	it("accepts callback when ecsTaskArn matches current task", async () => {
		const taskArn = "arn:aws:ecs:us-east-1:123:task/cluster/current-task";
		selectResult = [makeJob({ status: "executing", ecsTaskArn: taskArn })];
		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/resumed-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
			ecsTaskArn: taskArn,
			lastCheckpointCommit: "abc123",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		expect(mockProvisionTask).toHaveBeenCalledOnce();
	});

	it("allows provisioning -> interrupted when ecsTaskArn matches (new task spot-interrupted)", async () => {
		const taskArn = "arn:aws:ecs:us-east-1:123:task/cluster/new-task";
		selectResult = [makeJob({ status: "provisioning", ecsTaskArn: taskArn, startedAt: null })];
		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/resumed-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
			ecsTaskArn: taskArn,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		expect(mockProvisionTask).toHaveBeenCalledOnce();
	});

	it("rejects stale interrupted callback without ecsTaskArn on resumed job", async () => {
		selectResult = [makeJob({ status: "provisioning", resumeCount: 1, startedAt: null })];
		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
			lastCheckpointCommit: "abc123",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(409);
		const json = await res.json();
		expect(json.error).toContain("Stale callback");
		expect(json.error).toContain("no task identity");
		expect(mockProvisionTask).not.toHaveBeenCalled();
	});

	it("accepts interrupted callback with matching ecsTaskArn on resumed job", async () => {
		const taskArn = "arn:aws:ecs:us-east-1:123:task/cluster/current-task";
		selectResult = [makeJob({ status: "executing", resumeCount: 1, ecsTaskArn: taskArn })];
		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
			ecsTaskArn: taskArn,
			lastCheckpointCommit: "abc123",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		expect(mockProvisionTask).toHaveBeenCalledOnce();
	});

	it("persists prUrl and checkpoint from SIGTERM callback on stopped job", async () => {
		selectResult = [makeJob({ status: "stopped", finishedAt: new Date() })];
		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
			prUrl: "https://github.com/org/repo/pull/99",
			lastCheckpointCommit: "deadbeef",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.ok).toBe(true);

		expect(mockSet).toHaveBeenCalledOnce();
		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.prUrl).toBe("https://github.com/org/repo/pull/99");
		expect(updateData.lastCheckpointCommit).toBe("deadbeef");
		expect(updateData.status).toBeUndefined();
		expect(mockProvisionTask).not.toHaveBeenCalled();
	});

	it("persists prUrl and checkpoint from SIGTERM callback on timed_out job", async () => {
		selectResult = [makeJob({ status: "timed_out", finishedAt: new Date() })];
		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
			prUrl: "https://github.com/org/repo/pull/42",
			lastCheckpointCommit: "abc123",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		expect(mockSet).toHaveBeenCalledOnce();
		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.prUrl).toBe("https://github.com/org/repo/pull/42");
		expect(updateData.lastCheckpointCommit).toBe("abc123");
		expect(mockProvisionTask).not.toHaveBeenCalled();
	});

	it("returns ok without DB update for SIGTERM callback with no data to persist", async () => {
		selectResult = [makeJob({ status: "stopped", finishedAt: new Date() })];
		const { POST } = await import("./route");
		const req = createRequest({
			jobId: "db_V1StGXR8_Z5jdHi6B-myT",
			status: "interrupted",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		expect(mockSet).not.toHaveBeenCalled();
		expect(mockProvisionTask).not.toHaveBeenCalled();
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

		const updateData = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(updateData.encryptedGitCredentials).toBeUndefined();
		expect(updateData.encryptedSecrets).toBeUndefined();
	});
});
