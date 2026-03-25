import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock session
const mockValidateAdminSession = vi.fn();
vi.mock("../../../../../../lib/session", () => ({
	validateAdminSession: (...args: unknown[]) => mockValidateAdminSession(...args),
}));

// Mock DB
let mockJobRows: Array<Record<string, unknown>> = [];

vi.mock("../../../../../../db", () => ({
	getDb: () => ({
		select: () => ({
			from: () => ({
				where: () => Promise.resolve(mockJobRows),
			}),
		}),
	}),
}));

// Mock env
vi.mock("../../../../../../lib/env", () => ({
	getEnv: () => ({
		AWS_REGION: "us-east-1",
		AWS_ACCESS_KEY_ID: "test-key",
		AWS_SECRET_ACCESS_KEY: "test-secret",
	}),
}));

// Mock CloudWatch Logs
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
	CloudWatchLogsClient: vi.fn().mockImplementation(() => ({
		send: (...args: unknown[]) => mockSend(...args),
	})),
	GetLogEventsCommand: vi.fn().mockImplementation((params: unknown) => ({
		_type: "GetLogEventsCommand",
		params,
	})),
}));

// Mock domain/jobs
vi.mock("../../../../../../domain/jobs", () => ({
	isTerminalStatus: (status: string) =>
		["completed", "failed", "timed_out", "stopped"].includes(status),
}));

import { GET } from "./route";

function makeRequest(id: string): Request {
	return new Request(`http://localhost/api/admin/jobs/${id}/logs`, {
		method: "GET",
	});
}

function makeJob(overrides: Record<string, unknown> = {}) {
	return {
		id: "db_log1",
		status: "completed",
		logStreamName: "ecs/dobby-runner/abc",
		...overrides,
	};
}

async function readSSEStream(response: Response): Promise<string[]> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const messages: string[] = [];
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		const parts = buffer.split("\n\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			const trimmed = part.trim();
			if (trimmed.startsWith("data: ")) {
				messages.push(trimmed.slice(6));
			}
		}
	}

	return messages;
}

describe("GET /api/admin/jobs/[id]/logs", () => {
	beforeEach(() => {
		mockValidateAdminSession.mockReset();
		mockSend.mockReset();
		mockJobRows = [];
	});

	it("returns 401 when not authenticated", async () => {
		mockValidateAdminSession.mockResolvedValue(false);

		const res = await GET(makeRequest("db_log1") as never, {
			params: Promise.resolve({ id: "db_log1" }),
		});

		expect(res.status).toBe(401);
	});

	it("returns 404 when job not found", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockJobRows = [];

		const res = await GET(makeRequest("db_missing") as never, {
			params: Promise.resolve({ id: "db_missing" }),
		});

		expect(res.status).toBe(404);
	});

	it("returns 404 when job has no log stream", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockJobRows = [makeJob({ logStreamName: null })];

		const res = await GET(makeRequest("db_log1") as never, {
			params: Promise.resolve({ id: "db_log1" }),
		});

		expect(res.status).toBe(404);
		const data = await res.json();
		expect(data.error).toBe("No log stream available");
	});

	it("streams logs for a terminal job and closes", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockJobRows = [makeJob({ status: "completed" })];
		mockSend
			.mockResolvedValueOnce({
				events: [
					{ timestamp: 1000, message: "Starting job..." },
					{ timestamp: 2000, message: "Job complete." },
				],
				nextForwardToken: "token-1",
			})
			.mockResolvedValueOnce({
				events: [],
				nextForwardToken: "token-1",
			});

		const res = await GET(makeRequest("db_log1") as never, {
			params: Promise.resolve({ id: "db_log1" }),
		});

		expect(res.headers.get("Content-Type")).toBe("text/event-stream");

		const messages = await readSSEStream(res);
		// Should have 2 log entries + [DONE]
		expect(messages.length).toBe(3);
		expect(JSON.parse(messages[0]!)).toEqual({ timestamp: 1000, message: "Starting job..." });
		expect(JSON.parse(messages[1]!)).toEqual({ timestamp: 2000, message: "Job complete." });
		expect(messages[2]).toBe("[DONE]");
	});

	it("handles CloudWatch errors gracefully", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockJobRows = [makeJob({ status: "completed" })];
		mockSend.mockRejectedValue(new Error("CloudWatch error"));

		const res = await GET(makeRequest("db_log1") as never, {
			params: Promise.resolve({ id: "db_log1" }),
		});

		const messages = await readSSEStream(res);
		expect(messages.length).toBe(1);
		expect(JSON.parse(messages[0]!)).toEqual({ error: "CloudWatch error" });
	});

	it("returns SSE headers", async () => {
		mockValidateAdminSession.mockResolvedValue(true);
		mockJobRows = [makeJob({ status: "completed" })];
		mockSend.mockResolvedValue({ events: [], nextForwardToken: null });

		const res = await GET(makeRequest("db_log1") as never, {
			params: Promise.resolve({ id: "db_log1" }),
		});

		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
	});
});
