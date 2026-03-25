import { ECSClient, RunTaskCommand, StopTaskCommand } from "@aws-sdk/client-ecs";
import type { InferSelectModel } from "drizzle-orm";
import type { jobs } from "../../db/schema";
import { getEnv } from "../../lib/env";

type Job = InferSelectModel<typeof jobs>;

let _client: ECSClient | undefined;

function getClient(): ECSClient {
	if (_client) return _client;
	const env = getEnv();
	_client = new ECSClient({
		region: env.AWS_REGION,
		...(env.AWS_ACCESS_KEY_ID &&
			env.AWS_SECRET_ACCESS_KEY && {
				credentials: {
					accessKeyId: env.AWS_ACCESS_KEY_ID,
					secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
				},
			}),
	});
	return _client;
}

export interface DecryptedSecrets {
	gitToken: string;
	secrets?: Record<string, string>;
}

export interface ProvisionResult {
	taskArn: string;
	clusterArn: string;
}

/**
 * Provision a Fargate Spot task for a job. Returns the ECS task ARN and cluster ARN.
 */
export async function provisionTask(
	job: Job,
	decryptedSecrets: DecryptedSecrets,
): Promise<ProvisionResult> {
	const env = getEnv();

	if (!env.ECS_CLUSTER_ARN) {
		throw new Error("ECS_CLUSTER_ARN is not configured");
	}
	if (!env.ECS_TASK_DEFINITION_ARN) {
		throw new Error("ECS_TASK_DEFINITION_ARN is not configured");
	}
	if (!env.ECS_SUBNETS) {
		throw new Error("ECS_SUBNETS is not configured");
	}
	if (!env.ECS_SECURITY_GROUPS) {
		throw new Error("ECS_SECURITY_GROUPS is not configured");
	}
	if (!env.DOBBY_CALLBACK_URL) {
		throw new Error("DOBBY_CALLBACK_URL is not configured");
	}

	const subnets = env.ECS_SUBNETS.split(",").map((s) => s.trim());
	const securityGroups = env.ECS_SECURITY_GROUPS.split(",").map((s) => s.trim());

	const containerEnv: { name: string; value: string }[] = [
		{ name: "DOBBY_JOB_ID", value: job.id },
		{ name: "DOBBY_TASK", value: job.task },
		{ name: "DOBBY_REPOSITORY", value: job.repository },
		{ name: "DOBBY_BASE_BRANCH", value: job.baseBranch },
		{ name: "DOBBY_WORKING_BRANCH", value: job.workingBranch },
		{ name: "DOBBY_GIT_TOKEN", value: decryptedSecrets.gitToken },
		{
			name: "DOBBY_CALLBACK_URL",
			value: `${env.DOBBY_CALLBACK_URL.replace(/\/+$/, "")}/api/internal/callback`,
		},
		{ name: "DOBBY_CALLBACK_SECRET", value: env.DOBBY_CALLBACK_SECRET ?? "" },
		{ name: "DOBBY_CHECKPOINT_COMMIT", value: job.lastCheckpointCommit ?? "" },
		{ name: "DOBBY_EXISTING_PR_URL", value: job.existingPrUrl ?? "" },
	];

	// Inject AWS credentials for Bedrock (reuse existing AWS creds)
	if (env.AWS_ACCESS_KEY_ID) {
		containerEnv.push({ name: "AWS_ACCESS_KEY_ID", value: env.AWS_ACCESS_KEY_ID });
	}
	if (env.AWS_SECRET_ACCESS_KEY) {
		containerEnv.push({ name: "AWS_SECRET_ACCESS_KEY", value: env.AWS_SECRET_ACCESS_KEY });
	}
	containerEnv.push({ name: "AWS_REGION", value: env.AWS_REGION });
	containerEnv.push({ name: "BEDROCK_MODEL_ID", value: env.BEDROCK_MODEL_ID });

	// Inject caller secrets as additional env vars (block reserved names)
	if (decryptedSecrets.secrets) {
		const reservedPrefixes = ["DOBBY_", "AWS_", "ECS_"];
		const reservedNames = new Set(["PATH", "HOME", "USER", "SHELL"]);
		for (const [key, value] of Object.entries(decryptedSecrets.secrets)) {
			const upperKey = key.toUpperCase();
			if (reservedNames.has(upperKey) || reservedPrefixes.some((p) => upperKey.startsWith(p))) {
				continue; // Skip reserved environment variable names
			}
			containerEnv.push({ name: key, value });
		}
	}

	const client = getClient();

	const containerName = "dobby-runner";

	const command = new RunTaskCommand({
		cluster: env.ECS_CLUSTER_ARN,
		taskDefinition: env.ECS_TASK_DEFINITION_ARN,
		launchType: undefined, // Using capacity provider strategy instead
		capacityProviderStrategy: [
			{
				capacityProvider: "FARGATE_SPOT",
				weight: 1,
			},
		],
		networkConfiguration: {
			awsvpcConfiguration: {
				subnets,
				securityGroups,
				assignPublicIp: "ENABLED",
			},
		},
		overrides: {
			containerOverrides: [
				{
					name: containerName,
					environment: containerEnv,
					...(env.DOBBY_CONTAINER_IMAGE && { image: env.DOBBY_CONTAINER_IMAGE }),
				},
			],
			cpu: String(env.DOBBY_VM_CPU * 1024), // vCPU in CPU units (1024 per vCPU)
			memory: String(env.DOBBY_VM_CPU * 4 * 1024), // 4 GB per vCPU in MiB
			ephemeralStorage: {
				sizeInGiB: 21,
			},
		},
		count: 1,
	});

	const response = await client.send(command);

	const task = response.tasks?.[0];
	if (!task?.taskArn) {
		const failure = response.failures?.[0];
		throw new Error(`Failed to provision ECS task: ${failure?.reason ?? "no task returned"}`);
	}

	return {
		taskArn: task.taskArn,
		clusterArn: task.clusterArn ?? env.ECS_CLUSTER_ARN,
	};
}

/**
 * Stop a running Fargate task. Sends SIGTERM to the container.
 */
export async function stopTask(job: Job): Promise<void> {
	const env = getEnv();

	if (!job.ecsTaskArn) {
		throw new Error(`Job ${job.id} has no ECS task ARN`);
	}

	const clusterArn = job.ecsClusterArn ?? env.ECS_CLUSTER_ARN;
	if (!clusterArn) {
		throw new Error("No cluster ARN available for stopping task");
	}

	const client = getClient();
	const command = new StopTaskCommand({
		cluster: clusterArn,
		task: job.ecsTaskArn,
		reason: `Job ${job.id} stopped via API`,
	});

	await client.send(command);
}

/** Reset cached client (for testing) */
export function _resetClient(): void {
	_client = undefined;
}
