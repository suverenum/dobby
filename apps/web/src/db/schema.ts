import { integer, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const jobs = pgTable("jobs", {
	id: text("id").primaryKey(),
	status: text("status").notNull(),
	repository: text("repository").notNull(),
	baseBranch: text("base_branch").notNull(),
	workingBranch: text("working_branch").notNull(),
	task: text("task").notNull(),
	existingPrUrl: text("existing_pr_url"),
	prUrl: text("pr_url"),

	// Encrypted at rest via KMS
	encryptedGitCredentials: text("encrypted_git_credentials").notNull(),
	encryptedSecrets: text("encrypted_secrets"),

	// ECS
	ecsTaskArn: text("ecs_task_arn"),
	ecsClusterArn: text("ecs_cluster_arn"),
	logStreamName: text("log_stream_name"),

	// Token usage & cost
	inputTokens: integer("input_tokens"),
	outputTokens: integer("output_tokens"),
	cacheReadTokens: integer("cache_read_tokens"),
	cacheWriteTokens: integer("cache_write_tokens"),
	bedrockCostUsd: numeric("bedrock_cost_usd", { precision: 12, scale: 6 }),
	containerCostUsd: numeric("container_cost_usd", { precision: 12, scale: 6 }),
	costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),

	// Timestamps
	submittedAt: timestamp("submitted_at").notNull().defaultNow(),
	startedAt: timestamp("started_at"),
	finishedAt: timestamp("finished_at"),

	// Spot resume
	resumeCount: integer("resume_count").default(0),
	lastCheckpointCommit: text("last_checkpoint_commit"),
	interruptedAt: timestamp("interrupted_at"),
});
