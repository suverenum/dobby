import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock next/headers cookies
const mockCookieGet = vi.fn();
const mockCookieSet = vi.fn();
const mockCookieDelete = vi.fn();

vi.mock("next/headers", () => ({
	cookies: () =>
		Promise.resolve({
			get: mockCookieGet,
			set: mockCookieSet,
			delete: mockCookieDelete,
		}),
}));

// Mock next/navigation redirect
const mockRedirect = vi.fn();
vi.mock("next/navigation", () => ({
	redirect: (...args: unknown[]) => {
		mockRedirect(...args);
		throw new Error("NEXT_REDIRECT");
	},
}));

describe("session", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.unstubAllEnvs();
	});

	describe("createAdminSession", () => {
		it("sets an httpOnly cookie with signed token", async () => {
			vi.stubEnv("SESSION_SECRET", "test-secret-long-enough-for-hmac");

			const { createAdminSession } = await import("./session");
			await createAdminSession();

			expect(mockCookieSet).toHaveBeenCalledOnce();
			const [name, value, options] = mockCookieSet.mock.calls[0]!;
			expect(name).toBe("dobby_admin_session");
			expect(value).toContain("."); // payload.signature format
			expect(options.httpOnly).toBe(true);
			expect(options.sameSite).toBe("lax");
			expect(options.path).toBe("/");
			expect(options.maxAge).toBe(86400);
		});

		it("throws when SESSION_SECRET is missing", async () => {
			// no SESSION_SECRET set
			const { createAdminSession } = await import("./session");
			await expect(createAdminSession()).rejects.toThrow("SESSION_SECRET must be set");
		});

		it("throws when SESSION_SECRET is too short", async () => {
			vi.stubEnv("SESSION_SECRET", "short");
			const { createAdminSession } = await import("./session");
			await expect(createAdminSession()).rejects.toThrow("SESSION_SECRET must be set");
		});
	});

	describe("validateAdminSession", () => {
		it("returns false when no cookie is set", async () => {
			vi.stubEnv("SESSION_SECRET", "test-secret-long-enough-for-hmac");
			mockCookieGet.mockReturnValue(undefined);

			const { validateAdminSession } = await import("./session");
			const result = await validateAdminSession();

			expect(result).toBe(false);
		});

		it("returns false when cookie has invalid signature", async () => {
			vi.stubEnv("SESSION_SECRET", "test-secret-long-enough-for-hmac");
			mockCookieGet.mockReturnValue({
				value: '{"role":"admin","iat":999999999}.invalidsignature',
			});

			const { validateAdminSession } = await import("./session");
			const result = await validateAdminSession();

			expect(result).toBe(false);
		});

		it("returns true for a valid session cookie", async () => {
			vi.stubEnv("SESSION_SECRET", "test-secret-long-enough-for-hmac");

			// First create a session to get a valid token
			const { createAdminSession, validateAdminSession } = await import("./session");
			await createAdminSession();

			const token = mockCookieSet.mock.calls[0]![1];
			mockCookieGet.mockReturnValue({ value: token });

			const result = await validateAdminSession();
			expect(result).toBe(true);
		});

		it("returns false when SESSION_SECRET is not set", async () => {
			mockCookieGet.mockReturnValue({ value: "some.token" });

			const { validateAdminSession } = await import("./session");
			const result = await validateAdminSession();

			expect(result).toBe(false);
		});

		it("returns false for expired session", async () => {
			vi.stubEnv("SESSION_SECRET", "test-secret-long-enough-for-hmac");

			// Manually create an expired payload
			const { createAdminSession, validateAdminSession } = await import("./session");

			// Mock Date.now to create a session in the past
			const originalNow = Date.now;
			const pastTime = originalNow() - 25 * 60 * 60 * 1000; // 25 hours ago
			vi.spyOn(Date, "now").mockReturnValue(pastTime);

			await createAdminSession();
			const token = mockCookieSet.mock.calls[0]![1];

			// Restore time
			vi.spyOn(Date, "now").mockReturnValue(originalNow());

			mockCookieGet.mockReturnValue({ value: token });
			const result = await validateAdminSession();
			expect(result).toBe(false);
		});
	});

	describe("requireAdminSession", () => {
		it("redirects to /admin/login when session is invalid", async () => {
			vi.stubEnv("SESSION_SECRET", "test-secret-long-enough-for-hmac");
			mockCookieGet.mockReturnValue(undefined);

			const { requireAdminSession } = await import("./session");
			await expect(requireAdminSession()).rejects.toThrow("NEXT_REDIRECT");
			expect(mockRedirect).toHaveBeenCalledWith("/admin/login");
		});

		it("does not redirect when session is valid", async () => {
			vi.stubEnv("SESSION_SECRET", "test-secret-long-enough-for-hmac");

			const { createAdminSession, requireAdminSession } = await import("./session");
			await createAdminSession();
			const token = mockCookieSet.mock.calls[0]![1];
			mockCookieGet.mockReturnValue({ value: token });

			await requireAdminSession();
			expect(mockRedirect).not.toHaveBeenCalled();
		});
	});

	describe("clearAdminSession", () => {
		it("deletes the session cookie", async () => {
			const { clearAdminSession } = await import("./session");
			await clearAdminSession();

			expect(mockCookieDelete).toHaveBeenCalledWith("dobby_admin_session");
		});
	});
});
