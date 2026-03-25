/**
 * Calculate the maximum number of concurrent jobs allowed.
 *
 * Formula: floor(accountVcpuLimit / vmCpu)
 *
 * @param accountVcpuLimit - Total vCPU quota (DOBBY_ACCOUNT_VCPU_LIMIT)
 * @param vmCpu - vCPUs per runner (DOBBY_VM_CPU)
 * @returns Maximum concurrent job slots
 */
export function calculateMaxConcurrentJobs(accountVcpuLimit: number, vmCpu: number): number {
	return Math.floor(accountVcpuLimit / vmCpu);
}

/**
 * Check whether there is capacity to run another job.
 *
 * @param activeJobCount - Number of currently active jobs
 * @param accountVcpuLimit - Total vCPU quota (DOBBY_ACCOUNT_VCPU_LIMIT)
 * @param vmCpu - vCPUs per runner (DOBBY_VM_CPU)
 * @returns true if there is at least one free slot
 */
export function hasCapacity(
	activeJobCount: number,
	accountVcpuLimit: number,
	vmCpu: number,
): boolean {
	return activeJobCount < calculateMaxConcurrentJobs(accountVcpuLimit, vmCpu);
}
