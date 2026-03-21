import { describe, expect, it } from "vitest";
import {
	ACTIVE_STATUSES,
	isActiveStatus,
	isTerminalStatus,
	isValidTransition,
	JOB_STATUSES,
	type JobStatus,
	TERMINAL_STATUSES,
	validateTransition,
} from "./status";

describe("JobStatus", () => {
	it("has 10 statuses", () => {
		expect(JOB_STATUSES).toHaveLength(10);
	});

	it("includes all expected statuses", () => {
		const expected = [
			"pending",
			"provisioning",
			"cloning",
			"executing",
			"finalizing",
			"completed",
			"failed",
			"interrupted",
			"timed_out",
			"stopped",
		];
		expect(JOB_STATUSES).toEqual(expected);
	});
});

describe("isValidTransition", () => {
	const validTransitions: [JobStatus, JobStatus][] = [
		["pending", "provisioning"],
		["pending", "failed"],
		["provisioning", "cloning"],
		["provisioning", "failed"],
		["provisioning", "interrupted"],
		["cloning", "executing"],
		["cloning", "failed"],
		["cloning", "interrupted"],
		["executing", "finalizing"],
		["executing", "failed"],
		["executing", "interrupted"],
		["executing", "timed_out"],
		["executing", "stopped"],
		["finalizing", "completed"],
		["finalizing", "failed"],
		["interrupted", "provisioning"],
	];

	for (const [from, to] of validTransitions) {
		it(`allows ${from} → ${to}`, () => {
			expect(isValidTransition(from, to)).toBe(true);
		});
	}

	const invalidTransitions: [JobStatus, JobStatus][] = [
		["pending", "completed"],
		["pending", "executing"],
		["completed", "failed"],
		["completed", "pending"],
		["failed", "completed"],
		["failed", "provisioning"],
		["stopped", "provisioning"],
		["timed_out", "provisioning"],
		["executing", "cloning"],
		["finalizing", "executing"],
		["interrupted", "completed"],
	];

	for (const [from, to] of invalidTransitions) {
		it(`rejects ${from} → ${to}`, () => {
			expect(isValidTransition(from, to)).toBe(false);
		});
	}

	// Edge case: double-stop
	it("rejects stopped → stopped (double-stop)", () => {
		expect(isValidTransition("stopped", "stopped")).toBe(false);
	});

	// Edge case: resume after timeout
	it("rejects timed_out → provisioning (resume after timeout)", () => {
		expect(isValidTransition("timed_out", "provisioning")).toBe(false);
	});
});

describe("validateTransition", () => {
	it("returns the target status on valid transition", () => {
		expect(validateTransition("pending", "provisioning")).toBe("provisioning");
	});

	it("throws on invalid transition", () => {
		expect(() => validateTransition("completed", "pending")).toThrow(
			"Invalid status transition: completed → pending",
		);
	});
});

describe("isTerminalStatus", () => {
	it("returns true for terminal statuses", () => {
		for (const status of TERMINAL_STATUSES) {
			expect(isTerminalStatus(status)).toBe(true);
		}
	});

	it("returns false for non-terminal statuses", () => {
		const nonTerminal: JobStatus[] = [
			"pending",
			"provisioning",
			"cloning",
			"executing",
			"finalizing",
			"interrupted",
		];
		for (const status of nonTerminal) {
			expect(isTerminalStatus(status)).toBe(false);
		}
	});
});

describe("isActiveStatus", () => {
	it("returns true for active statuses", () => {
		for (const status of ACTIVE_STATUSES) {
			expect(isActiveStatus(status)).toBe(true);
		}
	});

	it("returns false for non-active statuses", () => {
		const nonActive: JobStatus[] = [
			"pending",
			"completed",
			"failed",
			"interrupted",
			"timed_out",
			"stopped",
		];
		for (const status of nonActive) {
			expect(isActiveStatus(status)).toBe(false);
		}
	});
});
