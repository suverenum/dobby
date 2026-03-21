import { Card, Tag } from "@suverenum/ui";
import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "../../../db";
import { jobs } from "../../../db/schema";
import { ACTIVE_STATUSES, JOB_STATUSES, type JobStatus } from "../../../domain/jobs";
import { requireAdminSession } from "../../../lib/session";
import { STATUS_COLOR_MAP } from "./constants";
import { JobStatusFilter } from "./status-filter";

export type StatusFilter = "all" | "active" | JobStatus;

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "active", label: "Active" },
	...JOB_STATUSES.map((s) => ({ value: s as StatusFilter, label: s.replace("_", " ") })),
];

function shortRepo(repository: string): string {
	return repository.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}

function truncateTask(task: string, maxLen = 80): string {
	if (task.length <= maxLen) return task;
	return `${task.slice(0, maxLen)}...`;
}

function formatDuration(startedAt: Date | null, finishedAt: Date | null): string {
	if (!startedAt) return "-";
	const end = finishedAt ?? new Date();
	const diffMs = end.getTime() - startedAt.getTime();
	const mins = Math.floor(diffMs / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ${mins % 60}m`;
}

function formatCost(costFlops: string | null): string {
	if (!costFlops) return "-";
	const n = Number(costFlops);
	return n.toFixed(2);
}

function formatTime(date: Date | null): string {
	if (!date) return "-";
	return date.toISOString().replace("T", " ").slice(0, 16);
}

interface Props {
	searchParams: Promise<{ status?: string }>;
}

export default async function AdminJobsPage({ searchParams }: Props) {
	await requireAdminSession();

	const params = await searchParams;
	const filter: StatusFilter =
		params.status &&
		(params.status === "all" ||
			params.status === "active" ||
			JOB_STATUSES.includes(params.status as JobStatus))
			? (params.status as StatusFilter)
			: "all";

	const db = getDb();

	const jobRows =
		filter === "all"
			? await db.select().from(jobs).orderBy(desc(jobs.submittedAt))
			: filter === "active"
				? await db
						.select()
						.from(jobs)
						.where(inArray(jobs.status, [...ACTIVE_STATUSES]))
						.orderBy(desc(jobs.submittedAt))
				: await db
						.select()
						.from(jobs)
						.where(eq(jobs.status, filter))
						.orderBy(desc(jobs.submittedAt));

	return (
		<div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
			<div className="mb-6 flex items-center justify-between">
				<h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Jobs</h1>
			</div>

			<div className="mb-4">
				<JobStatusFilter options={FILTER_OPTIONS} current={filter} />
			</div>

			<Card padding="none">
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead>
							<tr className="border-b border-zinc-200 dark:border-zinc-700">
								<th className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">ID</th>
								<th className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
									Repository
								</th>
								<th className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">Task</th>
								<th className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">Status</th>
								<th className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
									Submitted
								</th>
								<th className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">Duration</th>
								<th className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">Cost</th>
							</tr>
						</thead>
						<tbody>
							{jobRows.length === 0 ? (
								<tr>
									<td
										colSpan={7}
										className="px-4 py-8 text-center text-zinc-400 dark:text-zinc-500"
									>
										No jobs found.
									</td>
								</tr>
							) : (
								jobRows.map((job) => (
									<tr
										key={job.id}
										className="border-b border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50"
									>
										<td className="px-4 py-3">
											<Link
												href={`/admin/jobs/${job.id}`}
												className="font-mono text-xs text-emerald-600 hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300"
											>
												{job.id}
											</Link>
										</td>
										<td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
											{shortRepo(job.repository)}
										</td>
										<td className="max-w-xs px-4 py-3 text-zinc-600 dark:text-zinc-400">
											{truncateTask(job.task)}
										</td>
										<td className="px-4 py-3">
											<Tag
												color={STATUS_COLOR_MAP[job.status as JobStatus] ?? "zinc"}
												variant="medium"
											>
												{job.status}
											</Tag>
										</td>
										<td className="whitespace-nowrap px-4 py-3 text-zinc-500 dark:text-zinc-400">
											{formatTime(job.submittedAt)}
										</td>
										<td className="whitespace-nowrap px-4 py-3 text-zinc-500 dark:text-zinc-400">
											{formatDuration(job.startedAt, job.finishedAt)}
										</td>
										<td className="whitespace-nowrap px-4 py-3 font-mono text-zinc-500 dark:text-zinc-400">
											{formatCost(job.costFlops)}
										</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</Card>
		</div>
	);
}
