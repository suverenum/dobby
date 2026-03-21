"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { StatusFilter } from "./page";

interface Props {
	options: { value: StatusFilter; label: string }[];
	current: StatusFilter;
}

export function JobStatusFilter({ options, current }: Props) {
	const router = useRouter();
	const searchParams = useSearchParams();

	function handleChange(value: string) {
		const params = new URLSearchParams(searchParams.toString());
		if (value === "all") {
			params.delete("status");
		} else {
			params.set("status", value);
		}
		router.push(`/admin/jobs?${params.toString()}`);
	}

	return (
		<div className="flex flex-wrap gap-2">
			{options.map((opt) => (
				<button
					key={opt.value}
					type="button"
					onClick={() => handleChange(opt.value)}
					className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
						current === opt.value
							? "bg-emerald-600 text-white"
							: "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
					}`}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}
