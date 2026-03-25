export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

export interface BedrockPricing {
	inputPer1M: number;
	outputPer1M: number;
	cacheReadPer1M: number;
	cacheWritePer1M: number;
}

export interface FargatePricing {
	vcpuPerHour: number;
	memGbPerHour: number;
	ephemeralGbPerHour: number;
}

export function calculateBedrockCost(usage: TokenUsage, pricing: BedrockPricing): number {
	return (
		(usage.inputTokens / 1_000_000) * pricing.inputPer1M +
		(usage.outputTokens / 1_000_000) * pricing.outputPer1M +
		((usage.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheReadPer1M +
		((usage.cacheWriteTokens ?? 0) / 1_000_000) * pricing.cacheWritePer1M
	);
}

export function calculateContainerCost(
	durationMs: number,
	vcpu: number,
	memGb: number,
	ephemeralGbOverBase: number,
	pricing: FargatePricing,
): number {
	const hours = durationMs / 3_600_000;
	return (
		hours *
		(vcpu * pricing.vcpuPerHour +
			memGb * pricing.memGbPerHour +
			ephemeralGbOverBase * pricing.ephemeralGbPerHour)
	);
}

export function formatTokenCount(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCostUsd(n: number): string {
	return `$${n.toFixed(2)}`;
}
