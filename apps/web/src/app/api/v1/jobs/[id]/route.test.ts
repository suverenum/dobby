import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();

vi.mock("../../../../../db", () => ({
	getDb: () => ({
		select: (...args: unknown[]) => {
			mockSelect(...args);
			return {
				from: (...fromArgs: unknown[]) => {
					mockFrom(...fromArgs);
					return {
						where: (...whereArgs: unknown[]) => mockWhere(...whereArgs),
					};
				},
			};
		},
	}),
}));

vi.mock("../../../../../db/schema", () => ({
	jobs: { id: "id" },
}));

const sampleJob = {
	id: "db_abcdefghijklmnopqrstu",
	status: "executing",
	repository: "https://github.com/org/repo",
	baseBranch: "main",
	workingBranch: "dobby/fix-bug-abc123",
	task: "Fix the login bug in the authentication module",
	existingPrUrl: null,
	prUrl: "https://github.com/org/repo/pull/42",
	encryptedGitCredentials: "encrypted-git-creds-base64",
	encryptedSecrets: "encrypted-secrets-base64",
	ecsTaskArn: "arn:aws:ecs:us-east-1:123:task/cluster/task-id",
	ecsClusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
	logStreamName: "ecs/dobby/task-id",
	authorizedFlops: "600",
	costFlops: "120",
	mppChannelId: "mpp-channel-xyz",
	submittedAt: new Date("2026-03-21T10:00:00Z"),
	startedAt: new Date("2026-03-21T10:01:00Z"),
	finishedAt: null,
	resumeCount: 1,
	lastCheckpointCommit: "abc123def456",
};

describe("GET /v1/jobs/:id", () => {
	beforeEach(() => {
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		mockSelect.mockReset();
		mockFrom.mockReset();
		mockWhere.mockReset();
	});

	async function callGet(id: string) {
		const { GET } = await import("./route");
		const req = new Request(`http://localhost:3000/api/v1/jobs/${id}`);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return GET(req as any, { params: Promise.resolve({ id }) });
	}

	it("returns 400 for invalid job ID format", async () => {
		const res = await callGet("invalid-id");
		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toContain("Invalid job ID");
	});

	it("returns 404 when job is not found", async () => {
		mockWhere.mockResolvedValue([]);
		const res = await callGet("db_abcdefghijklmnopqrstu");
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.error).toContain("not found");
	});

	it("returns job fields on success", async () => {
		mockWhere.mockResolvedValue([sampleJob]);
		const res = await callGet("db_abcdefghijklmnopqrstu");
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.id).toBe(sampleJob.id);
		expect(json.status).toBe("executing");
		expect(json.repository).toBe(sampleJob.repository);
		expect(json.baseBranch).toBe("main");
		expect(json.workingBranch).toBe(sampleJob.workingBranch);
		expect(json.prUrl).toBe(sampleJob.prUrl);
		expect(json.resumeCount).toBe(1);
		expect(json.costFlops).toBe("120");
	});

	it("never returns encrypted fields", async () => {
		mockWhere.mockResolvedValue([sampleJob]);
		const res = await callGet("db_abcdefghijklmnopqrstu");
		const json = await res.json();
		expect(json.encryptedGitCredentials).toBeUndefined();
		expect(json.encryptedSecrets).toBeUndefined();
		expect(json.ecsTaskArn).toBeUndefined();
		expect(json.ecsClusterArn).toBeUndefined();
		expect(json.logStreamName).toBeUndefined();
		expect(json.mppChannelId).toBeUndefined();
		expect(json.lastCheckpointCommit).toBeUndefined();
		expect(json.authorizedFlops).toBeUndefined();
	});

	it("truncates task to 200 characters", async () => {
		const longTask = "A".repeat(300);
		mockWhere.mockResolvedValue([{ ...sampleJob, task: longTask }]);
		const res = await callGet("db_abcdefghijklmnopqrstu");
		const json = await res.json();
		expect(json.task).toHaveLength(200);
		expect(json.task).toBe("A".repeat(200));
	});

	it("returns null fields when job has no optional data", async () => {
		const minimalJob = {
			...sampleJob,
			prUrl: null,
			startedAt: null,
			finishedAt: null,
			costFlops: null,
			resumeCount: 0,
		};
		mockWhere.mockResolvedValue([minimalJob]);
		const res = await callGet("db_abcdefghijklmnopqrstu");
		const json = await res.json();
		expect(json.prUrl).toBeNull();
		expect(json.startedAt).toBeNull();
		expect(json.finishedAt).toBeNull();
		expect(json.costFlops).toBeNull();
		expect(json.resumeCount).toBe(0);
	});
});
