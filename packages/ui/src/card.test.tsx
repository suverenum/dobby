import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

afterEach(() => cleanup());

describe("Card", () => {
	it("renders with default padding", () => {
		render(<Card data-testid="card">Content</Card>);
		const card = screen.getByTestId("card");
		expect(card).toBeInTheDocument();
		expect(card.className).toContain("p-6");
	});

	it("applies padding variant via CVA", () => {
		render(
			<Card padding="sm" data-testid="card">
				Content
			</Card>,
		);
		const card = screen.getByTestId("card");
		expect(card.className).toContain("p-4");
	});

	it("renders full card composition", () => {
		render(
			<Card>
				<CardHeader>
					<CardTitle>Title</CardTitle>
					<CardDescription>Description</CardDescription>
				</CardHeader>
				<CardContent>Body</CardContent>
				<CardFooter>Footer</CardFooter>
			</Card>,
		);
		expect(screen.getByText("Title")).toBeInTheDocument();
		expect(screen.getByText("Description")).toBeInTheDocument();
		expect(screen.getByText("Body")).toBeInTheDocument();
		expect(screen.getByText("Footer")).toBeInTheDocument();
	});

	it("merges custom className", () => {
		render(
			<Card className="mt-4" data-testid="card">
				Content
			</Card>,
		);
		const card = screen.getByTestId("card");
		expect(card.className).toContain("mt-4");
	});
});
