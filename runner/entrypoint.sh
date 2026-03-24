#!/usr/bin/env bash
set -euo pipefail

# ─── Helpers ──────────────────────────────────────────────────────────────────

log() { echo "[dobby-runner] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

callback() {
  local status="$1"
  shift
  local extra_fields=""
  while [[ $# -gt 0 ]]; do
    extra_fields="$extra_fields, $1"
    shift
  done

  local payload="{\"jobId\": \"${DOBBY_JOB_ID}\", \"status\": \"${status}\"${extra_fields}}"
  log "Callback: ${status}"

  curl -sf -X POST "${DOBBY_CALLBACK_URL}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${DOBBY_CALLBACK_SECRET}" \
    -d "${payload}" || log "WARNING: callback failed"
}

# ─── SIGTERM handler ──────────────────────────────────────────────────────────

INTERRUPTED=0

handle_sigterm() {
  log "SIGTERM received — pushing checkpoint and exiting"
  INTERRUPTED=1

  # Kill ralphex if running
  if [[ -n "${RALPHEX_PID:-}" ]]; then
    kill "${RALPHEX_PID}" 2>/dev/null || true
    wait "${RALPHEX_PID}" 2>/dev/null || true
  fi

  cd "${WORK_DIR}" 2>/dev/null || exit 1

  # Commit any uncommitted work
  git add -A 2>/dev/null || true
  git commit -m "checkpoint: interrupted by SIGTERM" --allow-empty 2>/dev/null || true

  # Push what we have
  git push origin "${DOBBY_WORKING_BRANCH}" --force-with-lease 2>/dev/null || true

  local last_commit
  last_commit=$(git rev-parse HEAD 2>/dev/null || echo "")

  local extra=""
  if [[ -n "${last_commit}" ]]; then
    extra="\"lastCheckpointCommit\": \"${last_commit}\""
  fi
  if [[ -n "${PR_URL:-}" ]]; then
    extra="${extra:+${extra}, }\"prUrl\": \"${PR_URL}\""
  fi

  callback "interrupted" ${extra:+"${extra}"}
  exit 0
}

trap handle_sigterm SIGTERM

# ─── Validate required env vars ───────────────────────────────────────────────

for var in DOBBY_JOB_ID DOBBY_TASK DOBBY_REPOSITORY DOBBY_BASE_BRANCH \
           DOBBY_WORKING_BRANCH DOBBY_GIT_TOKEN DOBBY_CALLBACK_URL; do
  if [[ -z "${!var:-}" ]]; then
    log "ERROR: ${var} is not set"
    callback "failed" "\"error\": \"Missing required env var: ${var}\""
    exit 1
  fi
done

# ─── Phase 1: Clone ──────────────────────────────────────────────────────────

callback "cloning"
log "Cloning ${DOBBY_REPOSITORY} (branch: ${DOBBY_BASE_BRANCH})"

WORK_DIR="/workspace/repo"
PR_URL="${DOBBY_EXISTING_PR_URL:-}"

# Configure git credentials
git config --global credential.helper store
echo "https://x-access-token:${DOBBY_GIT_TOKEN}@github.com" > "${HOME}/.git-credentials"
git config --global user.email "dobby@suverenum.ai"
git config --global user.name "Dobby"

# Clone the repo
git clone --depth=50 --branch "${DOBBY_BASE_BRANCH}" \
  "${DOBBY_REPOSITORY}" "${WORK_DIR}"
cd "${WORK_DIR}"

# Checkout or create working branch
if git ls-remote --heads origin "${DOBBY_WORKING_BRANCH}" | grep -q .; then
  log "Working branch exists — checking out"
  git fetch origin "${DOBBY_WORKING_BRANCH}"
  git checkout "${DOBBY_WORKING_BRANCH}"
else
  log "Creating working branch"
  git checkout -b "${DOBBY_WORKING_BRANCH}"
fi

# If resuming from checkpoint, verify it exists
if [[ -n "${DOBBY_CHECKPOINT_COMMIT:-}" ]]; then
  if git cat-file -t "${DOBBY_CHECKPOINT_COMMIT}" &>/dev/null; then
    log "Resuming from checkpoint ${DOBBY_CHECKPOINT_COMMIT}"
    git reset --hard "${DOBBY_CHECKPOINT_COMMIT}"
  else
    log "WARNING: checkpoint commit not found, continuing from branch HEAD"
  fi
fi

[[ $INTERRUPTED -eq 1 ]] && exit 0

# ─── Phase 2: Execute with Ralphex ───────────────────────────────────────────

callback "executing"

# Verify LLM credentials are available
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  log "ANTHROPIC_API_KEY is set (${#ANTHROPIC_API_KEY} chars)"
else
  log "WARNING: ANTHROPIC_API_KEY is not set"
fi

log "Starting Ralphex..."


# Verify Claude Code can authenticate
log "Testing Claude Code auth..."
claude --version 2>&1 || log "WARNING: claude --version failed"
claude -p "respond with just the word hello" --output-format text 2>&1 | head -5 || log "WARNING: claude test prompt failed"

# Write task as a plan file for Ralphex
PLAN_FILE="/tmp/dobby-plan.md"
cat > "${PLAN_FILE}" <<PLAN
# Task: ${DOBBY_JOB_ID}

${DOBBY_TASK}
PLAN

# Run Ralphex with full workflow (tasks + multi-agent review)
ralphex "${PLAN_FILE}" 2>&1 | tee /tmp/ralphex-output.log &

RALPHEX_PID=$!

# Wait for Ralphex, but allow SIGTERM to interrupt
wait $RALPHEX_PID || {
  EXIT_CODE=$?
  if [[ $INTERRUPTED -eq 1 ]]; then
    exit 0
  fi
  log "Ralphex exited with code ${EXIT_CODE}"
}

[[ $INTERRUPTED -eq 1 ]] && exit 0

# ─── Phase 3: Finalize ───────────────────────────────────────────────────────

callback "finalizing"
log "Finalizing — pushing changes"

# Stage and commit any remaining changes
git add -A
if ! git diff --cached --quiet; then
  git commit -m "dobby: completed task

Task: ${DOBBY_TASK:0:200}"
fi

# Push to remote
git push origin "${DOBBY_WORKING_BRANCH}" --force-with-lease

LAST_COMMIT=$(git rev-parse HEAD)

# Create PR if one doesn't exist
if [[ -z "${PR_URL}" ]]; then
  log "Creating pull request"

  REPO_SLUG=$(echo "${DOBBY_REPOSITORY}" | sed -E 's|https?://github\.com/||; s|\.git$||')

  PR_RESPONSE=$(curl -sf -X POST "https://api.github.com/repos/${REPO_SLUG}/pulls" \
    -H "Authorization: token ${DOBBY_GIT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"title\": \"[Dobby] ${DOBBY_TASK:0:120}\",
      \"head\": \"${DOBBY_WORKING_BRANCH}\",
      \"base\": \"${DOBBY_BASE_BRANCH}\",
      \"body\": \"Automated PR created by Dobby.\\n\\n**Task:**\\n${DOBBY_TASK:0:500}\",
      \"draft\": true
    }" 2>/dev/null || echo "{}")

  PR_URL=$(echo "${PR_RESPONSE}" | jq -r '.html_url // empty')
  if [[ -n "${PR_URL}" ]]; then
    log "PR created: ${PR_URL}"
  else
    log "WARNING: failed to create PR"
  fi
fi

[[ $INTERRUPTED -eq 1 ]] && exit 0

# ─── Done ─────────────────────────────────────────────────────────────────────

EXTRA="\"lastCheckpointCommit\": \"${LAST_COMMIT}\""
if [[ -n "${PR_URL}" ]]; then
  EXTRA="${EXTRA}, \"prUrl\": \"${PR_URL}\""
fi

callback "completed" "${EXTRA}"
log "Done"
