import { getEnv } from "./env";

export interface TelegramNotificationJob {
	id: string;
	task: string;
	repository: string;
	prUrl: string | null;
	startedAt: Date | null;
	finishedAt: Date | null;
	costFlops: string | null;
	resumeCount: number | null;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

/**
 * Extract the first 2 lines of a task description, truncated to 100 chars per line.
 */
export function truncateTask(task: string): string {
	const lines = task.split("\n").filter((l) => l.trim().length > 0);
	const first2: string[] = lines
		.slice(0, 2)
		.map((line) => (line.length > 100 ? `${line.slice(0, 97)}...` : line));
	return first2.join("\n");
}

/**
 * Extract short repo name from full URL or org/repo format.
 */
function shortRepo(repository: string): string {
	// Handle URLs like https://github.com/org/repo.git
	const match = repository.match(/([^/]+\/[^/]+?)(?:\.git)?$/);
	return match?.[1] ?? repository;
}

const STATUS_HEADER: Record<string, string> = {
	completed: "Job done",
	failed: "Job failed",
	timed_out: "Job timed out",
	stopped: "Job stopped",
	interrupted: "Job interrupted, resuming...",
	provisioning: "New job started",
};

const STATUS_EMOJI: Record<string, string> = {
	completed: "✅",
	failed: "❌",
	timed_out: "⏰",
	stopped: "🛑",
	interrupted: "⚡",
	provisioning: "🚀",
};

/**
 * Format a Telegram notification message for a job status change.
 */
export function formatNotificationMessage(job: TelegramNotificationJob, newStatus: string): string {
	const emoji = STATUS_EMOJI[newStatus] || "ℹ️";
	const header = STATUS_HEADER[newStatus] || newStatus;
	const lines: string[] = [];

	// Bold header with optional duration
	let headerLine = `${emoji} <b>${header}`;
	if (job.startedAt && job.finishedAt) {
		const duration = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
		headerLine += ` — ${formatDuration(duration)}`;
	}
	headerLine += "</b>";
	lines.push(headerLine);

	// Repo and job ID (job ID links to dashboard)
	const env = getEnv();
	const baseUrl = env.DOBBY_CALLBACK_URL;
	const jobRef = baseUrl ? `<a href="${baseUrl}/admin/jobs/${job.id}">${job.id}</a>` : job.id;
	lines.push(`${shortRepo(job.repository)} · ${jobRef}`);

	lines.push(truncateTask(job.task));

	if (job.prUrl) {
		lines.push(`PR: ${job.prUrl}`);
	}

	return lines.join("\n");
}

/**
 * Send a Telegram notification for a job status change.
 * Silently skips if DOBBY_TELEGRAM_BOT_TOKEN or DOBBY_TELEGRAM_CHAT_ID are not set.
 */
export async function sendNotification(
	job: TelegramNotificationJob,
	newStatus: string,
): Promise<void> {
	const env = getEnv();
	const botToken = env.DOBBY_TELEGRAM_BOT_TOKEN;
	const chatId = env.DOBBY_TELEGRAM_CHAT_ID;

	if (!botToken || !chatId) {
		return;
	}

	const text = formatNotificationMessage(job, newStatus);
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: chatId,
				text,
				parse_mode: "HTML",
				disable_web_page_preview: true,
			}),
		});

		if (!response.ok) {
			console.error(`Telegram notification failed: ${response.status} ${response.statusText}`);
		}
	} catch (error) {
		console.error("Telegram notification error:", error);
	}
}
