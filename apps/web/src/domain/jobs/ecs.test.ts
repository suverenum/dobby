import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnv } from "../../lib/env";
import { _resetClient, provisionTask, stopTask } from "./ecs";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-ecs", () => {
	return {
		ECSClient: vi.fn().mockImplementation(() => ({
			send: mockSend,
		})),
		RunTaskCommand: vi.fn().mockImplementation((input) => ({
			_type: "RunTaskCommand",
			input,
		})),
		StopTaskCommand: vi.fn().mockImplementation((input) => ({
			_type: "StopTaskCommand",
			input,
		})),
	};
});

function setRequiredEnv() {
	vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
	vi.stubEnv("AWS_REGION", "us-east-1");
	vi.stubEnv("ECS_CLUSTER_ARN", "arn:aws:ecs:us-east-1:123456789:cluster/dobby");
	vi.stubEnv(
		"ECS_TASK_DEFINITION_ARN",
		"arn:aws:ecs:us-east-1:123456789:task-definition/dobby-runner:1",
	);
	vi.stubEnv("ECS_SUBNETS", "subnet-abc123,subnet-def456");
	vi.stubEnv("ECS_SECURITY_GROUPS", "sg-123456");
	vi.stubEnv("KMS_KEY_ID", "arn:aws:kms:us-east-1:123456789:key/test-key");
}

function makeJob(overrides: Record<string, unknown> = {}) {
	return {
		id: "db_testjob123456789012",
		status: "pending",
		repository: "https://github.com/org/repo",
		baseBranch: "main",
		workingBranch: "dobby/fix-bug-abc123",
		task: "Fix the login bug",
		existingPrUrl: null,
		prUrl: null,
		encryptedGitCredentials: "encrypted-creds",
		encryptedSecrets: null,
		ecsTaskArn: null,
		ecsClusterArn: null,
		logStreamName: null,
		authorizedFlops: "600",
		costFlops: null,
		mppChannelId: "mpp-channel-1",
		submittedAt: new Date(),
		startedAt: null,
		finishedAt: null,
		resumeCount: 0,
		lastCheckpointCommit: null,
		interruptedAt: null,
		...overrides,
	} as const;
}

describe("ecs", () => {
	beforeEach(() => {
		mockSend.mockReset();
		_resetClient();
		vi.unstubAllEnvs();
		_resetEnv();
	});

	describe("provisionTask", () => {
		it("calls RunTask with correct Fargate Spot params", async () => {
			setRequiredEnv();

			const taskArn = "arn:aws:ecs:us-east-1:123456789:task/dobby/abc123";
			const clusterArn = "arn:aws:ecs:us-east-1:123456789:cluster/dobby";
			mockSend.mockResolvedValueOnce({
				tasks: [{ taskArn, clusterArn }],
				failures: [],
			});

			const job = makeJob();
			const result = await provisionTask(job, {
				gitToken: "ghp_test123",
			});

			expect(result.taskArn).toBe(taskArn);
			expect(result.clusterArn).toBe(clusterArn);
			expect(mockSend).toHaveBeenCalledOnce();

			const call = mockSend.mock.calls[0]![0];
			const input = call.input;

			// Verify cluster and task definition
			expect(input.cluster).toBe("arn:aws:ecs:us-east-1:123456789:cluster/dobby");
			expect(input.taskDefinition).toBe(
				"arn:aws:ecs:us-east-1:123456789:task-definition/dobby-runner:1",
			);

			// Verify Fargate Spot capacity provider
			expect(input.capacityProviderStrategy).toEqual([
				{ capacityProvider: "FARGATE_SPOT", weight: 1 },
			]);

			// Verify network config with subnets and security groups
			expect(input.networkConfiguration.awsvpcConfiguration.subnets).toEqual([
				"subnet-abc123",
				"subnet-def456",
			]);
			expect(input.networkConfiguration.awsvpcConfiguration.securityGroups).toEqual(["sg-123456"]);
			expect(input.networkConfiguration.awsvpcConfiguration.assignPublicIp).toBe("ENABLED");

			// Verify resource overrides (4 vCPU = 4096 CPU units, 16 GB = 16384 MiB)
			expect(input.overrides.cpu).toBe("4096");
			expect(input.overrides.memory).toBe("16384");
			expect(input.overrides.ephemeralStorage.sizeInGiB).toBe(20);
		});

		it("injects correct container environment variables", async () => {
			setRequiredEnv();
			vi.stubEnv("DOBBY_CALLBACK_URL", "https://dobby.rent");
			vi.stubEnv("DOBBY_CALLBACK_SECRET", "test-secret-123");

			mockSend.mockResolvedValueOnce({
				tasks: [{ taskArn: "arn:task/1", clusterArn: "arn:cluster/1" }],
				failures: [],
			});

			const job = makeJob({
				lastCheckpointCommit: "abc123sha",
				existingPrUrl: "https://github.com/org/repo/pull/42",
			});

			await provisionTask(job, {
				gitToken: "ghp_mytoken",
				secrets: { DATABASE_URL: "postgres://...", API_KEY: "sk-123" },
			});

			const call = mockSend.mock.calls[0]![0];
			const envVars = call.input.overrides.containerOverrides[0].environment;

			const envMap = new Map(
				envVars.map((e: { name: string; value: string }) => [e.name, e.value]),
			);

			expect(envMap.get("DOBBY_JOB_ID")).toBe(job.id);
			expect(envMap.get("DOBBY_TASK")).toBe("Fix the login bug");
			expect(envMap.get("DOBBY_REPOSITORY")).toBe("https://github.com/org/repo");
			expect(envMap.get("DOBBY_BASE_BRANCH")).toBe("main");
			expect(envMap.get("DOBBY_WORKING_BRANCH")).toBe("dobby/fix-bug-abc123");
			expect(envMap.get("DOBBY_GIT_TOKEN")).toBe("ghp_mytoken");
			expect(envMap.get("DOBBY_CALLBACK_URL")).toBe("https://dobby.rent/api/internal/callback");
			expect(envMap.get("DOBBY_CALLBACK_SECRET")).toBe("test-secret-123");
			expect(envMap.get("DOBBY_CHECKPOINT_COMMIT")).toBe("abc123sha");
			expect(envMap.get("DOBBY_EXISTING_PR_URL")).toBe("https://github.com/org/repo/pull/42");

			// Caller secrets injected as additional env vars
			expect(envMap.get("DATABASE_URL")).toBe("postgres://...");
			expect(envMap.get("API_KEY")).toBe("sk-123");
		});

		it("filters out reserved secret keys", async () => {
			setRequiredEnv();

			mockSend.mockResolvedValueOnce({
				tasks: [{ taskArn: "arn:task/1", clusterArn: "arn:cluster/1" }],
				failures: [],
			});

			await provisionTask(makeJob(), {
				gitToken: "ghp_test",
				secrets: {
					SAFE_KEY: "safe-value",
					DOBBY_CALLBACK_URL: "https://evil.com",
					AWS_SECRET_ACCESS_KEY: "stolen",
					ECS_CLUSTER_ARN: "arn:evil",
					PATH: "/evil",
					HOME: "/evil",
				},
			});

			const call = mockSend.mock.calls[0]![0];
			const envVars = call.input.overrides.containerOverrides[0].environment;
			const envMap = new Map(
				envVars.map((e: { name: string; value: string }) => [e.name, e.value]),
			);

			// Safe key should be present
			expect(envMap.get("SAFE_KEY")).toBe("safe-value");

			// Reserved keys should NOT be overwritten by user secrets
			expect(envMap.get("DOBBY_CALLBACK_URL")).not.toBe("https://evil.com");
			expect(envMap.get("PATH")).toBeUndefined();
			expect(envMap.get("HOME")).toBeUndefined();
		});

		it("throws when ECS_CLUSTER_ARN is not configured", async () => {
			vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");

			await expect(provisionTask(makeJob(), { gitToken: "ghp_test" })).rejects.toThrow(
				"ECS_CLUSTER_ARN is not configured",
			);
			expect(mockSend).not.toHaveBeenCalled();
		});

		it("throws when ECS_TASK_DEFINITION_ARN is not configured", async () => {
			vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
			vi.stubEnv("ECS_CLUSTER_ARN", "arn:aws:ecs:us-east-1:123456789:cluster/dobby");

			await expect(provisionTask(makeJob(), { gitToken: "ghp_test" })).rejects.toThrow(
				"ECS_TASK_DEFINITION_ARN is not configured",
			);
		});

		it("throws when ECS_SUBNETS is not configured", async () => {
			vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
			vi.stubEnv("ECS_CLUSTER_ARN", "arn:aws:ecs:us-east-1:123456789:cluster/dobby");
			vi.stubEnv(
				"ECS_TASK_DEFINITION_ARN",
				"arn:aws:ecs:us-east-1:123456789:task-definition/dobby-runner:1",
			);

			await expect(provisionTask(makeJob(), { gitToken: "ghp_test" })).rejects.toThrow(
				"ECS_SUBNETS is not configured",
			);
		});

		it("throws when ECS_SECURITY_GROUPS is not configured", async () => {
			vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
			vi.stubEnv("ECS_CLUSTER_ARN", "arn:aws:ecs:us-east-1:123456789:cluster/dobby");
			vi.stubEnv(
				"ECS_TASK_DEFINITION_ARN",
				"arn:aws:ecs:us-east-1:123456789:task-definition/dobby-runner:1",
			);
			vi.stubEnv("ECS_SUBNETS", "subnet-abc123");

			await expect(provisionTask(makeJob(), { gitToken: "ghp_test" })).rejects.toThrow(
				"ECS_SECURITY_GROUPS is not configured",
			);
		});

		it("throws when RunTask returns no task", async () => {
			setRequiredEnv();

			mockSend.mockResolvedValueOnce({
				tasks: [],
				failures: [{ reason: "Capacity unavailable", arn: "arn:cluster/1" }],
			});

			await expect(provisionTask(makeJob(), { gitToken: "ghp_test" })).rejects.toThrow(
				"Failed to provision ECS task: Capacity unavailable",
			);
		});

		it("throws with generic message when no failure reason", async () => {
			setRequiredEnv();

			mockSend.mockResolvedValueOnce({
				tasks: [],
				failures: [],
			});

			await expect(provisionTask(makeJob(), { gitToken: "ghp_test" })).rejects.toThrow(
				"Failed to provision ECS task: no task returned",
			);
		});

		it("handles empty checkpoint commit and existingPrUrl", async () => {
			setRequiredEnv();

			mockSend.mockResolvedValueOnce({
				tasks: [{ taskArn: "arn:task/1", clusterArn: "arn:cluster/1" }],
				failures: [],
			});

			const job = makeJob({
				lastCheckpointCommit: null,
				interruptedAt: null,
				existingPrUrl: null,
			});

			await provisionTask(job, { gitToken: "ghp_test" });

			const call = mockSend.mock.calls[0]![0];
			const envVars = call.input.overrides.containerOverrides[0].environment;
			const envMap = new Map(
				envVars.map((e: { name: string; value: string }) => [e.name, e.value]),
			);

			expect(envMap.get("DOBBY_CHECKPOINT_COMMIT")).toBe("");
			expect(envMap.get("DOBBY_EXISTING_PR_URL")).toBe("");
		});

		it("sets count to 1", async () => {
			setRequiredEnv();

			mockSend.mockResolvedValueOnce({
				tasks: [{ taskArn: "arn:task/1", clusterArn: "arn:cluster/1" }],
				failures: [],
			});

			await provisionTask(makeJob(), { gitToken: "ghp_test" });

			const call = mockSend.mock.calls[0]![0];
			expect(call.input.count).toBe(1);
		});
	});

	describe("stopTask", () => {
		it("calls StopTask with correct params", async () => {
			setRequiredEnv();

			mockSend.mockResolvedValueOnce({});

			const job = makeJob({
				ecsTaskArn: "arn:aws:ecs:us-east-1:123456789:task/dobby/task123",
				ecsClusterArn: "arn:aws:ecs:us-east-1:123456789:cluster/dobby",
			});

			await stopTask(job);

			expect(mockSend).toHaveBeenCalledOnce();
			const call = mockSend.mock.calls[0]![0];
			expect(call.input.cluster).toBe("arn:aws:ecs:us-east-1:123456789:cluster/dobby");
			expect(call.input.task).toBe("arn:aws:ecs:us-east-1:123456789:task/dobby/task123");
			expect(call.input.reason).toContain("db_testjob123456789012");
		});

		it("falls back to env cluster ARN when job has no cluster ARN", async () => {
			setRequiredEnv();

			mockSend.mockResolvedValueOnce({});

			const job = makeJob({
				ecsTaskArn: "arn:aws:ecs:us-east-1:123456789:task/dobby/task123",
				ecsClusterArn: null,
			});

			await stopTask(job);

			const call = mockSend.mock.calls[0]![0];
			expect(call.input.cluster).toBe("arn:aws:ecs:us-east-1:123456789:cluster/dobby");
		});

		it("throws when job has no ECS task ARN", async () => {
			setRequiredEnv();

			const job = makeJob({ ecsTaskArn: null });

			await expect(stopTask(job)).rejects.toThrow("has no ECS task ARN");
			expect(mockSend).not.toHaveBeenCalled();
		});

		it("throws when no cluster ARN available", async () => {
			vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
			// No ECS_CLUSTER_ARN in env

			const job = makeJob({
				ecsTaskArn: "arn:task/1",
				ecsClusterArn: null,
			});

			await expect(stopTask(job)).rejects.toThrow("No cluster ARN available");
		});
	});
});
