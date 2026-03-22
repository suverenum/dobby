# Dobby Setup Guide

## Prerequisites

- [Bun](https://bun.sh/) (v1.3+)
- [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`)
- AWS CLI configured with admin access
- Neon Postgres database (provisioned via Vercel integration)

## 1. Install dependencies

```bash
bun install
```

## 2. Environment variables

All environment variables are managed through Vercel. Pull them locally:

```bash
cd apps/web && vercel env pull .env.local
```

### Required variables

| Variable | Description | How to get |
|----------|-------------|------------|
| `DATABASE_URL` | Neon Postgres connection string | Auto-provisioned via Vercel Neon integration |
| `SESSION_SECRET` | HMAC key for admin session cookies (min 16 chars) | Generate: `python3 -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `DOBBY_ADMIN_PASSWORD_HASH` | bcrypt hash for admin UI login | Generate: `python3 -c "import bcrypt; print(bcrypt.hashpw(b'YOUR_PASSWORD', bcrypt.gensalt(10)).decode())"` |

> **Note:** The bcrypt hash contains `$` characters. When storing in `.env.local`, use single quotes and escape `$` signs: `DOBBY_ADMIN_PASSWORD_HASH='\$2b\$10\$...'`

### AWS / ECS variables

| Variable | Description |
|----------|-------------|
| `AWS_ACCESS_KEY_ID` | IAM user access key |
| `AWS_SECRET_ACCESS_KEY` | IAM user secret key |
| `AWS_REGION` | AWS region (default: `us-east-1`) |
| `ECS_CLUSTER_ARN` | ECS cluster ARN |
| `ECS_TASK_DEFINITION_ARN` | ECS task definition ARN |
| `ECS_SUBNETS` | Comma-separated subnet IDs |
| `ECS_SECURITY_GROUPS` | Comma-separated security group IDs |
| `KMS_KEY_ID` | KMS key ID for encrypting job secrets |

### Job configuration (all have defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `DOBBY_HOURLY_RATE` | `100` | FLOPS per hour |
| `DOBBY_MAX_JOB_HOURS` | `6` | Max job duration in hours |
| `DOBBY_ACCOUNT_VCPU_LIMIT` | `24` | Account vCPU quota |
| `DOBBY_VM_CPU` | `4` | vCPU per runner |
| `DOBBY_CONTAINER_IMAGE` | ECR default | Custom runner Docker image |

### Internal secrets

| Variable | Description |
|----------|-------------|
| `CRON_SECRET` | Authenticates the Vercel Cron timeout endpoint |
| `DOBBY_CALLBACK_SECRET` | Authenticates runner-to-API callbacks |
| `DOBBY_CALLBACK_URL` | Base URL for runner callbacks (e.g. `https://dobby.suverenum.ai`) |

### Optional integrations (app works without these)

| Variable | Description |
|----------|-------------|
| `DOBBY_TELEGRAM_BOT_TOKEN` | Telegram Bot API token for job notifications |
| `DOBBY_TELEGRAM_CHAT_ID` | Telegram chat ID for notifications |
| `MPP_ENDPOINT` | Machine Payments Protocol API endpoint |
| `MPP_API_KEY` | MPP API key |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry client DSN for error tracking |
| `NEXT_PUBLIC_POSTHOG_KEY` | PostHog analytics key |
| `NEXT_PUBLIC_POSTHOG_HOST` | PostHog API host |

## 3. AWS infrastructure setup

### IAM user

Create an IAM user for the app with this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecs:RunTask", "ecs:StopTask"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt"],
      "Resource": "<your-kms-key-arn>"
    },
    {
      "Effect": "Allow",
      "Action": "logs:GetLogEvents",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "<your-ecs-task-execution-role-arn>"
    }
  ]
}
```

### ECS cluster

```bash
aws ecs create-cluster --cluster-name dobby --region us-east-1

aws ecs put-cluster-capacity-providers \
  --cluster dobby \
  --capacity-providers FARGATE_SPOT FARGATE \
  --default-capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1 \
  --region us-east-1
```

### ECS task execution role

```bash
aws iam create-role --role-name dobby-ecs-task-execution \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "ecs-tasks.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy --role-name dobby-ecs-task-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

### ECS task definition

```bash
aws ecs register-task-definition --region us-east-1 --cli-input-json '{
  "family": "dobby-runner",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "4096",
  "memory": "16384",
  "ephemeralStorage": { "sizeInGiB": 21 },
  "executionRoleArn": "<your-execution-role-arn>",
  "containerDefinitions": [{
    "name": "dobby-runner",
    "image": "<your-runner-image>",
    "essential": true,
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/dobby-runner",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "runner"
      }
    }
  }]
}'
```

### CloudWatch log group

```bash
aws logs create-log-group --log-group-name /ecs/dobby-runner --region us-east-1
```

### Security group

```bash
aws ec2 create-security-group \
  --group-name dobby-runner \
  --description "Dobby ECS runner - outbound only" \
  --vpc-id <your-vpc-id> \
  --region us-east-1
```

No inbound rules needed. Default outbound (all traffic) is sufficient.

### KMS key

```bash
aws kms create-key --description "Dobby job secrets encryption" --region us-east-1
aws kms create-alias --alias-name alias/dobby-secrets --target-key-id <key-id>
```

## 4. Database setup

Push the schema to your Neon database:

```bash
cd apps/web
export $(grep -v '^#' .env.local | xargs)
bunx drizzle-kit push
```

For production, generate and commit migrations instead:

```bash
bunx drizzle-kit generate
bunx drizzle-kit migrate
```

## 5. Run locally

```bash
bun run dev
```

The app redirects `/` to `/admin/login`. Log in with the password you hashed in step 2.

## 6. Deploy

Push to the connected branch. Vercel will build and deploy automatically.

Make sure all environment variables are set in Vercel for the target environment (production / preview / development).

## 7. Vercel Cron (optional)

To enable automatic job timeout enforcement, add to `vercel.json`:

```json
{
  "crons": [{
    "path": "/api/cron/timeout",
    "schedule": "*/5 * * * *"
  }]
}
```

This runs every 5 minutes and stops jobs that exceed `DOBBY_MAX_JOB_HOURS`.
