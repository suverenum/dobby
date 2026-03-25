import { describe, expect, it } from "vitest";
import { generateJobId, isValidJobId } from "./id";

describe("generateJobId", () => {
	it("starts with db_ prefix", () => {
		const id = generateJobId();
		expect(id.startsWith("db_")).toBe(true);
	});

	it("has correct length (db_ + 21 char nanoid)", () => {
		const id = generateJobId();
		expect(id.length).toBe(24);
	});

	it("generates unique IDs", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateJobId()));
		expect(ids.size).toBe(100);
	});
});

describe("isValidJobId", () => {
	it("returns true for valid job IDs", () => {
		const id = generateJobId();
		expect(isValidJobId(id)).toBe(true);
	});

	it("returns false for IDs without db_ prefix", () => {
		expect(isValidJobId("abc_V1StGXR8_Z5jdHi6BmyT")).toBe(false);
	});

	it("returns false for IDs that are too short", () => {
		expect(isValidJobId("db_abc")).toBe(false);
	});

	it("returns false for IDs that are too long", () => {
		expect(isValidJobId("db_V1StGXR8_Z5jdHi6BmyTxx")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isValidJobId("")).toBe(false);
	});
});
