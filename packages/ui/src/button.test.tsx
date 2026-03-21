import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
	it("renders with default variant", () => {
		render(<Button>Click me</Button>);
		const button = screen.getByRole("button", { name: "Click me" });
		expect(button).toBeInTheDocument();
	});

	it("applies variant classes via CVA", () => {
		render(<Button variant="destructive">Delete</Button>);
		const button = screen.getByRole("button", { name: "Delete" });
		expect(button.className).toContain("bg-red-600");
	});

	it("applies size classes via CVA", () => {
		render(<Button size="sm">Small</Button>);
		const button = screen.getByRole("button", { name: "Small" });
		expect(button.className).toContain("h-8");
	});

	it("merges custom className", () => {
		render(<Button className="mt-4">Styled</Button>);
		const button = screen.getByRole("button", { name: "Styled" });
		expect(button.className).toContain("mt-4");
	});

	it("renders as child element when asChild is true", () => {
		render(
			<Button asChild>
				<a href="/test">Link Button</a>
			</Button>,
		);
		const link = screen.getByRole("link", { name: "Link Button" });
		expect(link).toBeInTheDocument();
		expect(link.tagName).toBe("A");
	});
});
