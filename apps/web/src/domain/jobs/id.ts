import { nanoid } from "nanoid";

const JOB_ID_PREFIX = "db_";
const NANOID_LENGTH = 21;

/**
 * Generate a unique job ID with the `db_` prefix.
 * Example: `db_V1StGXR8_Z5jdHi6B-myT`
 */
export function generateJobId(): string {
	return `${JOB_ID_PREFIX}${nanoid(NANOID_LENGTH)}`;
}

/**
 * Check whether a string looks like a valid job ID.
 */
export function isValidJobId(id: string): boolean {
	return id.startsWith(JOB_ID_PREFIX) && id.length === JOB_ID_PREFIX.length + NANOID_LENGTH;
}
