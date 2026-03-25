/**
 * Calculate the job cost in FLOPS based on duration.
 *
 * Formula: ceil(duration_minutes) * (hourlyRate / 60)
 * Capped at: hourlyRate * maxJobHours
 *
 * @param durationMs - Job duration in milliseconds
 * @param hourlyRate - Cost per hour in FLOPS (DOBBY_HOURLY_RATE)
 * @param maxJobHours - Maximum billable hours (DOBBY_MAX_JOB_HOURS)
 * @returns Cost in FLOPS
 */
export function calculateJobCost(
	durationMs: number,
	hourlyRate: number,
	maxJobHours: number,
): number {
	if (durationMs <= 0) return 0;

	const durationMinutes = Math.ceil(durationMs / 60_000);
	const perMinuteRate = hourlyRate / 60;
	const cost = durationMinutes * perMinuteRate;
	const maxCost = hourlyRate * maxJobHours;

	return Math.min(cost, maxCost);
}

/**
 * Calculate the maximum budget that must be preauthorized for a job.
 *
 * @param hourlyRate - Cost per hour in FLOPS (DOBBY_HOURLY_RATE)
 * @param maxJobHours - Maximum billable hours (DOBBY_MAX_JOB_HOURS)
 * @returns Maximum budget in FLOPS
 */
export function calculateMaxBudget(hourlyRate: number, maxJobHours: number): number {
	return hourlyRate * maxJobHours;
}
