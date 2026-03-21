import { z } from "zod/v4";

const envSchema = z.object({
	// Required
	DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

	// Optional — app works without these
	SESSION_SECRET: z.string().optional(),
	NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
	SENTRY_AUTH_TOKEN: z.string().optional(),
	NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
	NEXT_PUBLIC_POSTHOG_HOST: z.string().optional(),
	TURBO_TOKEN: z.string().optional(),
	TURBO_TEAM: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function getEnv(): Env {
	if (_env) return _env;

	const result = envSchema.safeParse(process.env);

	if (!result.success) {
		const formatted = z.prettifyError(result.error);
		throw new Error(`Environment validation failed:\n${formatted}`);
	}

	_env = result.data;
	return _env;
}
