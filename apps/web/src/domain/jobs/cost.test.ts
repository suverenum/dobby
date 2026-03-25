import { describe, expect, it } from "vitest";
import {
	calculateBedrockCost,
	calculateContainerCost,
	formatCostUsd,
	formatTokenCount,
} from "./cost";

describe("calculateBedrockCost", () => {
	const defaultPricing = {
		inputPer1M: 5.0,
		outputPer1M: 25.0,
		cacheReadPer1M: 0.5,
		cacheWritePer1M: 6.25,
	};

	it("calculates standard usage correctly", () => {
		const cost = calculateBedrockCost(
			{
				inputTokens: 100_000,
				outputTokens: 50_000,
				cacheReadTokens: 200_000,
				cacheWriteTokens: 80_000,
			},
			defaultPricing,
		);
		// (100K/1M)*5 + (50K/1M)*25 + (200K/1M)*0.5 + (80K/1M)*6.25
		// = 0.5 + 1.25 + 0.1 + 0.5 = 2.35
		expect(cost).toBeCloseTo(2.35, 6);
	});

	it("returns 0 for zero tokens across all fields", () => {
		const cost = calculateBedrockCost(
			{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			defaultPricing,
		);
		expect(cost).toBe(0);
	});

	it("calculates correctly with only input tokens", () => {
		const cost = calculateBedrockCost({ inputTokens: 1_000_000, outputTokens: 0 }, defaultPricing);
		expect(cost).toBeCloseTo(5.0, 6);
	});

	it("calculates correctly with only output tokens", () => {
		const cost = calculateBedrockCost({ inputTokens: 0, outputTokens: 1_000_000 }, defaultPricing);
		expect(cost).toBeCloseTo(25.0, 6);
	});

	it("calculates correctly with only cache read tokens", () => {
		const cost = calculateBedrockCost(
			{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
			defaultPricing,
		);
		expect(cost).toBeCloseTo(0.5, 6);
	});

	it("calculates correctly with only cache write tokens", () => {
		const cost = calculateBedrockCost(
			{ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 },
			defaultPricing,
		);
		expect(cost).toBeCloseTo(6.25, 6);
	});

	it("treats undefined cache fields as zero", () => {
		const cost = calculateBedrockCost(
			{ inputTokens: 100_000, outputTokens: 50_000 },
			defaultPricing,
		);
		// (100K/1M)*5 + (50K/1M)*25 = 0.5 + 1.25 = 1.75
		expect(cost).toBeCloseTo(1.75, 6);
	});

	it("handles large token counts (100M+) without overflow", () => {
		const cost = calculateBedrockCost(
			{
				inputTokens: 100_000_000,
				outputTokens: 100_000_000,
				cacheReadTokens: 100_000_000,
				cacheWriteTokens: 100_000_000,
			},
			defaultPricing,
		);
		// (100M/1M)*5 + (100M/1M)*25 + (100M/1M)*0.5 + (100M/1M)*6.25
		// = 500 + 2500 + 50 + 625 = 3675
		expect(cost).toBeCloseTo(3675, 2);
	});

	it("produces results with precision to 6 decimal places", () => {
		const cost = calculateBedrockCost({ inputTokens: 1, outputTokens: 1 }, defaultPricing);
		// (1/1M)*5 + (1/1M)*25 = 0.000005 + 0.000025 = 0.00003
		expect(cost).toBeCloseTo(0.00003, 10);
	});

	it("works with custom pricing", () => {
		const customPricing = {
			inputPer1M: 3.0,
			outputPer1M: 15.0,
			cacheReadPer1M: 0.3,
			cacheWritePer1M: 3.75,
		};
		const cost = calculateBedrockCost(
			{ inputTokens: 1_000_000, outputTokens: 1_000_000 },
			customPricing,
		);
		expect(cost).toBeCloseTo(18.0, 6);
	});

	it("works with all pricing at zero", () => {
		const zeroPricing = {
			inputPer1M: 0,
			outputPer1M: 0,
			cacheReadPer1M: 0,
			cacheWritePer1M: 0,
		};
		const cost = calculateBedrockCost(
			{ inputTokens: 1_000_000, outputTokens: 1_000_000 },
			zeroPricing,
		);
		expect(cost).toBe(0);
	});
});

describe("calculateContainerCost", () => {
	const defaultPricing = {
		vcpuPerHour: 0.01334058,
		memGbPerHour: 0.00146489,
		ephemeralGbPerHour: 0.000111,
	};

	it("calculates standard 8m30s with 4 vCPU, 16 GB, 1 GB ephemeral", () => {
		const durationMs = 8 * 60_000 + 30_000; // 8m30s
		const cost = calculateContainerCost(durationMs, 4, 16, 1, defaultPricing);
		const hours = durationMs / 3_600_000;
		const expected = hours * (4 * 0.01334058 + 16 * 0.00146489 + 1 * 0.000111);
		expect(cost).toBeCloseTo(expected, 6);
	});

	it("returns 0 for zero duration", () => {
		const cost = calculateContainerCost(0, 4, 16, 1, defaultPricing);
		expect(cost).toBe(0);
	});

	it("calculates correctly for very short duration (1 second)", () => {
		const cost = calculateContainerCost(1000, 4, 16, 1, defaultPricing);
		const hours = 1000 / 3_600_000;
		const expected = hours * (4 * 0.01334058 + 16 * 0.00146489 + 1 * 0.000111);
		expect(cost).toBeCloseTo(expected, 10);
	});

	it("calculates correctly for very long duration (6 hours)", () => {
		const durationMs = 6 * 3_600_000;
		const cost = calculateContainerCost(durationMs, 4, 16, 1, defaultPricing);
		const expected = 6 * (4 * 0.01334058 + 16 * 0.00146489 + 1 * 0.000111);
		expect(cost).toBeCloseTo(expected, 4);
	});

	it("scales linearly with different vCPU counts", () => {
		const durationMs = 3_600_000; // 1 hour
		const cost1 = calculateContainerCost(durationMs, 1, 4, 0, defaultPricing);
		const cost4 = calculateContainerCost(durationMs, 4, 16, 0, defaultPricing);
		// cost4 should be ~4x cost1 (due to both vCPU and memory scaling)
		expect(cost4 / cost1).toBeCloseTo(4, 1);
	});

	it("returns no ephemeral cost when overage is zero", () => {
		const durationMs = 3_600_000; // 1 hour
		const costWithEphemeral = calculateContainerCost(durationMs, 4, 16, 1, defaultPricing);
		const costWithoutEphemeral = calculateContainerCost(durationMs, 4, 16, 0, defaultPricing);
		expect(costWithEphemeral).toBeGreaterThan(costWithoutEphemeral);
		expect(costWithEphemeral - costWithoutEphemeral).toBeCloseTo(0.000111, 6);
	});

	it("works with different vCPU sizes (1, 2, 4, 8)", () => {
		const durationMs = 3_600_000;
		const costs = [1, 2, 4, 8].map((vcpu) =>
			calculateContainerCost(durationMs, vcpu, vcpu * 4, 1, defaultPricing),
		);
		// Each should be roughly double the previous
		expect(costs[1]! / costs[0]!).toBeCloseTo(2, 1);
		expect(costs[2]! / costs[1]!).toBeCloseTo(2, 1);
		expect(costs[3]! / costs[2]!).toBeCloseTo(2, 1);
	});
});

describe("formatTokenCount", () => {
	it("returns raw number for values less than 1000", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(1)).toBe("1");
		expect(formatTokenCount(500)).toBe("500");
	});

	it("formats thousands with K suffix", () => {
		expect(formatTokenCount(1000)).toBe("1.0K");
		expect(formatTokenCount(1500)).toBe("1.5K");
		expect(formatTokenCount(1234)).toBe("1.2K");
		expect(formatTokenCount(999_999)).toBe("1000.0K");
	});

	it("formats millions with M suffix", () => {
		expect(formatTokenCount(1_000_000)).toBe("1.0M");
		expect(formatTokenCount(1_500_000)).toBe("1.5M");
		expect(formatTokenCount(1_234_567)).toBe("1.2M");
		expect(formatTokenCount(125_000_000)).toBe("125.0M");
	});

	it("formats typical usage values", () => {
		expect(formatTokenCount(125_000)).toBe("125.0K");
		expect(formatTokenCount(45_000)).toBe("45.0K");
		expect(formatTokenCount(80_000)).toBe("80.0K");
	});
});

describe("formatCostUsd", () => {
	it("formats zero", () => {
		expect(formatCostUsd(0)).toBe("$0.00");
	});

	it("formats very small amounts", () => {
		expect(formatCostUsd(0.001)).toBe("$0.00");
	});

	it("formats typical costs", () => {
		expect(formatCostUsd(3.52)).toBe("$3.52");
		expect(formatCostUsd(3.526)).toBe("$3.53");
	});

	it("formats larger amounts", () => {
		expect(formatCostUsd(123.45)).toBe("$123.45");
		expect(formatCostUsd(1975.0)).toBe("$1975.00");
	});
});
