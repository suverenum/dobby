import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock session
const mockValidateAdminSession = vi.fn();
vi.mock("../../../../../../lib/session", () => ({
	validateAdminSession: (...args: unknown[]) => mockValidateAdminSession(...args),
}));

// Mock DB
let mockJobRows: Array<Record<string, unknown>> = [];
const mockUpdate = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();

vi.mock("../../../../../../db", () => ({
	getDb: () => ({
		select: () => ({
			from: () => ({
				where: () => Promise.resolve(mockJobRows),
			}),
		}),
		update: (...args: unknown[]) => {
			mockUpdate(...args);
			return {
				set: (...sArgs: unknown[]) => {
					mockUpdateSet(...sArgs);
					return {
						where: (...wArgs: unknown[]) => {
							mockUpdateWhere(...wArgs);
							return Promise.resolve();
						},
					};
				},
			};
		},
	}),
}));

// Mock domain/jobs
const mockStopTask = vi.fn();
const mockCalculateJobCost = vi.fn().mockReturnValue(50);
vi.mock("../../../../../../domain/jobs", () => ({
	calculateJobCost: (...args: unknown[]) => mockCalculateJobCost(...args),
	validateTransition: (from: string, to: string) => {
		if (to === "stopped" && ["provisioning", "cloning", "executing", "finalizing"].includes(from))
			return;
		throw new Error(`Invalid transition from ${from} to ${to}`);
	},
	stopTask: (...args: unknown[]) => mockStopTask(...args),
}));

// Mock env
vi.mock("../../../../../../lib/env", () => ({
	getEnv: () => ({
		DOBBY_HOURLY_RATE: 100,
		DOBBY_MAX_JOB_HOURS: 6,
	}),
}));

// Mock MPP
const mockSettlePayment = vi.fn().mockResolvedValue({});
vi.mock("../../../../../../lib/mpp", () => ({
	settlePayment: (...args: unknown[]) => mockSettlePayment(...args),
}));

// Mock Telegram
const mockSendNotification = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../../../../lib/telegram", () => ({
	sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}));

import { POST } from "./route";

function makeRequest(): Request {
	return new Request("http://localhost/api/admin/jobs/db_test1/stop", {
		method: "POST",
	});
}

function makeJob(overrides: Record<string, unknown> = {}) {
	return {
		id: "db_test1",
		status: "executing",
		repository: "https://github.com/org/repo.git",
		baseBranch: "main",
		workingBranch: "dobby/fix-bug",
		task: "Fix the login bug",
		existingPrUrl: null,
		prUrl: null,
		encryptedGitCredentials: "enc_creds",
		encryptedSecrets: null,
		ecsTaskArn: "arn:aws:ecs:us-east-1:123:task/abc",
		ecsClusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		logStreamName: null,
		authorizedFlops: "100",
		costFlops: null,
		mppChannelId: null,
		submittedAt: new Date("2026-03-20T10:00:00Z"),
		startedAt: new Date("2026-03-20T10:01:00Z"),
		finishedAt: null,
		resumeCount: 0,
		lastCheckpointCommit: null,
		...overrides,
	};
}

describe("POST /api/admin/jobs/[id]/stop", () => {
	beforeEach(() => {
		mockValidateAdminSession.mockReset();
		mockStopTask.mockReset();
		mockUpdate.mockClear();
		mockUpdateSet.mockClear();
		mockUpdateWhere.mockClear();
		mockSettlePayment.mockClear();
		mockSendNotification.mockClear();
		mockCalculateJobCost.mockClear().mockReturnValue(50);
		mockJobRows = [];
	});

	it("returns 401 when not authenticated", async () => {
		mockValidateAdminSession.mockResolvedValue(false);

		const res = await POST(makeRequest() as never, {
			params: Promise.resolve({ id: "db_test1" }),
		});

		expect(res.status).toBe(401);
	});

	it("returns 404 when job not found", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockJobRows = [];

		const res = await POST(makeRequest() as never, {
			params: Promise.resolve({ id: "db_missing" }),
		});

		expect(res.status).toBe(404);
	});

	it("returns 409 when job is already completed", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockJobRows = [makeJob({ status: "completed" })];

		const res = await POST(makeRequest() as never, {
			params: Promise.resolve({ id: "db_test1" }),
		});

		expect(res.status).toBe(409);
		const data = await res.json();
		expect(data.error).toContain("Cannot transition");
	});

	it("stops an active job successfully", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockStopTask.mockResolvedValue(undefined);
		mockJobRows = [makeJob({ status: "executing" })];

		const res = await POST(makeRequest() as never, {
			params: Promise.resolve({ id: "db_test1" }),
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.success).toBe(true);
		expect(data.status).toBe("stopped");
		expect(mockStopTask).toHaveBeenCalled();
		expect(mockUpdateSet).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "stopped",
				encryptedGitCredentials: "",
				encryptedSecrets: null,
			}),
		);
	});

	it("calculates cost and clears secrets on stop", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockStopTask.mockResolvedValue(undefined);
		mockJobRows = [makeJob({ status: "executing" })];

		await POST(makeRequest() as never, {
			params: Promise.resolve({ id: "db_test1" }),
		});

		expect(mockCalculateJobCost).toHaveBeenCalled();
		expect(mockUpdateSet).toHaveBeenCalledWith(
			expect.objectContaining({
				costFlops: "50",
				encryptedGitCredentials: "",
				encryptedSecrets: null,
			}),
		);
	});

	it("settles MPP payment when mppChannelId is set", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockStopTask.mockResolvedValue(undefined);
		mockJobRows = [makeJob({ status: "executing", mppChannelId: "ch_123" })];

		await POST(makeRequest() as never, {
			params: Promise.resolve({ id: "db_test1" }),
		});

		expect(mockSettlePayment).toHaveBeenCalledWith("ch_123", 50, 100);
	});

	it("sends Telegram notification on stop", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockStopTask.mockResolvedValue(undefined);
		mockJobRows = [makeJob({ status: "executing" })];

		await POST(makeRequest() as never, {
			params: Promise.resolve({ id: "db_test1" }),
		});

		expect(mockSendNotification).toHaveBeenCalledWith(
			expect.objectContaining({ id: "db_test1" }),
			"stopped",
		);
	});

	it("still updates status if ECS stopTask fails", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockStopTask.mockRejectedValue(new Error("ECS error"));
		mockJobRows = [makeJob({ status: "executing" })];

		const res = await POST(makeRequest() as never, {
			params: Promise.resolve({ id: "db_test1" }),
		});

		expect(res.status).toBe(200);
		expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "stopped" }));
	});

	it("skips ECS stop when no task ARN", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockJobRows = [makeJob({ status: "provisioning", ecsTaskArn: null })];

		const res = await POST(makeRequest() as never, {
			params: Promise.resolve({ id: "db_test1" }),
		});

		expect(res.status).toBe(200);
		expect(mockStopTask).not.toHaveBeenCalled();
	});
});
