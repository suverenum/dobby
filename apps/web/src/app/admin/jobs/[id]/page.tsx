import { Card, Tag } from "@suverenum/ui";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import { isActiveStatus, type JobStatus } from "../../../../domain/jobs";
import { requireAdminSession } from "../../../../lib/session";
import { STATUS_COLOR_MAP } from "../constants";
import { LogViewer } from "./log-viewer";
import { StopButton } from "./stop-button";

function formatTime(date: Date | null): string {
	if (!date) return "-";
	return date.toISOString().replace("T", " ").slice(0, 16);
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
	return Number(costFlops).toFixed(2);
}

interface Props {
	params: Promise<{ id: string }>;
}

export default async function AdminJobDetailPage({ params }: Props) {
	await requireAdminSession();

	const { id } = await params;
	const db = getDb();

	const rows = await db
		.select({
			id: jobs.id,
			status: jobs.status,
			repository: jobs.repository,
			baseBranch: jobs.baseBranch,
			workingBranch: jobs.workingBranch,
			task: jobs.task,
			existingPrUrl: jobs.existingPrUrl,
			prUrl: jobs.prUrl,
			ecsTaskArn: jobs.ecsTaskArn,
			logStreamName: jobs.logStreamName,
			authorizedFlops: jobs.authorizedFlops,
			costFlops: jobs.costFlops,
			submittedAt: jobs.submittedAt,
			startedAt: jobs.startedAt,
			finishedAt: jobs.finishedAt,
			resumeCount: jobs.resumeCount,
		})
		.from(jobs)
		.where(eq(jobs.id, id));
	const job = rows[0];
	if (!job) {
		notFound();
	}

	const status = job.status as JobStatus;
	const active = isActiveStatus(status);
	const isTerminal = !active && status !== "pending" && status !== "interrupted";

	return (
		<div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
			<div className="mb-6">
				<Link
					href="/admin/jobs"
					className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
				>
					&larr; Back to jobs
				</Link>
			</div>

			<div className="mb-6 flex items-center justify-between">
				<div className="flex items-center gap-3">
					<h1 className="font-mono text-xl font-semibold text-zinc-900 dark:text-zinc-100">
						{job.id}
					</h1>
					<Tag color={STATUS_COLOR_MAP[job.status as JobStatus] ?? "zinc"} variant="medium">
						{job.status}
					</Tag>
				</div>
				{(active || status === "pending" || status === "interrupted") && (
					<StopButton jobId={job.id} />
				)}
			</div>

			<div className="grid gap-6">
				{/* Task */}
				<Card>
					<div className="space-y-2">
						<h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Task</h2>
						<p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">
							{job.task}
						</p>
					</div>
				</Card>

				{/* Parameters */}
				<Card>
					<div className="space-y-3">
						<h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Parameters</h2>
						<dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
							<dt className="text-zinc-500 dark:text-zinc-400">Repository</dt>
							<dd className="text-zinc-800 dark:text-zinc-200">{job.repository}</dd>

							<dt className="text-zinc-500 dark:text-zinc-400">Base Branch</dt>
							<dd className="text-zinc-800 dark:text-zinc-200">{job.baseBranch}</dd>

							<dt className="text-zinc-500 dark:text-zinc-400">Working Branch</dt>
							<dd className="text-zinc-800 dark:text-zinc-200">{job.workingBranch}</dd>

							{job.existingPrUrl && (
								<>
									<dt className="text-zinc-500 dark:text-zinc-400">Existing PR</dt>
									<dd>
										<a
											href={job.existingPrUrl}
											target="_blank"
											rel="noopener noreferrer"
											className="text-emerald-600 hover:text-emerald-500 dark:text-emerald-400"
										>
											{job.existingPrUrl}
										</a>
									</dd>
								</>
							)}

							{job.prUrl && (
								<>
									<dt className="text-zinc-500 dark:text-zinc-400">PR URL</dt>
									<dd>
										<a
											href={job.prUrl}
											target="_blank"
											rel="noopener noreferrer"
											className="text-emerald-600 hover:text-emerald-500 dark:text-emerald-400"
										>
											{job.prUrl}
										</a>
									</dd>
								</>
							)}
						</dl>
					</div>
				</Card>

				{/* Timing & Cost */}
				<Card>
					<div className="space-y-3">
						<h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
							Timing &amp; Cost
						</h2>
						<dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
							<dt className="text-zinc-500 dark:text-zinc-400">Submitted</dt>
							<dd className="text-zinc-800 dark:text-zinc-200">{formatTime(job.submittedAt)}</dd>

							<dt className="text-zinc-500 dark:text-zinc-400">Started</dt>
							<dd className="text-zinc-800 dark:text-zinc-200">{formatTime(job.startedAt)}</dd>

							<dt className="text-zinc-500 dark:text-zinc-400">Finished</dt>
							<dd className="text-zinc-800 dark:text-zinc-200">{formatTime(job.finishedAt)}</dd>

							<dt className="text-zinc-500 dark:text-zinc-400">Duration</dt>
							<dd className="text-zinc-800 dark:text-zinc-200">
								{formatDuration(job.startedAt, job.finishedAt)}
							</dd>

							<dt className="text-zinc-500 dark:text-zinc-400">Cost (FLOPS)</dt>
							<dd className="font-mono text-zinc-800 dark:text-zinc-200">
								{formatCost(job.costFlops)}
							</dd>

							<dt className="text-zinc-500 dark:text-zinc-400">Resume Count</dt>
							<dd className="text-zinc-800 dark:text-zinc-200">{job.resumeCount ?? 0}</dd>
						</dl>
					</div>
				</Card>

				{/* Logs */}
				{job.logStreamName && (
					<Card>
						<LogViewer jobId={job.id} isTerminal={isTerminal} />
					</Card>
				)}
			</div>
		</div>
	);
}
