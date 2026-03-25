import type { JobStatus } from "../../../domain/jobs";

export const STATUS_VARIANT_MAP: Record<
	JobStatus,
	"default" | "secondary" | "destructive" | "outline"
> = {
	pending: "outline",
	provisioning: "secondary",
	cloning: "secondary",
	executing: "default",
	finalizing: "default",
	completed: "default",
	failed: "destructive",
	interrupted: "secondary",
	timed_out: "destructive",
	stopped: "outline",
};
