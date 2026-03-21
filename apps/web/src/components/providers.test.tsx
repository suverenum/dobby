import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock idb-keyval since it requires IndexedDB
vi.mock("idb-keyval", () => ({
	get: vi.fn().mockResolvedValue(undefined),
	set: vi.fn().mockResolvedValue(undefined),
	del: vi.fn().mockResolvedValue(undefined),
}));

// Mock posthog-js
vi.mock("posthog-js", () => ({
	default: {
		init: vi.fn(),
	},
}));

vi.mock("posthog-js/react", () => ({
	PostHogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("Providers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();
		vi.resetModules();
		// next-themes requires matchMedia
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: vi.fn().mockImplementation((query: string) => ({
				matches: false,
				media: query,
				onchange: null,
				addListener: vi.fn(),
				removeListener: vi.fn(),
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				dispatchEvent: vi.fn(),
			})),
		});
	});

	it("renders children without errors", async () => {
		vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test123");
		const { Providers } = await import("./providers");
		render(
			<Providers>
				<div data-testid="child">Hello</div>
			</Providers>,
		);
		expect(screen.getByTestId("child")).toBeInTheDocument();
	});

	it("works without PostHog key (graceful degradation)", async () => {
		vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
		const posthog = (await import("posthog-js")).default;
		const { Providers } = await import("./providers");
		render(
			<Providers>
				<span>Content</span>
			</Providers>,
		);
		expect(screen.getByText("Content")).toBeInTheDocument();
		expect(posthog.init).not.toHaveBeenCalled();
	});
});
