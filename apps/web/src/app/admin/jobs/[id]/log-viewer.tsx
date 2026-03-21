"use client";

import { useEffect, useRef, useState } from "react";

interface LogEntry {
	timestamp?: number;
	message?: string;
	error?: string;
}

interface LogViewerProps {
	jobId: string;
	isTerminal: boolean;
}

export function LogViewer({ jobId, isTerminal }: LogViewerProps) {
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [connected, setConnected] = useState(false);
	const [done, setDone] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const abortController = new AbortController();
		let active = true;

		async function connect() {
			try {
				setConnected(true);
				const response = await fetch(`/api/admin/jobs/${jobId}/logs`, {
					signal: abortController.signal,
				});

				if (!response.ok || !response.body) {
					setConnected(false);
					return;
				}

				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				while (active) {
					const { done: readerDone, value } = await reader.read();
					if (readerDone) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						const dataLine = line.trim();
						if (!dataLine.startsWith("data: ")) continue;
						const data = dataLine.slice(6);

						if (data === "[DONE]") {
							setDone(true);
							setConnected(false);
							return;
						}

						if (data === "[RECONNECT]") {
							// Server hit streaming timeout; reconnect to continue
							// Clear existing logs to avoid duplication since server replays from head
							setLogs([]);
							reader.cancel();
							connect();
							return;
						}

						try {
							const entry: LogEntry = JSON.parse(data);
							setLogs((prev) => [...prev, entry]);
						} catch {
							// Skip malformed data
						}
					}
				}
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") return;
				setConnected(false);
			}
		}

		connect();

		return () => {
			active = false;
			abortController.abort();
		};
	}, [jobId]);

	// Auto-scroll to bottom when new logs arrive
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll must trigger when logs change
	useEffect(() => {
		if (containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
		}
	}, [logs.length]);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
				<span>Logs</span>
				{connected && !done && (
					<span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
				)}
				{done && <span className="text-zinc-400 dark:text-zinc-500">(complete)</span>}
			</div>
			<div
				ref={containerRef}
				data-testid="log-container"
				className="max-h-[600px] min-h-[200px] overflow-y-auto rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300"
			>
				{logs.length === 0 && !done && (
					<div className="text-zinc-500">
						{connected ? (isTerminal ? "Loading logs..." : "Waiting for logs...") : "Connecting..."}
					</div>
				)}
				{logs.length === 0 && done && <div className="text-zinc-500">No logs available.</div>}
				{logs.map((entry, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: log entries are append-only, no reordering
					<div key={`${entry.timestamp}-${i}`} className="whitespace-pre-wrap">
						{entry.error ? <span className="text-rose-400">{entry.error}</span> : entry.message}
					</div>
				))}
			</div>
		</div>
	);
}
