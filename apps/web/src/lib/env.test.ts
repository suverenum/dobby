import { beforeEach, describe, expect, it, vi } from "vitest";

describe("env", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("exports typed env vars when all required vars are set", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		const { getEnv } = await import("./env");
		const env = getEnv();
		expect(env.DATABASE_URL).toBe("postgres://user:pass@host:5432/db");
	});

	it("missing optional vars don't crash the app", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		delete process.env.SESSION_SECRET;
		delete process.env.NEXT_PUBLIC_SENTRY_DSN;
		delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
		const { getEnv } = await import("./env");
		expect(() => getEnv()).not.toThrow();
	});

	it("missing required vars throw a clear error message", async () => {
		vi.stubEnv("DATABASE_URL", "");
		const { getEnv } = await import("./env");
		expect(() => getEnv()).toThrow("Environment validation failed");
	});
});
