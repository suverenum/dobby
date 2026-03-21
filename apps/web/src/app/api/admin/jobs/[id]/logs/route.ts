import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../../db";
import { jobs } from "../../../../../../db/schema";
import { isActiveStatus, isTerminalStatus, type JobStatus } from "../../../../../../domain/jobs";
import { getEnv } from "../../../../../../lib/env";
import { validateAdminSession } from "../../../../../../lib/session";

let _cwClient: CloudWatchLogsClient | undefined;

function getCWClient(): CloudWatchLogsClient {
	if (_cwClient) return _cwClient;
	const env = getEnv();
	_cwClient = new CloudWatchLogsClient({
		region: env.AWS_REGION,
		...(env.AWS_ACCESS_KEY_ID &&
			env.AWS_SECRET_ACCESS_KEY && {
				credentials: {
					accessKeyId: env.AWS_ACCESS_KEY_ID,
					secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
				},
			}),
	});
	return _cwClient;
}

/** Reset cached client (for testing) */
export function _resetCWClient(): void {
	_cwClient = undefined;
}

const LOG_GROUP_PREFIX = "/ecs/dobby-runner";
const POLL_INTERVAL_MS = 2000;
const MAX_STREAM_DURATION_MS = 55_000; // Stop before Vercel's 60s function timeout

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	const valid = await validateAdminSession();
	if (!valid) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id } = await params;
	const db = getDb();

	const rows = await db.select().from(jobs).where(eq(jobs.id, id));
	const job = rows[0];
	if (!job) {
		return NextResponse.json({ error: "Job not found" }, { status: 404 });
	}

	if (!job.logStreamName) {
		return NextResponse.json({ error: "No log stream available" }, { status: 404 });
	}

	const isTerminal = isTerminalStatus(job.status as JobStatus);
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const client = getCWClient();
			let nextToken: string | undefined;
			let streaming = true;
			const streamStart = Date.now();

			try {
				// For terminal jobs, fetch all logs at once
				// For active jobs, poll with SSE
				while (streaming) {
					const command = new GetLogEventsCommand({
						logGroupName: LOG_GROUP_PREFIX,
						logStreamName: job.logStreamName!,
						startFromHead: true,
						...(nextToken && { nextToken }),
					});

					const response = await client.send(command);
					const events = response.events ?? [];

					for (const event of events) {
						const data = JSON.stringify({
							timestamp: event.timestamp,
							message: event.message,
						});
						controller.enqueue(encoder.encode(`data: ${data}\n\n`));
					}

					// If terminal, just send all logs and close
					if (isTerminal) {
						// Check if there are more pages
						if (
							response.nextForwardToken &&
							response.nextForwardToken !== nextToken &&
							events.length > 0
						) {
							nextToken = response.nextForwardToken;
							continue;
						}
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
						streaming = false;
						break;
					}

					nextToken = response.nextForwardToken;

					// For active jobs, poll every 2 seconds
					await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

					// Stop if max stream duration exceeded
					if (Date.now() - streamStart > MAX_STREAM_DURATION_MS) {
						controller.enqueue(encoder.encode("data: [RECONNECT]\n\n"));
						controller.close();
						streaming = false;
						break;
					}

					// Re-check job status
					const freshRows = await db.select().from(jobs).where(eq(jobs.id, id));
					const freshJob = freshRows[0];
					if (
						!freshJob ||
						isTerminalStatus(freshJob.status as JobStatus) ||
						!isActiveStatus(freshJob.status as JobStatus)
					) {
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
						streaming = false;
					}
				}
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : "Unknown error";
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: errorMsg })}\n\n`));
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
