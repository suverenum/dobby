import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "./input";

describe("Input", () => {
	it("renders an input element", () => {
		render(<Input placeholder="Enter text" />);
		const input = screen.getByPlaceholderText("Enter text");
		expect(input).toBeInTheDocument();
		expect(input.tagName).toBe("INPUT");
	});

	it("applies size variant classes via CVA", () => {
		render(<Input inputSize="lg" placeholder="Large" />);
		const input = screen.getByPlaceholderText("Large");
		expect(input.className).toContain("h-11");
	});

	it("forwards type prop", () => {
		render(<Input type="email" placeholder="Email" />);
		const input = screen.getByPlaceholderText("Email");
		expect(input).toHaveAttribute("type", "email");
	});

	it("merges custom className", () => {
		render(<Input className="mt-4" placeholder="Custom" />);
		const input = screen.getByPlaceholderText("Custom");
		expect(input.className).toContain("mt-4");
	});
});
