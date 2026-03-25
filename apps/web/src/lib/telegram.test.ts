import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatDuration,
	formatNotificationMessage,
	sendNotification,
	type TelegramNotificationJob,
	truncateTask,
} from "./telegram";

// Mock env
vi.mock("./env", () => ({
	getEnv: () => ({
		DOBBY_TELEGRAM_BOT_TOKEN: mockBotToken,
		DOBBY_TELEGRAM_CHAT_ID: mockChatId,
		DOBBY_CALLBACK_URL: mockCallbackUrl,
	}),
}));

let mockBotToken: string | undefined = "test-bot-token";
let mockChatId: string | undefined = "test-chat-id";
const mockCallbackUrl = "https://dobby.suverenum.ai";

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeJob(overrides: Partial<TelegramNotificationJob> = {}): TelegramNotificationJob {
	return {
		id: "db_test123",
		task: "Fix the login bug\nUsers cannot log in with SSO",
		repository: "https://github.com/acme/webapp.git",
		prUrl: null,
		startedAt: new Date("2026-03-21T10:00:00Z"),
		finishedAt: new Date("2026-03-21T10:15:30Z"),
		costFlops: "25.5",
		resumeCount: 0,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockBotToken = "test-bot-token";
	mockChatId = "test-chat-id";
	mockFetch.mockResolvedValue({ ok: true });
});

describe("formatDuration", () => {
	it("formats seconds only", () => {
		expect(formatDuration(45_000)).toBe("45s");
	});

	it("formats minutes and seconds", () => {
		expect(formatDuration(125_000)).toBe("2m 5s");
	});

	it("formats hours and minutes", () => {
		expect(formatDuration(3_723_000)).toBe("1h 2m");
	});

	it("formats zero", () => {
		expect(formatDuration(0)).toBe("0s");
	});
});

describe("truncateTask", () => {
	it("returns first 2 lines of task", () => {
		const result = truncateTask("Line 1\nLine 2\nLine 3\nLine 4");
		expect(result).toBe("Line 1\nLine 2");
	});

	it("truncates long lines to 100 chars", () => {
		const longLine = "A".repeat(150);
		const result = truncateTask(longLine);
		expect(result).toBe(`${"A".repeat(97)}...`);
		expect(result.length).toBe(100);
	});

	it("skips blank lines", () => {
		const result = truncateTask("\n\nActual line 1\n\nActual line 2\nLine 3");
		expect(result).toBe("Actual line 1\nActual line 2");
	});

	it("handles single line", () => {
		const result = truncateTask("Just one line");
		expect(result).toBe("Just one line");
	});
});

describe("formatNotificationMessage", () => {
	it("formats completed job message", () => {
		const job = makeJob({ prUrl: "https://github.com/acme/webapp/pull/42" });
		const msg = formatNotificationMessage(job, "completed");

		expect(msg).toContain("<b>Job done — 15m 30s</b>");
		expect(msg).toContain(
			'acme/webapp · <a href="https://dobby.suverenum.ai/admin/jobs/db_test123">db_test123</a>',
		);
		expect(msg).toContain("Fix the login bug");
		expect(msg).toContain("PR: https://github.com/acme/webapp/pull/42");
		expect(msg).not.toContain("Dashboard:");
	});

	it("formats failed job message", () => {
		const msg = formatNotificationMessage(makeJob(), "failed");
		expect(msg).toContain("<b>Job failed — 15m 30s</b>");
	});

	it("formats timed_out job message", () => {
		const msg = formatNotificationMessage(makeJob(), "timed_out");
		expect(msg).toContain("<b>Job timed out — 15m 30s</b>");
	});

	it("formats stopped job message", () => {
		const msg = formatNotificationMessage(makeJob(), "stopped");
		expect(msg).toContain("<b>Job stopped — 15m 30s</b>");
	});

	it("formats interrupted job message", () => {
		const msg = formatNotificationMessage(makeJob(), "interrupted");
		expect(msg).toContain("<b>Job interrupted, resuming... — 15m 30s</b>");
	});

	it("formats provisioning job message without duration", () => {
		const msg = formatNotificationMessage(
			makeJob({ startedAt: null, finishedAt: null }),
			"provisioning",
		);
		expect(msg).toContain("<b>New job started</b>");
		expect(msg).not.toContain("—");
	});

	it("omits duration when no startedAt", () => {
		const msg = formatNotificationMessage(makeJob({ startedAt: null }), "failed");
		expect(msg).toContain("<b>Job failed</b>");
		expect(msg).not.toContain("—");
	});

	it("omits duration when no finishedAt", () => {
		const msg = formatNotificationMessage(makeJob({ finishedAt: null }), "failed");
		expect(msg).toContain("<b>Job failed</b>");
		expect(msg).not.toContain("—");
	});

	it("omits PR link when not set", () => {
		const msg = formatNotificationMessage(makeJob({ prUrl: null }), "completed");
		expect(msg).not.toContain("PR:");
	});

	it("includes dashboard link in job ID", () => {
		const msg = formatNotificationMessage(makeJob(), "completed");
		expect(msg).toContain(
			'<a href="https://dobby.suverenum.ai/admin/jobs/db_test123">db_test123</a>',
		);
	});

	it("handles unknown status with default emoji", () => {
		const msg = formatNotificationMessage(makeJob(), "unknown_status");
		expect(msg).toContain("ℹ️");
		expect(msg).toContain("db_test123");
	});

	it("extracts short repo from URL", () => {
		const msg = formatNotificationMessage(
			makeJob({ repository: "https://github.com/org/repo.git" }),
			"completed",
		);
		expect(msg).toContain("org/repo · ");
	});
});

describe("sendNotification", () => {
	it("sends message to Telegram API", async () => {
		const job = makeJob();
		await sendNotification(job, "completed");

		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, options] = mockFetch.mock.calls[0] as [
			string,
			RequestInit & { headers: Record<string, string> },
		];
		expect(url).toBe("https://api.telegram.org/bottest-bot-token/sendMessage");
		expect(options.method).toBe("POST");
		expect(options.headers["Content-Type"]).toBe("application/json");

		const body = JSON.parse(options.body as string);
		expect(body.chat_id).toBe("test-chat-id");
		expect(body.text).toContain("db_test123");
		expect(body.parse_mode).toBe("HTML");
		expect(body.disable_web_page_preview).toBe(true);
	});

	it("silently skips when bot token is not set", async () => {
		mockBotToken = undefined;
		await sendNotification(makeJob(), "completed");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("silently skips when chat ID is not set", async () => {
		mockChatId = undefined;
		await sendNotification(makeJob(), "completed");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("logs error on non-ok response but does not throw", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });

		await expect(sendNotification(makeJob(), "completed")).resolves.toBeUndefined();
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Telegram notification failed"),
		);
		consoleSpy.mockRestore();
	});

	it("logs error on fetch failure but does not throw", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		mockFetch.mockRejectedValue(new Error("Network error"));

		await expect(sendNotification(makeJob(), "completed")).resolves.toBeUndefined();
		expect(consoleSpy).toHaveBeenCalledWith("Telegram notification error:", expect.any(Error));
		consoleSpy.mockRestore();
	});
});
