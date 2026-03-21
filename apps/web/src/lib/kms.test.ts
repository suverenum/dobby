import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-kms", () => {
	return {
		KMSClient: vi.fn().mockImplementation(() => ({
			send: mockSend,
		})),
		EncryptCommand: vi.fn().mockImplementation((input) => ({
			_type: "EncryptCommand",
			input,
		})),
		DecryptCommand: vi.fn().mockImplementation((input) => ({
			_type: "DecryptCommand",
			input,
		})),
	};
});

describe("kms", () => {
	beforeEach(() => {
		vi.resetModules();
		mockSend.mockReset();
		vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/db");
		vi.stubEnv("KMS_KEY_ID", "arn:aws:kms:us-east-1:123456789:key/test-key");
		vi.stubEnv("AWS_REGION", "us-east-1");
	});

	describe("encrypt", () => {
		it("encrypts plaintext and returns base64-encoded ciphertext", async () => {
			const fakeCiphertext = new Uint8Array([1, 2, 3, 4, 5]);
			mockSend.mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext });

			const { encrypt, _resetClient } = await import("./kms");
			_resetClient();
			const result = await encrypt("my-secret-token");

			expect(result).toBe(Buffer.from(fakeCiphertext).toString("base64"));
			expect(mockSend).toHaveBeenCalledOnce();

			const call = mockSend.mock.calls[0]![0];
			expect(call.input.KeyId).toBe("arn:aws:kms:us-east-1:123456789:key/test-key");
			expect(new TextDecoder().decode(call.input.Plaintext)).toBe("my-secret-token");
		});

		it("throws when KMS_KEY_ID is not configured", async () => {
			delete process.env.KMS_KEY_ID;
			const { encrypt, _resetClient } = await import("./kms");
			_resetClient();

			await expect(encrypt("secret")).rejects.toThrow("KMS_KEY_ID is not configured");
			expect(mockSend).not.toHaveBeenCalled();
		});

		it("throws when KMS returns no ciphertext", async () => {
			mockSend.mockResolvedValueOnce({ CiphertextBlob: undefined });

			const { encrypt, _resetClient } = await import("./kms");
			_resetClient();

			await expect(encrypt("secret")).rejects.toThrow("KMS encrypt returned no ciphertext");
		});
	});

	describe("decrypt", () => {
		it("decrypts base64-encoded ciphertext and returns plaintext", async () => {
			const plaintext = "my-secret-token";
			const plaintextBytes = new TextEncoder().encode(plaintext);
			mockSend.mockResolvedValueOnce({ Plaintext: plaintextBytes });

			const { decrypt, _resetClient } = await import("./kms");
			_resetClient();

			const ciphertext = Buffer.from([1, 2, 3, 4, 5]).toString("base64");
			const result = await decrypt(ciphertext);

			expect(result).toBe(plaintext);
			expect(mockSend).toHaveBeenCalledOnce();

			const call = mockSend.mock.calls[0]![0];
			expect(Buffer.from(call.input.CiphertextBlob).toString("base64")).toBe(ciphertext);
		});

		it("throws when KMS returns no plaintext", async () => {
			mockSend.mockResolvedValueOnce({ Plaintext: undefined });

			const { decrypt, _resetClient } = await import("./kms");
			_resetClient();

			await expect(decrypt("AQID")).rejects.toThrow("KMS decrypt returned no plaintext");
		});
	});

	describe("roundtrip", () => {
		it("plaintext is never stored — only base64-encoded ciphertext", async () => {
			const secret = "super-secret-password-123";
			const fakeCiphertext = new Uint8Array([10, 20, 30, 40, 50]);
			mockSend.mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext });

			const { encrypt, _resetClient } = await import("./kms");
			_resetClient();
			const encrypted = await encrypt(secret);

			// Encrypted value is base64, not the original plaintext
			expect(encrypted).not.toBe(secret);
			expect(encrypted).toBe(Buffer.from(fakeCiphertext).toString("base64"));

			// The plaintext was sent to KMS as bytes, not stored
			const call = mockSend.mock.calls[0]![0];
			expect(new TextDecoder().decode(call.input.Plaintext)).toBe(secret);
		});
	});

	describe("client caching", () => {
		it("reuses the KMS client across calls", async () => {
			const { KMSClient } = await import("@aws-sdk/client-kms");
			const callCountBefore = (KMSClient as unknown as { mock: { calls: unknown[] } }).mock.calls
				.length;

			const fakeCiphertext = new Uint8Array([1, 2, 3]);
			mockSend
				.mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext })
				.mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext });

			const { encrypt, _resetClient } = await import("./kms");
			_resetClient();
			await encrypt("first");
			await encrypt("second");

			const callCountAfter = (KMSClient as unknown as { mock: { calls: unknown[] } }).mock.calls
				.length;
			// Client constructor called only once in this test (cached after first call)
			expect(callCountAfter - callCountBefore).toBe(1);
		});
	});
});
