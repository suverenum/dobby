/** All possible job statuses */
export const JOB_STATUSES = [
	"pending",
	"provisioning",
	"cloning",
	"executing",
	"finalizing",
	"completed",
	"failed",
	"interrupted",
	"timed_out",
	"stopped",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses that indicate a job is actively running (consuming resources) */
export const ACTIVE_STATUSES: readonly JobStatus[] = [
	"provisioning",
	"cloning",
	"executing",
	"finalizing",
] as const;

/** Statuses that indicate a job has reached a terminal state */
export const TERMINAL_STATUSES: readonly JobStatus[] = [
	"completed",
	"failed",
	"timed_out",
	"stopped",
] as const;

/**
 * Valid status transitions. Each key maps to the set of statuses it can transition to.
 */
const VALID_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
	pending: ["provisioning", "failed", "stopped"],
	provisioning: ["cloning", "failed", "interrupted", "stopped", "timed_out"],
	cloning: ["executing", "failed", "interrupted", "stopped", "timed_out"],
	executing: ["finalizing", "failed", "interrupted", "timed_out", "stopped"],
	finalizing: ["completed", "failed", "stopped", "timed_out"],
	completed: [],
	failed: [],
	interrupted: ["provisioning", "failed", "stopped"],
	timed_out: [],
	stopped: [],
};

/**
 * Check whether a transition from `from` to `to` is valid.
 */
export function isValidTransition(from: JobStatus, to: JobStatus): boolean {
	return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Validate and return the target status, or throw if the transition is invalid.
 */
export function validateTransition(from: JobStatus, to: JobStatus): JobStatus {
	if (!isValidTransition(from, to)) {
		throw new Error(`Invalid status transition: ${from} → ${to}`);
	}
	return to;
}

/**
 * Returns whether the given status is a terminal status.
 */
export function isTerminalStatus(status: JobStatus): boolean {
	return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Returns whether the given status is an active (running) status.
 */
export function isActiveStatus(status: JobStatus): boolean {
	return (ACTIVE_STATUSES as readonly string[]).includes(status);
}
