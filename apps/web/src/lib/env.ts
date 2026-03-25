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

	// Dobby — Admin
	DOBBY_ADMIN_PASSWORD_HASH: z.string().optional(),
	CRON_SECRET: z.string().optional(),

	// Dobby — Job config
	DOBBY_HOURLY_RATE: z.coerce.number().positive().default(100),
	DOBBY_MAX_JOB_HOURS: z.coerce.number().positive().default(6),
	DOBBY_ACCOUNT_VCPU_LIMIT: z.coerce.number().positive().default(24),
	DOBBY_VM_CPU: z.coerce.number().positive().default(4),
	DOBBY_CONTAINER_IMAGE: z.string().optional(),
	DOBBY_CALLBACK_SECRET: z.string().optional(),
	DOBBY_CALLBACK_URL: z.string().optional(),

	// Dobby — Telegram
	DOBBY_TELEGRAM_BOT_TOKEN: z.string().optional(),
	DOBBY_TELEGRAM_CHAT_ID: z.string().optional(),

	// Dobby — AWS
	AWS_REGION: z.string().default("us-east-1"),
	AWS_ACCESS_KEY_ID: z.string().optional(),
	AWS_SECRET_ACCESS_KEY: z.string().optional(),
	ECS_CLUSTER_ARN: z.string().optional(),
	ECS_TASK_DEFINITION_ARN: z.string().optional(),
	ECS_SUBNETS: z.string().optional(),
	ECS_SECURITY_GROUPS: z.string().optional(),
	KMS_KEY_ID: z.string().optional(),

	// Dobby — LLM (Bedrock via existing AWS credentials)
	BEDROCK_MODEL_ID: z.string().default("us.anthropic.claude-opus-4-6-v1"),

	// Dobby — Bedrock pricing (per 1M tokens, Opus 4 defaults)
	BEDROCK_INPUT_PRICE_PER_1M: z.coerce.number().nonnegative().default(5.0),
	BEDROCK_OUTPUT_PRICE_PER_1M: z.coerce.number().nonnegative().default(25.0),
	BEDROCK_CACHE_READ_PRICE_PER_1M: z.coerce.number().nonnegative().default(0.5),
	BEDROCK_CACHE_WRITE_PRICE_PER_1M: z.coerce.number().nonnegative().default(6.25),

	// Dobby — Fargate Spot pricing (us-east-1)
	FARGATE_SPOT_VCPU_PER_HOUR: z.coerce.number().nonnegative().default(0.01334058),
	FARGATE_SPOT_MEM_GB_PER_HOUR: z.coerce.number().nonnegative().default(0.00146489),
	FARGATE_SPOT_EPHEMERAL_GB_PER_HOUR: z.coerce.number().nonnegative().default(0.000111),

	// Dobby — API authentication
	DOBBY_API_TOKEN: z.string().optional(),

	// Dobby — MPP
	MPP_ENDPOINT: z.string().optional(),
	MPP_API_KEY: z.string().optional(),
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

/** Reset cached env (for testing) */
export function _resetEnv(): void {
	_env = undefined;
}
