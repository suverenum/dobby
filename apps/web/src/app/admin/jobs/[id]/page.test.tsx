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

// Mock next/navigation
vi.mock("next/navigation", () => ({
	notFound: vi.fn(() => {
		throw new Error("NEXT_NOT_FOUND");
	}),
}));

// Mock session
vi.mock("../../../../lib/session", () => ({
	requireAdminSession: vi.fn().mockResolvedValue(undefined),
}));

// Mock DB
let mockJobRows: Array<Record<string, unknown>> = [];

vi.mock("../../../../db", () => ({
	getDb: () => ({
		select: () => ({
			from: () => ({
				where: () => Promise.resolve(mockJobRows),
			}),
		}),
	}),
}));

// Mock client components
vi.mock("./log-viewer", () => ({
	LogViewer: ({ jobId, isTerminal }: { jobId: string; isTerminal: boolean }) => (
		<div data-testid="log-viewer" data-job-id={jobId} data-terminal={String(isTerminal)}>
			LogViewer
		</div>
	),
}));

vi.mock("./stop-button", () => ({
	StopButton: ({ jobId }: { jobId: string }) => (
		<button type="button" data-testid="stop-button" data-job-id={jobId}>
			Stop Job
		</button>
	),
}));

function makeJob(overrides: Record<string, unknown> = {}) {
	return {
		id: "db_detail1",
		status: "executing",
		repository: "https://github.com/org/repo.git",
		baseBranch: "main",
		workingBranch: "dobby/fix-bug",
		task: "Fix the login bug that causes users to be redirected incorrectly",
		existingPrUrl: null,
		prUrl: null,
		encryptedGitCredentials: "enc_creds",
		encryptedSecrets: null,
		ecsTaskArn: "arn:aws:ecs:us-east-1:123:task/abc",
		ecsClusterArn: "arn:aws:ecs:us-east-1:123:cluster/dobby",
		logStreamName: "ecs/dobby-runner/abc",
		authorizedFlops: "600",
		costFlops: "12.50",
		mppChannelId: null,
		submittedAt: new Date("2026-03-20T10:00:00Z"),
		startedAt: new Date("2026-03-20T10:01:00Z"),
		finishedAt: null,
		resumeCount: 0,
		lastCheckpointCommit: null,
		...overrides,
	};
}

import AdminJobDetailPage from "./page";

describe("AdminJobDetailPage", () => {
	beforeEach(() => {
		cleanup();
		mockJobRows = [];
	});

	it("calls notFound when job does not exist", async () => {
		mockJobRows = [];
		await expect(
			AdminJobDetailPage({ params: Promise.resolve({ id: "db_missing" }) }),
		).rejects.toThrow("NEXT_NOT_FOUND");
	});

	it("renders job ID and status", async () => {
		mockJobRows = [makeJob()];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		expect(screen.getByText("db_detail1")).toBeDefined();
		expect(screen.getByText("executing")).toBeDefined();
	});

	it("renders full task text", async () => {
		mockJobRows = [
			makeJob({ task: "This is a very long task description that should be shown in full" }),
		];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		expect(
			screen.getByText("This is a very long task description that should be shown in full"),
		).toBeDefined();
	});

	it("renders repository, branches, and parameters", async () => {
		mockJobRows = [makeJob()];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		expect(screen.getByText("https://github.com/org/repo.git")).toBeDefined();
		expect(screen.getByText("main")).toBeDefined();
		expect(screen.getByText("dobby/fix-bug")).toBeDefined();
	});

	it("renders timestamps and cost", async () => {
		mockJobRows = [
			makeJob({
				costFlops: "25.00",
				submittedAt: new Date("2026-03-20T10:00:00Z"),
				startedAt: new Date("2026-03-20T10:01:00Z"),
				finishedAt: new Date("2026-03-20T10:31:00Z"),
			}),
		];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		expect(screen.getByText("2026-03-20 10:00")).toBeDefined();
		expect(screen.getByText("2026-03-20 10:01")).toBeDefined();
		expect(screen.getByText("2026-03-20 10:31")).toBeDefined();
		expect(screen.getByText("25.00")).toBeDefined();
	});

	it("renders resume count", async () => {
		mockJobRows = [makeJob({ resumeCount: 3 })];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		expect(screen.getByText("3")).toBeDefined();
	});

	it("renders PR URL as link when present", async () => {
		mockJobRows = [makeJob({ prUrl: "https://github.com/org/repo/pull/42" })];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		const prLink = screen.getByText("https://github.com/org/repo/pull/42");
		expect(prLink.closest("a")?.getAttribute("href")).toBe("https://github.com/org/repo/pull/42");
	});

	it("renders existing PR URL when present", async () => {
		mockJobRows = [makeJob({ existingPrUrl: "https://github.com/org/repo/pull/10" })];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		expect(screen.getByText("https://github.com/org/repo/pull/10")).toBeDefined();
	});

	it("shows stop button for active jobs", async () => {
		mockJobRows = [makeJob({ status: "executing" })];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		expect(screen.getByTestId("stop-button")).toBeDefined();
	});

	it("does not show stop button for completed jobs", async () => {
		mockJobRows = [makeJob({ status: "completed" })];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		expect(screen.queryByTestId("stop-button")).toBeNull();
	});

	it("renders log viewer when logStreamName is present", async () => {
		mockJobRows = [makeJob({ logStreamName: "ecs/dobby-runner/abc" })];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		const logViewer = screen.getByTestId("log-viewer");
		expect(logViewer).toBeDefined();
		expect(logViewer.getAttribute("data-job-id")).toBe("db_detail1");
	});

	it("does not render log viewer when logStreamName is null", async () => {
		mockJobRows = [makeJob({ logStreamName: null })];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		expect(screen.queryByTestId("log-viewer")).toBeNull();
	});

	it("passes isTerminal=true for completed jobs", async () => {
		mockJobRows = [makeJob({ status: "completed", logStreamName: "ecs/dobby-runner/abc" })];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		expect(screen.getByTestId("log-viewer").getAttribute("data-terminal")).toBe("true");
	});

	it("passes isTerminal=false for active jobs", async () => {
		mockJobRows = [makeJob({ status: "executing", logStreamName: "ecs/dobby-runner/abc" })];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		expect(screen.getByTestId("log-viewer").getAttribute("data-terminal")).toBe("false");
	});

	it("renders back link to jobs list", async () => {
		mockJobRows = [makeJob()];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		const backLink = screen.getByText(/Back to jobs/);
		expect(backLink.closest("a")?.getAttribute("href")).toBe("/admin/jobs");
	});

	it("shows dash for cost when costFlops is null", async () => {
		mockJobRows = [makeJob({ costFlops: null, startedAt: null })];
		const element = await AdminJobDetailPage({
			params: Promise.resolve({ id: "db_detail1" }),
		});
		render(element);

		const dashes = screen.getAllByText("-");
		expect(dashes.length).toBeGreaterThan(0);
	});
});
