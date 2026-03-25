import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "../../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { getDb } from "../../../../db";
import { jobs } from "../../../../db/schema";
import { isActiveStatus, type JobStatus } from "../../../../domain/jobs";
import { formatCostUsd, formatTokenCount } from "../../../../domain/jobs/cost";
import { requireAdminSession } from "../../../../lib/session";
import { STATUS_VARIANT_MAP } from "../constants";
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
			inputTokens: jobs.inputTokens,
			outputTokens: jobs.outputTokens,
			cacheReadTokens: jobs.cacheReadTokens,
			cacheWriteTokens: jobs.cacheWriteTokens,
			bedrockCostUsd: jobs.bedrockCostUsd,
			containerCostUsd: jobs.containerCostUsd,
			costUsd: jobs.costUsd,
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
		<div className="space-y-6">
			<div>
				<Link href="/admin/jobs" className="text-muted-foreground hover:text-foreground text-sm">
					&larr; Back to jobs
				</Link>
			</div>

			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<h1 className="font-mono text-lg font-semibold md:text-xl">{job.id}</h1>
					<Badge variant={STATUS_VARIANT_MAP[status] ?? "outline"}>{job.status}</Badge>
				</div>
				{(active || status === "pending" || status === "interrupted") && (
					<StopButton jobId={job.id} />
				)}
			</div>

			<div className="grid gap-4">
				<Card>
					<CardHeader>
						<CardTitle>Task</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-muted-foreground whitespace-pre-wrap text-sm">{job.task}</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Parameters</CardTitle>
					</CardHeader>
					<CardContent>
						<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
							<dt className="text-muted-foreground">Repository</dt>
							<dd>{job.repository}</dd>

							<dt className="text-muted-foreground">Base Branch</dt>
							<dd>{job.baseBranch}</dd>

							<dt className="text-muted-foreground">Working Branch</dt>
							<dd>{job.workingBranch}</dd>

							{job.existingPrUrl && (
								<>
									<dt className="text-muted-foreground">Existing PR</dt>
									<dd>
										<a
											href={job.existingPrUrl}
											target="_blank"
											rel="noopener noreferrer"
											className="hover:text-primary underline underline-offset-4"
										>
											{job.existingPrUrl}
										</a>
									</dd>
								</>
							)}

							{job.prUrl && (
								<>
									<dt className="text-muted-foreground">PR URL</dt>
									<dd>
										<a
											href={job.prUrl}
											target="_blank"
											rel="noopener noreferrer"
											className="hover:text-primary underline underline-offset-4"
										>
											{job.prUrl}
										</a>
									</dd>
								</>
							)}
						</dl>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Timing &amp; Cost</CardTitle>
					</CardHeader>
					<CardContent>
						<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
							<dt className="text-muted-foreground">Submitted</dt>
							<dd>{formatTime(job.submittedAt)}</dd>

							<dt className="text-muted-foreground">Started</dt>
							<dd>{formatTime(job.startedAt)}</dd>

							<dt className="text-muted-foreground">Finished</dt>
							<dd>{formatTime(job.finishedAt)}</dd>

							<dt className="text-muted-foreground">Duration</dt>
							<dd>{formatDuration(job.startedAt, job.finishedAt)}</dd>

							<dt className="text-muted-foreground">Input Tokens</dt>
							<dd className="font-mono">
								{job.inputTokens != null ? formatTokenCount(job.inputTokens) : "-"}
							</dd>

							<dt className="text-muted-foreground">Output Tokens</dt>
							<dd className="font-mono">
								{job.outputTokens != null ? formatTokenCount(job.outputTokens) : "-"}
							</dd>

							<dt className="text-muted-foreground">Cache Read Tokens</dt>
							<dd className="font-mono">
								{job.cacheReadTokens != null ? formatTokenCount(job.cacheReadTokens) : "-"}
							</dd>

							<dt className="text-muted-foreground">Cache Write Tokens</dt>
							<dd className="font-mono">
								{job.cacheWriteTokens != null ? formatTokenCount(job.cacheWriteTokens) : "-"}
							</dd>

							<dt className="text-muted-foreground">Bedrock Cost</dt>
							<dd className="font-mono">
								{job.bedrockCostUsd != null ? formatCostUsd(Number(job.bedrockCostUsd)) : "-"}
							</dd>

							<dt className="text-muted-foreground">Container Cost</dt>
							<dd className="font-mono">
								{job.containerCostUsd != null ? formatCostUsd(Number(job.containerCostUsd)) : "-"}
							</dd>

							<dt className="text-muted-foreground font-semibold">Total Cost</dt>
							<dd className="font-mono font-semibold">
								{job.costUsd != null ? formatCostUsd(Number(job.costUsd)) : "-"}
							</dd>

							<dt className="text-muted-foreground">Resume Count</dt>
							<dd>{job.resumeCount ?? 0}</dd>
						</dl>
					</CardContent>
				</Card>

				{job.logStreamName && (
					<Card>
						<CardHeader>
							<CardTitle>Logs</CardTitle>
						</CardHeader>
						<CardContent>
							<LogViewer jobId={job.id} isTerminal={isTerminal} />
						</CardContent>
					</Card>
				)}
			</div>
		</div>
	);
}
