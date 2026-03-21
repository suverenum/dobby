import type { JobStatus } from "../../../domain/jobs";

export const STATUS_COLOR_MAP: Record<JobStatus, "emerald" | "sky" | "amber" | "rose" | "zinc"> = {
	pending: "zinc",
	provisioning: "sky",
	cloning: "sky",
	executing: "amber",
	finalizing: "amber",
	completed: "emerald",
	failed: "rose",
	interrupted: "amber",
	timed_out: "rose",
	stopped: "zinc",
};
