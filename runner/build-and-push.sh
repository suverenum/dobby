#!/usr/bin/env bash
set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="dobby-runner"
IMAGE_TAG="${1:-latest}"
FULL_IMAGE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Create ECR repo if needed ────────────────────────────────────────────────

echo "==> Ensuring ECR repository exists..."
aws ecr describe-repositories --repository-names "${ECR_REPO}" --region "${AWS_REGION}" &>/dev/null || \
  aws ecr create-repository --repository-name "${ECR_REPO}" --region "${AWS_REGION}" --image-scanning-configuration scanOnPush=true

# ─── Login to ECR ─────────────────────────────────────────────────────────────

echo "==> Logging in to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# ─── Build ────────────────────────────────────────────────────────────────────

echo "==> Building image: ${FULL_IMAGE}"
docker build --platform linux/amd64 -t "${FULL_IMAGE}" "${SCRIPT_DIR}"

# ─── Push ─────────────────────────────────────────────────────────────────────

echo "==> Pushing to ECR..."
docker push "${FULL_IMAGE}"

echo "==> Done: ${FULL_IMAGE}"
echo ""
echo "To use this image, set in Vercel:"
echo "  DOBBY_CONTAINER_IMAGE=${FULL_IMAGE}"
