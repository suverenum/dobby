import { getEnv } from "./env";

export interface PreauthorizationResult {
	valid: boolean;
	channelId: string;
	authorizedAmount: number;
}

export interface SettlementResult {
	settled: boolean;
	channelId: string;
	settledAmount: number;
	refundedAmount: number;
}

/**
 * Validate that an MPP payment token covers the required max budget.
 *
 * Calls the MPP endpoint to verify preauthorization.
 * If MPP_ENDPOINT is not configured, falls back to accepting the token as-is
 * (useful for development/testing without a live MPP service).
 */
export async function validatePreauthorization(
	mppToken: string,
	maxBudget: number,
): Promise<PreauthorizationResult> {
	const env = getEnv();

	if (!env.MPP_ENDPOINT) {
		// Dev mode: accept any token, use it as channelId
		return {
			valid: true,
			channelId: mppToken,
			authorizedAmount: maxBudget,
		};
	}

	const response = await fetch(`${env.MPP_ENDPOINT}/v1/preauthorizations/validate`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(env.MPP_API_KEY ? { Authorization: `Bearer ${env.MPP_API_KEY}` } : {}),
		},
		body: JSON.stringify({
			token: mppToken,
			requiredAmount: maxBudget,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "Unknown error");
		throw new MppError(`MPP preauthorization failed (${response.status}): ${errorText}`);
	}

	const data = (await response.json()) as {
		valid: boolean;
		channelId: string;
		authorizedAmount: number;
	};

	return {
		valid: data.valid,
		channelId: data.channelId,
		authorizedAmount: data.authorizedAmount,
	};
}

/**
 * Settle an MPP escrow with the final job cost.
 *
 * Calls escrow.close() with the actual amount. Any unused authorization
 * is automatically refunded to the caller on-chain.
 */
export async function settlePayment(
	mppChannelId: string,
	actualCost: number,
	authorizedAmount: number,
): Promise<SettlementResult> {
	const env = getEnv();

	if (!env.MPP_ENDPOINT) {
		// Dev mode: simulate settlement
		return {
			settled: true,
			channelId: mppChannelId,
			settledAmount: actualCost,
			refundedAmount: authorizedAmount - actualCost,
		};
	}

	const response = await fetch(`${env.MPP_ENDPOINT}/v1/escrow/close`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(env.MPP_API_KEY ? { Authorization: `Bearer ${env.MPP_API_KEY}` } : {}),
		},
		body: JSON.stringify({
			channelId: mppChannelId,
			amount: actualCost,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "Unknown error");
		throw new MppError(`MPP settlement failed (${response.status}): ${errorText}`);
	}

	const data = (await response.json()) as {
		settled: boolean;
		channelId: string;
		settledAmount: number;
		refundedAmount: number;
	};

	return {
		settled: data.settled,
		channelId: data.channelId,
		settledAmount: data.settledAmount,
		refundedAmount: data.refundedAmount,
	};
}

export class MppError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MppError";
	}
}
