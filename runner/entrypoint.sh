#!/usr/bin/env bash
set -euo pipefail

# Entrypoint for the Dobby runner container. Clones a GitHub repository, runs the
# OpenCode AI agent (with Hyperpowers/execute-ralph backed by AWS Bedrock) against a
# task description, and pushes a draft pull request with the results. Handles SIGTERM
# gracefully by checkpointing in-progress work so interrupted jobs can be resumed.

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

  # Kill opencode if running
  if [[ -n "${OPENCODE_PID:-}" ]]; then
    kill "${OPENCODE_PID}" 2>/dev/null || true
    wait "${OPENCODE_PID}" 2>/dev/null || true
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

# ─── Phase 2: Execute with OpenCode + Hyperpowers ────────────────────────────

callback "executing"

# Verify AWS/Bedrock credentials are available
if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
  log "AWS_ACCESS_KEY_ID is set"
else
  log "WARNING: AWS_ACCESS_KEY_ID is not set — Bedrock auth may fail"
fi

log "Configuring OpenCode for Bedrock..."

# Determine the Bedrock model to use
BEDROCK_MODEL="${BEDROCK_MODEL_ID:-us.anthropic.claude-opus-4-6-v1}"

# Generate opencode.json for this project with Bedrock provider config
cat > "${WORK_DIR}/opencode.json" <<OCCONFIG
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "amazon-bedrock/${BEDROCK_MODEL}",
  "provider": {
    "amazon-bedrock": {
      "options": {
        "region": "${AWS_REGION:-us-east-1}"
      }
    }
  },
  "permission": {
    "bash": "allow",
    "todowrite": "allow",
    "todoread": "allow",
    "skill": "allow",
    "webfetch": "allow",
    "question": "allow",
    "read": "allow",
    "edit": "allow",
    "write": "allow",
    "grep": "allow",
    "glob": "allow",
    "list": "allow",
    "lsp": "allow",
    "patch": "allow"
  }
}
OCCONFIG

log "OpenCode configured with model: amazon-bedrock/${BEDROCK_MODEL}"

# Initialize beads for this repo if not already set up
if [[ ! -d "${WORK_DIR}/.beads" ]]; then
  log "Initializing beads tracker"
  bd init 2>/dev/null || log "WARNING: bd init failed (may already exist)"
fi

# Create a bd epic from the task description
log "Creating bd epic from task..."
EPIC_OUTPUT=$(bd create "Dobby Task: ${DOBBY_JOB_ID}" \
  --type epic \
  --priority 1 \
  --design "## Task

${DOBBY_TASK}

## Success Criteria

- [ ] All requirements from the task description are implemented
- [ ] Tests pass
- [ ] Code compiles without errors" \
  --json 2>/dev/null || echo "{}")

EPIC_ID=$(echo "${EPIC_OUTPUT}" | jq -r '.id // empty' 2>/dev/null || echo "")

if [[ -n "${EPIC_ID}" ]]; then
  log "Created epic: ${EPIC_ID}"
else
  log "WARNING: Failed to create epic, OpenCode will handle task directly"
fi

log "Starting OpenCode with execute-ralph..."

# Build the prompt — pass the epic ID explicitly so execute-ralph works on the right epic
if [[ -n "${EPIC_ID}" ]]; then
  RALPH_PROMPT="Execute epic ${EPIC_ID} using the execute-ralph skill. The epic contains the full task description and success criteria. Use: /hyperpowers:execute-ralph

Epic ID: ${EPIC_ID}
Run 'bd show ${EPIC_ID}' to load the epic details before starting Phase 0."
else
  # Fallback: pass the task directly if epic creation failed
  RALPH_PROMPT="Execute the following task using the execute-ralph skill. First create a bd epic from this task, then run /hyperpowers:execute-ralph

Task: ${DOBBY_TASK}"
fi

opencode run "${RALPH_PROMPT}" 2>&1 | tee /tmp/opencode-output.log &

OPENCODE_PID=$!

# Wait for OpenCode, but allow SIGTERM to interrupt
wait $OPENCODE_PID || {
  EXIT_CODE=$?
  if [[ $INTERRUPTED -eq 1 ]]; then
    exit 0
  fi
  log "OpenCode exited with code ${EXIT_CODE}"
}

[[ $INTERRUPTED -eq 1 ]] && exit 0

# ─── Phase 3: Finalize ───────────────────────────────────────────────────────

callback "finalizing"
log "Finalizing — pushing changes"

# Remove generated opencode.json before committing (don't pollute the repo)
rm -f "${WORK_DIR}/opencode.json"

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
