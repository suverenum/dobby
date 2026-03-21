import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
	it("merges class names", () => {
		expect(cn("foo", "bar")).toBe("foo bar");
	});

	it("handles conditional classes via clsx", () => {
		expect(cn("foo", false && "bar", "baz")).toBe("foo baz");
	});

	it("resolves tailwind conflicts with last class winning", () => {
		expect(cn("px-4", "px-2")).toBe("px-2");
	});

	it("handles empty inputs", () => {
		expect(cn()).toBe("");
	});

	it("handles undefined and null values", () => {
		expect(cn("foo", undefined, null, "bar")).toBe("foo bar");
	});
});
