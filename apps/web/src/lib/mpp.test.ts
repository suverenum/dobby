import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to reset env cache between tests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("MPP Payment Integration", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		mockFetch.mockReset();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe("validatePreauthorization", () => {
		it("returns valid in dev mode when MPP_ENDPOINT is not set", async () => {
			// No MPP_ENDPOINT set — dev mode
			const { validatePreauthorization } = await import("./mpp");
			const result = await validatePreauthorization("test-token", 600);

			expect(result.valid).toBe(true);
			expect(result.channelId).toBe("test-token");
			expect(result.authorizedAmount).toBe(600);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("calls MPP endpoint when configured", async () => {
			vi.stubEnv("MPP_ENDPOINT", "https://mpp.example.com");
			vi.stubEnv("MPP_API_KEY", "mpp-key-123");

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					valid: true,
					channelId: "channel-abc",
					authorizedAmount: 600,
				}),
			});

			const { validatePreauthorization } = await import("./mpp");
			const result = await validatePreauthorization("mpp-token-xyz", 600);

			expect(result.valid).toBe(true);
			expect(result.channelId).toBe("channel-abc");
			expect(result.authorizedAmount).toBe(600);

			expect(mockFetch).toHaveBeenCalledOnce();
			const [url, options] = mockFetch.mock.calls[0]!;
			expect(url).toBe("https://mpp.example.com/v1/preauthorizations/validate");
			expect(options.method).toBe("POST");
			expect(options.headers.Authorization).toBe("Bearer mpp-key-123");
			expect(JSON.parse(options.body)).toEqual({
				token: "mpp-token-xyz",
				requiredAmount: 600,
			});
		});

		it("does not send Authorization header when MPP_API_KEY is not set", async () => {
			vi.stubEnv("MPP_ENDPOINT", "https://mpp.example.com");

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					valid: true,
					channelId: "channel-abc",
					authorizedAmount: 600,
				}),
			});

			const { validatePreauthorization } = await import("./mpp");
			await validatePreauthorization("token", 600);

			const [, options] = mockFetch.mock.calls[0]!;
			expect(options.headers.Authorization).toBeUndefined();
		});

		it("throws MppError when MPP endpoint returns non-ok response", async () => {
			vi.stubEnv("MPP_ENDPOINT", "https://mpp.example.com");

			mockFetch.mockResolvedValue({
				ok: false,
				status: 402,
				text: async () => "Insufficient funds",
			});

			const { validatePreauthorization, MppError } = await import("./mpp");

			await expect(validatePreauthorization("token", 600)).rejects.toThrow(MppError);
			await expect(validatePreauthorization("token", 600)).rejects.toThrow(
				/MPP preauthorization failed/,
			);
		});

		it("returns invalid when MPP says token is invalid", async () => {
			vi.stubEnv("MPP_ENDPOINT", "https://mpp.example.com");

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					valid: false,
					channelId: "",
					authorizedAmount: 0,
				}),
			});

			const { validatePreauthorization } = await import("./mpp");
			const result = await validatePreauthorization("bad-token", 600);

			expect(result.valid).toBe(false);
		});
	});

	describe("settlePayment", () => {
		it("simulates settlement in dev mode when MPP_ENDPOINT is not set", async () => {
			const { settlePayment } = await import("./mpp");
			const result = await settlePayment("channel-abc", 50, 600);

			expect(result.settled).toBe(true);
			expect(result.channelId).toBe("channel-abc");
			expect(result.settledAmount).toBe(50);
			expect(result.refundedAmount).toBe(550);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("calls escrow close endpoint when configured", async () => {
			vi.stubEnv("MPP_ENDPOINT", "https://mpp.example.com");
			vi.stubEnv("MPP_API_KEY", "mpp-key-123");

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					settled: true,
					channelId: "channel-abc",
					settledAmount: 50,
					refundedAmount: 550,
				}),
			});

			const { settlePayment } = await import("./mpp");
			const result = await settlePayment("channel-abc", 50, 600);

			expect(result.settled).toBe(true);
			expect(result.settledAmount).toBe(50);
			expect(result.refundedAmount).toBe(550);

			expect(mockFetch).toHaveBeenCalledOnce();
			const [url, options] = mockFetch.mock.calls[0]!;
			expect(url).toBe("https://mpp.example.com/v1/escrow/close");
			expect(options.method).toBe("POST");
			expect(options.headers.Authorization).toBe("Bearer mpp-key-123");
			expect(JSON.parse(options.body)).toEqual({
				channelId: "channel-abc",
				amount: 50,
			});
		});

		it("throws MppError when settlement fails", async () => {
			vi.stubEnv("MPP_ENDPOINT", "https://mpp.example.com");

			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "Internal server error",
			});

			const { settlePayment, MppError } = await import("./mpp");

			await expect(settlePayment("channel-abc", 50, 600)).rejects.toThrow(MppError);
			await expect(settlePayment("channel-abc", 50, 600)).rejects.toThrow(/MPP settlement failed/);
		});

		it("calculates correct refund amount in dev mode", async () => {
			const { settlePayment } = await import("./mpp");

			// Job ran for only 10 FLOPS worth, authorized 600
			const result = await settlePayment("channel-abc", 10, 600);
			expect(result.refundedAmount).toBe(590);

			// Job ran for full authorized amount
			const result2 = await settlePayment("channel-abc", 600, 600);
			expect(result2.refundedAmount).toBe(0);
		});

		it("settles with zero cost for jobs that never started", async () => {
			const { settlePayment } = await import("./mpp");
			const result = await settlePayment("channel-abc", 0, 600);

			expect(result.settled).toBe(true);
			expect(result.settledAmount).toBe(0);
			expect(result.refundedAmount).toBe(600);
		});
	});
});
