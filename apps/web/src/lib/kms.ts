import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { getEnv } from "./env";

let _client: KMSClient | undefined;

function getClient(): KMSClient {
	if (_client) return _client;
	const env = getEnv();
	_client = new KMSClient({
		region: env.AWS_REGION,
		...(env.AWS_ACCESS_KEY_ID &&
			env.AWS_SECRET_ACCESS_KEY && {
				credentials: {
					accessKeyId: env.AWS_ACCESS_KEY_ID,
					secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
				},
			}),
	});
	return _client;
}

/**
 * Encrypt plaintext using AWS KMS. Returns base64-encoded ciphertext.
 */
export async function encrypt(plaintext: string): Promise<string> {
	const env = getEnv();
	if (!env.KMS_KEY_ID) {
		throw new Error("KMS_KEY_ID is not configured");
	}

	const client = getClient();
	const command = new EncryptCommand({
		KeyId: env.KMS_KEY_ID,
		Plaintext: new TextEncoder().encode(plaintext),
	});

	const response = await client.send(command);
	if (!response.CiphertextBlob) {
		throw new Error("KMS encrypt returned no ciphertext");
	}

	return Buffer.from(response.CiphertextBlob).toString("base64");
}

/**
 * Decrypt base64-encoded ciphertext using AWS KMS. Returns plaintext string.
 */
export async function decrypt(ciphertext: string): Promise<string> {
	const client = getClient();
	const command = new DecryptCommand({
		CiphertextBlob: Buffer.from(ciphertext, "base64"),
	});

	const response = await client.send(command);
	if (!response.Plaintext) {
		throw new Error("KMS decrypt returned no plaintext");
	}

	return new TextDecoder().decode(response.Plaintext);
}

/** Reset cached client (for testing) */
export function _resetClient(): void {
	_client = undefined;
}
