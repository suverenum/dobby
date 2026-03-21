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
		ecsTaskArn: "ecs_task_arn",
		resumeCount: "resume_count",
	},
}));

const CALLBACK_SECRET = "test-callback-secret";

const TASK_ARN = "arn:aws:ecs:us-east-1:123:task/cluster/task-id-123";

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
		ecsTaskArn: TASK_ARN,
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

function makeSpotInterruptionEvent(taskArn = TASK_ARN) {
	return {
		"detail-type": "ECS Task State Change",
		detail: {
			taskArn,
			stopCode: "SpotInterruption",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		},
	};
}

describe("POST /api/internal/ecs-event", () => {
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

		selectResult = [makeJob()];
	});

	function createRequest(body: unknown, headers?: Record<string, string>) {
		return new Request("http://localhost:3000/api/internal/ecs-event", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${CALLBACK_SECRET}`,
				...headers,
			},
			body: JSON.stringify(body),
		});
	}

	// --- Authentication ---

	it("returns 401 when Authorization header is missing", async () => {
		const { POST } = await import("./route");
		const req = createRequest(makeSpotInterruptionEvent(), { Authorization: "" });
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);
		expect(res.status).toBe(401);
		const json = await res.json();
		expect(json.error).toBe("Unauthorized");
	});

	it("returns 401 when Authorization header has wrong secret", async () => {
		const { POST } = await import("./route");
		const req = createRequest(makeSpotInterruptionEvent(), {
			Authorization: "Bearer wrong-secret",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);
		expect(res.status).toBe(401);
	});

	// --- Input validation ---

	it("returns 400 for invalid JSON body", async () => {
		const { POST } = await import("./route");
		const req = new Request("http://localhost:3000/api/internal/ecs-event", {
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

	it("returns 400 when detail-type is wrong", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			"detail-type": "EC2 Instance State Change",
			detail: { taskArn: TASK_ARN, stopCode: "SpotInterruption" },
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);
		expect(res.status).toBe(400);
	});

	it("returns 400 when detail.taskArn is missing", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			"detail-type": "ECS Task State Change",
			detail: { stopCode: "SpotInterruption" },
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);
		expect(res.status).toBe(400);
	});

	// --- Non-spot events ---

	it("ignores events that are not SpotInterruption", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			"detail-type": "ECS Task State Change",
			detail: {
				taskArn: TASK_ARN,
				stopCode: "UserInitiated",
			},
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.action).toBe("ignored");
		expect(json.reason).toBe("not a spot interruption");
		// No database calls should be made
		expect(mockSelect).not.toHaveBeenCalled();
	});

	it("ignores events with no stopCode", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			"detail-type": "ECS Task State Change",
			detail: {
				taskArn: TASK_ARN,
			},
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.action).toBe("ignored");
	});

	// --- Job lookup ---

	it("ignores spot interruption when no matching job found", async () => {
		selectResult = [];
		const { POST } = await import("./route");
		const req = createRequest(makeSpotInterruptionEvent());
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.action).toBe("ignored");
		expect(json.reason).toBe("no matching job");
	});

	it("ignores spot interruption when job status cannot transition to interrupted", async () => {
		selectResult = [makeJob({ status: "completed" })];
		const { POST } = await import("./route");
		const req = createRequest(makeSpotInterruptionEvent());
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.action).toBe("ignored");
		expect(json.reason).toContain("cannot transition to interrupted");
	});

	// --- Successful spot interruption handling ---

	it("marks job as interrupted and triggers resume on spot interruption", async () => {
		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest(makeSpotInterruptionEvent());
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.action).toBe("resumed");
		expect(json.jobId).toBe("db_V1StGXR8_Z5jdHi6B-myT");

		// First set: mark as interrupted
		const interruptUpdate = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(interruptUpdate.status).toBe("interrupted");

		// Second set: resume to provisioning with resume count increment
		const resumeUpdate = mockSet.mock.calls[1]![0] as Record<string, unknown>;
		expect(resumeUpdate.status).toBe("provisioning");

		// Third set: new ECS task ARN
		const ecsUpdate = mockSet.mock.calls[2]![0] as Record<string, unknown>;
		expect(ecsUpdate.ecsTaskArn).toBe("arn:aws:ecs:us-east-1:123:task/cluster/new-task");
		expect(ecsUpdate.ecsClusterArn).toBe("arn:aws:ecs:us-east-1:123:cluster/dobby");
	});

	it("decrypts git credentials for the new task", async () => {
		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest(makeSpotInterruptionEvent());
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		expect(mockDecrypt).toHaveBeenCalledWith("encrypted-git-creds");
		expect(mockProvisionTask).toHaveBeenCalledOnce();
		const provisionArgs = mockProvisionTask.mock.calls[0]!;
		expect(provisionArgs[1].gitToken).toBe("decrypted-git-token");
	});

	it("decrypts caller secrets when present", async () => {
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
		const req = createRequest(makeSpotInterruptionEvent());
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		expect(mockDecrypt).toHaveBeenCalledTimes(2);
		expect(mockDecrypt).toHaveBeenCalledWith("encrypted-git-creds");
		expect(mockDecrypt).toHaveBeenCalledWith("encrypted-secrets-blob");

		const provisionArgs = mockProvisionTask.mock.calls[0]!;
		expect(provisionArgs[1].secrets).toEqual({ API_KEY: "secret123" });
	});

	it("preserves lastCheckpointCommit when resuming", async () => {
		selectResult = [makeJob({ lastCheckpointCommit: "abc123def456" })];

		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest(makeSpotInterruptionEvent());
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const provisionArgs = mockProvisionTask.mock.calls[0]!;
		expect(provisionArgs[0].lastCheckpointCommit).toBe("abc123def456");
	});

	it("handles resume from provisioning status", async () => {
		selectResult = [makeJob({ status: "provisioning" })];

		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest(makeSpotInterruptionEvent());
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.action).toBe("resumed");
	});

	it("handles resume from cloning status", async () => {
		selectResult = [makeJob({ status: "cloning" })];

		mockDecrypt.mockResolvedValueOnce("decrypted-git-token");
		mockProvisionTask.mockResolvedValueOnce({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/new-task",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		});

		const { POST } = await import("./route");
		const req = createRequest(makeSpotInterruptionEvent());
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.action).toBe("resumed");
	});

	// --- Resume failure handling ---

	it("returns 200 even if resume fails (non-fatal)", async () => {
		mockDecrypt.mockRejectedValueOnce(new Error("KMS unavailable"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { POST } = await import("./route");
		const req = createRequest(makeSpotInterruptionEvent());
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.action).toBe("resumed");
		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it("fails resume when job has no encrypted git credentials", async () => {
		selectResult = [makeJob({ encryptedGitCredentials: "" })];
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { POST } = await import("./route");
		const req = createRequest(makeSpotInterruptionEvent());
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(200);
		// Job still gets marked as interrupted even if resume fails
		const interruptUpdate = mockSet.mock.calls[0]![0] as Record<string, unknown>;
		expect(interruptUpdate.status).toBe("interrupted");

		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});
