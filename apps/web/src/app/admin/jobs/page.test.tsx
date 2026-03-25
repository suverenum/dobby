import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock next/link
vi.mock("next/link", () => ({
	default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
		<a href={href} {...props}>
			{children}
		</a>
	),
}));

// Mock session
vi.mock("../../../lib/session", () => ({
	requireAdminSession: vi.fn().mockResolvedValue(undefined),
}));

// Mock DB
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();

let mockJobRows: Array<Record<string, unknown>> = [];

vi.mock("../../../db", () => ({
	getDb: () => ({
		select: (...args: unknown[]) => {
			mockSelect(...args);
			return {
				from: (...fArgs: unknown[]) => {
					mockFrom(...fArgs);
					return {
						orderBy: (...oArgs: unknown[]) => {
							mockOrderBy(...oArgs);
							return Promise.resolve(mockJobRows);
						},
						where: (...wArgs: unknown[]) => {
							mockWhere(...wArgs);
							return {
								orderBy: (...oArgs: unknown[]) => {
									mockOrderBy(...oArgs);
									return Promise.resolve(mockJobRows);
								},
							};
						},
					};
				},
			};
		},
	}),
}));

// Mock the status-filter client component
vi.mock("./status-filter", () => ({
	JobStatusFilter: ({ current }: { current: string }) => (
		<div data-testid="status-filter" data-current={current}>
			Filter
		</div>
	),
}));

function makeJob(overrides: Record<string, unknown> = {}) {
	return {
		id: "db_abc123",
		status: "executing",
		repository: "https://github.com/org/repo.git",
		baseBranch: "main",
		workingBranch: "dobby/fix-bug",
		task: "Fix the login bug that causes users to be redirected incorrectly",
		existingPrUrl: null,
		prUrl: null,
		encryptedGitCredentials: "enc_creds",
		encryptedSecrets: null,
		ecsTaskArn: null,
		ecsClusterArn: null,
		logStreamName: null,
		inputTokens: null,
		outputTokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
		bedrockCostUsd: null,
		containerCostUsd: null,
		costUsd: "12.50",
		submittedAt: new Date("2026-03-20T10:00:00Z"),
		startedAt: new Date("2026-03-20T10:01:00Z"),
		finishedAt: null,
		resumeCount: 0,
		lastCheckpointCommit: null,
		interruptedAt: null,
		...overrides,
	};
}

// Import the page component once (mock modules are hoisted)
import AdminJobsPage from "./page";

describe("AdminJobsPage", () => {
	beforeEach(() => {
		cleanup();
		mockJobRows = [];
		mockSelect.mockClear();
		mockFrom.mockClear();
		mockWhere.mockClear();
		mockOrderBy.mockClear();
	});

	it("renders empty state when no jobs exist", async () => {
		mockJobRows = [];
		const element = await AdminJobsPage({ searchParams: Promise.resolve({}) });
		render(element);

		expect(screen.getByText("No results.")).toBeDefined();
	});

	it("renders job rows with correct data", async () => {
		mockJobRows = [
			makeJob({
				id: "db_test1",
				repository: "https://github.com/acme/widget.git",
				task: "Add dark mode support",
				status: "completed",
				costUsd: "25.000000",
				submittedAt: new Date("2026-03-20T10:00:00Z"),
				startedAt: new Date("2026-03-20T10:01:00Z"),
				finishedAt: new Date("2026-03-20T10:31:00Z"),
			}),
		];

		const element = await AdminJobsPage({ searchParams: Promise.resolve({}) });
		render(element);

		expect(screen.getByText("db_test1")).toBeDefined();
		expect(screen.getByText("acme/widget")).toBeDefined();
		expect(screen.getByText("Add dark mode support")).toBeDefined();
		expect(screen.getByText("completed")).toBeDefined();
		expect(screen.getByText("$25.00")).toBeDefined();
	});

	it("truncates long task text", async () => {
		const longTask = "A".repeat(100);
		mockJobRows = [makeJob({ task: longTask })];

		const element = await AdminJobsPage({ searchParams: Promise.resolve({}) });
		render(element);

		expect(screen.getByText(`${"A".repeat(80)}...`)).toBeDefined();
	});

	it("renders job ID as link to detail page", async () => {
		mockJobRows = [makeJob({ id: "db_link1" })];

		const element = await AdminJobsPage({ searchParams: Promise.resolve({}) });
		render(element);

		const link = screen.getByText("db_link1");
		expect(link.closest("a")?.getAttribute("href")).toBe("/admin/jobs/db_link1");
	});

	it("passes current filter to status filter component", async () => {
		mockJobRows = [];
		const element = await AdminJobsPage({
			searchParams: Promise.resolve({ status: "completed" }),
		});
		render(element);

		const filter = screen.getByTestId("status-filter");
		expect(filter.getAttribute("data-current")).toBe("completed");
	});

	it("defaults to 'active' filter for invalid status param", async () => {
		mockJobRows = [];
		const element = await AdminJobsPage({
			searchParams: Promise.resolve({ status: "invalid_status" }),
		});
		render(element);

		const filter = screen.getByTestId("status-filter");
		expect(filter.getAttribute("data-current")).toBe("active");
	});

	it("displays duration for running jobs", async () => {
		// Job started 90 minutes ago, still running
		const ninetyMinAgo = new Date(Date.now() - 90 * 60_000);
		mockJobRows = [makeJob({ startedAt: ninetyMinAgo, finishedAt: null })];

		const element = await AdminJobsPage({ searchParams: Promise.resolve({}) });
		render(element);

		// Should show something like "1h 30m"
		const durationCell = screen.getByText(/^\d+h \d+m$/);
		expect(durationCell).toBeDefined();
	});

	it("shows dash for cost when costUsd is null", async () => {
		mockJobRows = [makeJob({ costUsd: null, startedAt: null })];

		const element = await AdminJobsPage({ searchParams: Promise.resolve({}) });
		render(element);

		// There should be dashes for null values
		const dashes = screen.getAllByText("-");
		expect(dashes.length).toBeGreaterThan(0);
	});

	it("renders multiple jobs", async () => {
		mockJobRows = [
			makeJob({ id: "db_first", submittedAt: new Date("2026-03-21T00:00:00Z") }),
			makeJob({ id: "db_second", submittedAt: new Date("2026-03-20T00:00:00Z") }),
		];

		const element = await AdminJobsPage({ searchParams: Promise.resolve({}) });
		render(element);

		expect(screen.getByText("db_first")).toBeDefined();
		expect(screen.getByText("db_second")).toBeDefined();
	});

	it("calls DB with where clause when status filter is set", async () => {
		mockJobRows = [];
		const element = await AdminJobsPage({
			searchParams: Promise.resolve({ status: "completed" }),
		});
		render(element);

		expect(mockWhere).toHaveBeenCalled();
	});

	it("does not call where clause for job query on 'all' filter", async () => {
		mockJobRows = [];
		mockWhere.mockClear();
		const element = await AdminJobsPage({
			searchParams: Promise.resolve({ status: "all" }),
		});
		render(element);

		// where is called exactly 2 times for count queries (active + completed), not 3
		expect(mockWhere).toHaveBeenCalledTimes(2);
	});
});
