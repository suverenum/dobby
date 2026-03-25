import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnv } from "../../../../lib/env";

// Mock bcryptjs
const mockCompare = vi.fn();
vi.mock("bcryptjs", () => ({
	default: {
		compare: (...args: unknown[]) => mockCompare(...args),
	},
}));

// Mock session
const mockCreateAdminSession = vi.fn();
vi.mock("../../../../lib/session", () => ({
	createAdminSession: () => mockCreateAdminSession(),
}));

function setRequiredEnv() {
	vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
	vi.stubEnv("DOBBY_ADMIN_PASSWORD_HASH", "$2a$10$somevalidbcrypthashhere1234567890");
}

describe("POST /api/admin/login", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.unstubAllEnvs();
		_resetEnv();
	});

	it("returns 503 when DOBBY_ADMIN_PASSWORD_HASH is not configured", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		// No DOBBY_ADMIN_PASSWORD_HASH set

		const { POST } = await import("./route");
		const request = new Request("http://localhost/api/admin/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: "test" }),
		});

		const response = await POST(request);
		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body.error).toContain("not configured");
	});

	it("returns 400 when request body is not valid JSON", async () => {
		setRequiredEnv();

		const { POST } = await import("./route");
		const request = new Request("http://localhost/api/admin/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});

		const response = await POST(request);
		expect(response.status).toBe(400);
	});

	it("returns 400 when password is missing", async () => {
		setRequiredEnv();

		const { POST } = await import("./route");
		const request = new Request("http://localhost/api/admin/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		const response = await POST(request);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toContain("Password is required");
	});

	it("returns 401 when password is incorrect", async () => {
		setRequiredEnv();
		mockCompare.mockResolvedValue(false);

		const { POST } = await import("./route");
		const request = new Request("http://localhost/api/admin/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: "wrong-password" }),
		});

		const response = await POST(request);
		expect(response.status).toBe(401);
		const body = await response.json();
		expect(body.error).toBe("Invalid password");
		expect(mockCreateAdminSession).not.toHaveBeenCalled();
	});

	it("returns 200 and creates session when password is correct", async () => {
		setRequiredEnv();
		mockCompare.mockResolvedValue(true);
		mockCreateAdminSession.mockResolvedValue(undefined);

		const { POST } = await import("./route");
		const request = new Request("http://localhost/api/admin/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: "correct-password" }),
		});

		const response = await POST(request);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.success).toBe(true);

		expect(mockCompare).toHaveBeenCalledWith(
			"correct-password",
			"$2a$10$somevalidbcrypthashhere1234567890",
		);
		expect(mockCreateAdminSession).toHaveBeenCalledOnce();
	});

	it("verifies password against DOBBY_ADMIN_PASSWORD_HASH", async () => {
		const hash = "$2b$12$customhashvalue1234567890";
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		vi.stubEnv("DOBBY_ADMIN_PASSWORD_HASH", hash);
		mockCompare.mockResolvedValue(true);
		mockCreateAdminSession.mockResolvedValue(undefined);

		const { POST } = await import("./route");
		const request = new Request("http://localhost/api/admin/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: "mypassword" }),
		});

		await POST(request);
		expect(mockCompare).toHaveBeenCalledWith("mypassword", hash);
	});
});
