import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock KMS
const mockEncrypt = vi.fn();
const mockDecrypt = vi.fn();
vi.mock("../../../../lib/kms", () => ({
	encrypt: (...args: unknown[]) => mockEncrypt(...args),
	decrypt: (...args: unknown[]) => mockDecrypt(...args),
}));

// Mock ECS provisioning
const mockProvisionTask = vi.fn();
vi.mock("../../../../domain/jobs/ecs", () => ({
	provisionTask: (...args: unknown[]) => mockProvisionTask(...args),
	stopTask: vi.fn(),
	_resetClient: vi.fn(),
}));

// Mock MPP
const mockValidatePreauthorization = vi.fn();
vi.mock("../../../../lib/mpp", () => ({
	validatePreauthorization: (...args: unknown[]) => mockValidatePreauthorization(...args),
	MppError: class MppError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "MppError";
		}
	},
}));

// Mock database
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();

let whereResult: unknown[] = [{ count: 0 }];
const mockWhere = vi.fn().mockImplementation(() => whereResult);

vi.mock("../../../../db", () => ({
	getDb: () => ({
		insert: (...args: unknown[]) => {
			mockInsert(...args);
			return { values: mockValues };
		},
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
		update: () => ({
			set: (...args: unknown[]) => {
				mockUpdateSet(...args);
				return {
					where: (...args: unknown[]) => {
						mockUpdateWhere(...args);
						return Promise.resolve();
					},
				};
			},
		}),
	}),
}));

vi.mock("../../../../db/schema", () => ({
	jobs: { status: "status" },
}));

describe("POST /v1/jobs", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		vi.stubEnv("KMS_KEY_ID", "arn:aws:kms:us-east-1:123:key/test");
		vi.stubEnv("AWS_REGION", "us-east-1");
		mockEncrypt.mockReset();
		mockDecrypt.mockReset();
		mockInsert.mockReset();
		mockValues.mockReset();
		mockSelect.mockReset();
		mockFrom.mockReset();
		mockWhere.mockReset().mockImplementation(() => whereResult);
		mockValidatePreauthorization.mockReset();
		mockProvisionTask.mockReset();
		mockUpdateSet.mockReset();
		mockUpdateWhere.mockReset();
		mockEncrypt.mockResolvedValue("encrypted-base64");
		mockDecrypt.mockResolvedValue("ghp_test123");
		mockValues.mockResolvedValue(undefined);
		whereResult = [{ count: 0 }];
		mockValidatePreauthorization.mockResolvedValue({
			valid: true,
			channelId: "mpp-channel-123",
			authorizedAmount: 600,
		});
		mockProvisionTask.mockResolvedValue({
			taskArn: "arn:aws:ecs:us-east-1:123:task/cluster/abc123",
			clusterArn: "arn:aws:ecs:us-east-1:123:cluster/test",
		});
	});

	function createRequest(body: unknown, headers?: Record<string, string>) {
		return new Request("http://localhost:3000/api/v1/jobs", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"MPP-Token": "mpp-test-token",
				...headers,
			},
			body: JSON.stringify(body),
		});
	}

	const validBody = {
		repository: "https://github.com/org/repo",
		task: "Fix the login bug",
		gitToken: "ghp_test123",
	};

	it("returns 201 with job id and status on successful creation", async () => {
		const { POST } = await import("./route");
		const req = createRequest(validBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(201);
		const json = await res.json();
		expect(json.id).toMatch(/^db_/);
		expect(json.status).toBe("provisioning");
	});

	it("inserts job row with encrypted credentials", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			...validBody,
			secrets: { API_KEY: "secret123" },
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		expect(mockEncrypt).toHaveBeenCalledWith("ghp_test123");
		expect(mockEncrypt).toHaveBeenCalledWith(JSON.stringify({ API_KEY: "secret123" }));
		expect(mockValues).toHaveBeenCalledOnce();

		const insertedRow = mockValues.mock.calls[0]![0] as Record<string, unknown>;
		expect(insertedRow.status).toBe("pending");
		expect(insertedRow.repository).toBe("https://github.com/org/repo");
		expect(insertedRow.encryptedGitCredentials).toBe("encrypted-base64");
		expect(insertedRow.encryptedSecrets).toBe("encrypted-base64");
		expect(insertedRow.authorizedFlops).toBe("600");
	});

	it("returns 400 for invalid JSON body", async () => {
		const { POST } = await import("./route");
		const req = new Request("http://localhost:3000/api/v1/jobs", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"MPP-Token": "mpp-test-token",
			},
			body: "not json",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toBe("Invalid JSON body");
	});

	it("returns 400 when repository is missing", async () => {
		const { POST } = await import("./route");
		const req = createRequest({ task: "do stuff", gitToken: "token" });
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toBe("Validation failed");
	});

	it("returns 400 when task is missing", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			repository: "https://github.com/org/repo",
			gitToken: "token",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(400);
	});

	it("returns 400 when gitToken is missing", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			repository: "https://github.com/org/repo",
			task: "fix bug",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(400);
	});

	it("returns 400 for invalid repository URL", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			...validBody,
			repository: "not-a-url",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(400);
	});

	it("returns 400 when existingPrUrl does not match repository", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			...validBody,
			existingPrUrl: "https://github.com/other-org/other-repo/pull/123",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toContain("existingPrUrl does not match");
	});

	it("accepts existingPrUrl that matches repository", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			...validBody,
			existingPrUrl: "https://github.com/org/repo/pull/42",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(201);
	});

	it("returns 401 when MPP-Token header is missing", async () => {
		const { POST } = await import("./route");
		const req = new Request("http://localhost:3000/api/v1/jobs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody),
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(401);
		const json = await res.json();
		expect(json.error).toContain("MPP-Token");
	});

	it("returns 429 when at capacity", async () => {
		whereResult = [{ count: 6 }];

		const { POST } = await import("./route");
		const req = createRequest(validBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(429);
		const json = await res.json();
		expect(json.error).toContain("capacity");
	});

	it("defaults baseBranch to main", async () => {
		const { POST } = await import("./route");
		const req = createRequest(validBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const insertedRow = mockValues.mock.calls[0]![0] as Record<string, unknown>;
		expect(insertedRow.baseBranch).toBe("main");
	});

	it("uses provided baseBranch", async () => {
		const { POST } = await import("./route");
		const req = createRequest({
			...validBody,
			baseBranch: "develop",
		});
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const insertedRow = mockValues.mock.calls[0]![0] as Record<string, unknown>;
		expect(insertedRow.baseBranch).toBe("develop");
	});

	it("stores null encryptedSecrets when secrets not provided", async () => {
		const { POST } = await import("./route");
		const req = createRequest(validBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const insertedRow = mockValues.mock.calls[0]![0] as Record<string, unknown>;
		expect(insertedRow.encryptedSecrets).toBeNull();
		// Only gitToken encrypted, not secrets
		expect(mockEncrypt).toHaveBeenCalledTimes(1);
	});

	it("stores mppChannelId from MPP validation result", async () => {
		mockValidatePreauthorization.mockResolvedValueOnce({
			valid: true,
			channelId: "channel-xyz",
			authorizedAmount: 600,
		});

		const { POST } = await import("./route");
		const req = createRequest(validBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const insertedRow = mockValues.mock.calls[0]![0] as Record<string, unknown>;
		expect(insertedRow.mppChannelId).toBe("channel-xyz");
	});

	it("returns 402 when MPP preauthorization is invalid", async () => {
		mockValidatePreauthorization.mockResolvedValueOnce({
			valid: false,
			channelId: "",
			authorizedAmount: 0,
		});

		const { POST } = await import("./route");
		const req = createRequest(validBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(402);
		const json = await res.json();
		expect(json.error).toContain("MPP preauthorization insufficient");
	});

	it("returns 402 when MPP endpoint returns an error", async () => {
		const { MppError } = await import("../../../../lib/mpp");
		mockValidatePreauthorization.mockRejectedValueOnce(
			new MppError("MPP preauthorization failed (402): Insufficient funds"),
		);

		const { POST } = await import("./route");
		const req = createRequest(validBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const res = await POST(req as any);

		expect(res.status).toBe(402);
		const json = await res.json();
		expect(json.error).toContain("MPP preauthorization failed");
	});

	it("passes max budget to validatePreauthorization", async () => {
		const { POST } = await import("./route");
		const req = createRequest(validBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		expect(mockValidatePreauthorization).toHaveBeenCalledWith("mpp-test-token", 600);
	});

	it("generates working branch from task when no existingPrUrl", async () => {
		const { POST } = await import("./route");
		const req = createRequest(validBody);
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await POST(req as any);

		const insertedRow = mockValues.mock.calls[0]![0] as Record<string, unknown>;
		expect(insertedRow.workingBranch).toMatch(/^dobby\/fix-the-login-bug-/);
	});
});
