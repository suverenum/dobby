import { describe, expect, it } from "vitest";
import { calculateJobCost, calculateMaxBudget } from "./billing";

describe("calculateJobCost", () => {
	const hourlyRate = 100;
	const maxJobHours = 6;

	it("returns 0 for zero duration", () => {
		expect(calculateJobCost(0, hourlyRate, maxJobHours)).toBe(0);
	});

	it("returns 0 for negative duration", () => {
		expect(calculateJobCost(-1000, hourlyRate, maxJobHours)).toBe(0);
	});

	it("rounds up to 1 minute for sub-minute durations", () => {
		// 30 seconds → ceil to 1 minute → 100/60 ≈ 1.6667
		const cost = calculateJobCost(30_000, hourlyRate, maxJobHours);
		expect(cost).toBeCloseTo(100 / 60, 4);
	});

	it("calculates cost for exact minutes", () => {
		// 5 minutes exactly → 5 * (100/60) ≈ 8.3333
		const cost = calculateJobCost(5 * 60_000, hourlyRate, maxJobHours);
		expect(cost).toBeCloseTo(5 * (100 / 60), 4);
	});

	it("rounds up partial minutes", () => {
		// 5 minutes + 1ms → ceil to 6 minutes → 6 * (100/60) = 10
		const cost = calculateJobCost(5 * 60_000 + 1, hourlyRate, maxJobHours);
		expect(cost).toBeCloseTo(6 * (100 / 60), 4);
	});

	it("calculates cost for 1 hour", () => {
		const cost = calculateJobCost(60 * 60_000, hourlyRate, maxJobHours);
		expect(cost).toBe(100);
	});

	it("caps at max budget", () => {
		// 10 hours exceeds 6-hour max → capped at 600
		const cost = calculateJobCost(10 * 60 * 60_000, hourlyRate, maxJobHours);
		expect(cost).toBe(600);
	});

	it("returns max budget for exactly max hours", () => {
		const cost = calculateJobCost(6 * 60 * 60_000, hourlyRate, maxJobHours);
		expect(cost).toBe(600);
	});

	it("works with different hourly rates", () => {
		const cost = calculateJobCost(60 * 60_000, 200, maxJobHours);
		expect(cost).toBe(200);
	});
});

describe("calculateMaxBudget", () => {
	it("returns hourlyRate * maxJobHours", () => {
		expect(calculateMaxBudget(100, 6)).toBe(600);
	});

	it("works with different values", () => {
		expect(calculateMaxBudget(50, 3)).toBe(150);
	});
});
