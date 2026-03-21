"use client";

import { Button } from "@suverenum/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface StopButtonProps {
	jobId: string;
}

export function StopButton({ jobId }: StopButtonProps) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const router = useRouter();

	async function handleStop() {
		if (!confirm("Are you sure you want to stop this job?")) return;

		setLoading(true);
		setError(null);

		try {
			const res = await fetch(`/api/admin/jobs/${jobId}/stop`, {
				method: "POST",
			});

			if (!res.ok) {
				const data = await res.json();
				setError(data.error ?? "Failed to stop job");
				return;
			}

			router.refresh();
		} catch {
			setError("Failed to stop job");
		} finally {
			setLoading(false);
		}
	}

	return (
		<div>
			<Button variant="destructive" size="sm" onClick={handleStop} disabled={loading}>
				{loading ? "Stopping..." : "Stop Job"}
			</Button>
			{error && <p className="mt-1 text-xs text-rose-500">{error}</p>}
		</div>
	);
}
