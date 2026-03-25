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

	it("provides default values for Dobby job config", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		const { getEnv } = await import("./env");
		const env = getEnv();
		expect(env.DOBBY_HOURLY_RATE).toBe(100);
		expect(env.DOBBY_MAX_JOB_HOURS).toBe(6);
		expect(env.DOBBY_ACCOUNT_VCPU_LIMIT).toBe(24);
		expect(env.DOBBY_VM_CPU).toBe(4);
		expect(env.AWS_REGION).toBe("us-east-1");
	});

	it("overrides defaults when Dobby env vars are set", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		vi.stubEnv("DOBBY_HOURLY_RATE", "200");
		vi.stubEnv("DOBBY_MAX_JOB_HOURS", "12");
		vi.stubEnv("DOBBY_ACCOUNT_VCPU_LIMIT", "48");
		vi.stubEnv("DOBBY_VM_CPU", "8");
		vi.stubEnv("AWS_REGION", "eu-west-1");
		const { getEnv } = await import("./env");
		const env = getEnv();
		expect(env.DOBBY_HOURLY_RATE).toBe(200);
		expect(env.DOBBY_MAX_JOB_HOURS).toBe(12);
		expect(env.DOBBY_ACCOUNT_VCPU_LIMIT).toBe(48);
		expect(env.DOBBY_VM_CPU).toBe(8);
		expect(env.AWS_REGION).toBe("eu-west-1");
	});

	it("optional Dobby vars are undefined when not set", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		const { getEnv } = await import("./env");
		const env = getEnv();
		expect(env.DOBBY_ADMIN_PASSWORD_HASH).toBeUndefined();
		expect(env.DOBBY_TELEGRAM_BOT_TOKEN).toBeUndefined();
		expect(env.DOBBY_TELEGRAM_CHAT_ID).toBeUndefined();
		expect(env.DOBBY_CONTAINER_IMAGE).toBeUndefined();
		expect(env.DOBBY_CALLBACK_SECRET).toBeUndefined();
		expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(env.ECS_CLUSTER_ARN).toBeUndefined();
		expect(env.ECS_TASK_DEFINITION_ARN).toBeUndefined();
		expect(env.ECS_SUBNETS).toBeUndefined();
		expect(env.ECS_SECURITY_GROUPS).toBeUndefined();
		expect(env.KMS_KEY_ID).toBeUndefined();
		expect(env.MPP_ENDPOINT).toBeUndefined();
		expect(env.MPP_API_KEY).toBeUndefined();
	});

	it("caches env after first call", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		const { getEnv } = await import("./env");
		const env1 = getEnv();
		const env2 = getEnv();
		expect(env1).toBe(env2);
	});

	it("_resetEnv clears cached env", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		const { getEnv, _resetEnv } = await import("./env");
		const env1 = getEnv();
		_resetEnv();
		const env2 = getEnv();
		expect(env1).not.toBe(env2);
		expect(env1).toEqual(env2);
	});
});
