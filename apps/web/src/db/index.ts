import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { getEnv } from "../lib/env";
import * as schema from "./schema";

function createDb() {
	const { DATABASE_URL } = getEnv();
	const sql = neon(DATABASE_URL);
	return drizzle({ client: sql, schema });
}

const globalForDb = globalThis as unknown as { _db: ReturnType<typeof createDb> | undefined };

export function getDb() {
	if (!globalForDb._db) {
		globalForDb._db = createDb();
	}
	return globalForDb._db;
}

export type Database = ReturnType<typeof getDb>;
