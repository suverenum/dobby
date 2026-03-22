"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "../../../components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import type { StatusFilter } from "./page";

interface Props {
	options: { value: StatusFilter; label: string }[];
	current: StatusFilter;
	counts: Record<StatusFilter, number>;
}

export function JobStatusFilter({ options, current, counts }: Props) {
	const router = useRouter();
	const searchParams = useSearchParams();

	function handleChange(value: string) {
		const params = new URLSearchParams(searchParams.toString());
		if (value === "active") {
			params.delete("status");
		} else {
			params.set("status", value);
		}
		router.push(`/admin/jobs?${params.toString()}`);
	}

	return (
		<Tabs value={current} onValueChange={handleChange}>
			<TabsList className="**:data-[slot=badge]:size-5 **:data-[slot=badge]:rounded-full **:data-[slot=badge]:bg-muted-foreground/30 **:data-[slot=badge]:px-1">
				{options.map((opt) => (
					<TabsTrigger key={opt.value} value={opt.value}>
						{opt.label}
						{counts[opt.value] > 0 && <Badge variant="secondary">{counts[opt.value]}</Badge>}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}
