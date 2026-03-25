import { count, desc, inArray } from "drizzle-orm";
import Link from "next/link";
import { Badge } from "../../../components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../../../components/ui/table";
import { getDb } from "../../../db";
import { jobs } from "../../../db/schema";
import { ACTIVE_STATUSES, type JobStatus, TERMINAL_STATUSES } from "../../../domain/jobs";
import { requireAdminSession } from "../../../lib/session";
import { STATUS_VARIANT_MAP } from "./constants";
import { JobStatusFilter } from "./status-filter";

export type StatusFilter = "active" | "completed" | "all";

const NON_TERMINAL_STATUSES: JobStatus[] = [
	"pending",
	...ACTIVE_STATUSES,
	"interrupted",
] as JobStatus[];

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
	{ value: "active", label: "Active" },
	{ value: "completed", label: "Completed" },
	{ value: "all", label: "All" },
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
	return Number(costFlops).toFixed(2);
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
		(params.status === "all" || params.status === "completed" || params.status === "active")
			? (params.status as StatusFilter)
			: "active";

	const db = getDb();

	const columns = {
		id: jobs.id,
		status: jobs.status,
		repository: jobs.repository,
		task: jobs.task,
		submittedAt: jobs.submittedAt,
		startedAt: jobs.startedAt,
		finishedAt: jobs.finishedAt,
		costFlops: jobs.costFlops,
	};

	const [activeCountResult, completedCountResult, totalCountResult] = await Promise.all([
		db.select({ value: count() }).from(jobs).where(inArray(jobs.status, NON_TERMINAL_STATUSES)),
		db
			.select({ value: count() })
			.from(jobs)
			.where(inArray(jobs.status, [...TERMINAL_STATUSES])),
		db.select({ value: count() }).from(jobs),
	]);
	const counts: Record<StatusFilter, number> = {
		active: activeCountResult[0]?.value ?? 0,
		completed: completedCountResult[0]?.value ?? 0,
		all: totalCountResult[0]?.value ?? 0,
	};

	const jobRows =
		filter === "all"
			? await db.select(columns).from(jobs).orderBy(desc(jobs.submittedAt))
			: filter === "active"
				? await db
						.select(columns)
						.from(jobs)
						.where(inArray(jobs.status, NON_TERMINAL_STATUSES))
						.orderBy(desc(jobs.submittedAt))
				: await db
						.select(columns)
						.from(jobs)
						.where(inArray(jobs.status, [...TERMINAL_STATUSES]))
						.orderBy(desc(jobs.submittedAt));

	return (
		<div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
			<div className="px-4 lg:px-6">
				<JobStatusFilter options={FILTER_OPTIONS} current={filter} counts={counts} />
			</div>
			<div className="relative flex flex-col gap-4 overflow-auto px-4 lg:px-6">
				<div className="overflow-hidden rounded-lg border">
					<Table>
						<TableHeader className="bg-muted">
							<TableRow>
								<TableHead>ID</TableHead>
								<TableHead>Repository</TableHead>
								<TableHead>Task</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Submitted</TableHead>
								<TableHead>Duration</TableHead>
								<TableHead>Cost</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{jobRows.length === 0 ? (
								<TableRow>
									<TableCell colSpan={7} className="h-24 text-center">
										No results.
									</TableCell>
								</TableRow>
							) : (
								jobRows.map((job) => (
									<TableRow key={job.id}>
										<TableCell>
											<Link
												href={`/admin/jobs/${job.id}`}
												className="font-mono text-xs underline-offset-4 hover:underline"
											>
												{job.id}
											</Link>
										</TableCell>
										<TableCell>{shortRepo(job.repository)}</TableCell>
										<TableCell className="max-w-xs">{truncateTask(job.task)}</TableCell>
										<TableCell>
											<Badge
												variant={STATUS_VARIANT_MAP[job.status as JobStatus] ?? "outline"}
												className="text-muted-foreground px-1.5"
											>
												{job.status}
											</Badge>
										</TableCell>
										<TableCell className="whitespace-nowrap">
											{formatTime(job.submittedAt)}
										</TableCell>
										<TableCell className="whitespace-nowrap">
											{formatDuration(job.startedAt, job.finishedAt)}
										</TableCell>
										<TableCell className="whitespace-nowrap font-mono">
											{formatCost(job.costFlops)}
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</div>
			</div>
		</div>
	);
}
