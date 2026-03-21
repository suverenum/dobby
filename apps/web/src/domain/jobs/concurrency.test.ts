import { describe, expect, it } from "vitest";
import { calculateMaxConcurrentJobs, hasCapacity } from "./concurrency";

describe("calculateMaxConcurrentJobs", () => {
	it("returns floor(vcpuLimit / vmCpu)", () => {
		expect(calculateMaxConcurrentJobs(24, 4)).toBe(6);
	});

	it("floors when not evenly divisible", () => {
		expect(calculateMaxConcurrentJobs(25, 4)).toBe(6);
	});

	it("returns 1 when limit equals vm cpu", () => {
		expect(calculateMaxConcurrentJobs(4, 4)).toBe(1);
	});

	it("returns 0 when limit is less than vm cpu", () => {
		expect(calculateMaxConcurrentJobs(2, 4)).toBe(0);
	});

	it("handles large limits", () => {
		expect(calculateMaxConcurrentJobs(128, 4)).toBe(32);
	});
});

describe("hasCapacity", () => {
	it("returns true when under capacity", () => {
		expect(hasCapacity(3, 24, 4)).toBe(true);
	});

	it("returns true when zero jobs running", () => {
		expect(hasCapacity(0, 24, 4)).toBe(true);
	});

	it("returns false when at capacity", () => {
		// max = 6, active = 6
		expect(hasCapacity(6, 24, 4)).toBe(false);
	});

	it("returns false when over capacity", () => {
		expect(hasCapacity(7, 24, 4)).toBe(false);
	});

	it("returns true when one slot remaining", () => {
		expect(hasCapacity(5, 24, 4)).toBe(true);
	});

	it("returns false when vcpu limit is 0", () => {
		expect(hasCapacity(0, 0, 4)).toBe(false);
	});
});
