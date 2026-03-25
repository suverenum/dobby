---
name: beads
description: "Beads (bd) issue tracking for AI agents. Dolt-powered dependency-aware graph tracker. Use for task planning, issue lifecycle, session workflows, checking ready work, creating/closing issues, and tracking blockers."
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, TodoWrite
---

# Beads (bd) Issue Tracking

Beads is a distributed graph issue tracker for AI agents, powered by Dolt. It replaces markdown TODOs with a persistent, dependency-aware task graph.

## Project Configuration

- **Issue prefix**: `dobby-<hash>` (e.g., `dobby-a3f2`)
- **Database**: `.beads/dolt/` (Dolt-backed, version-controlled)
- **Git hooks**: Wired through husky (`.husky/`) into beads hooks

## Essential Commands

```bash
# Check what's ready to work on
bd ready --json

# Create issues
bd create "Issue title" --description="Context" -t bug|feature|task|epic|chore -p 0-4 --json

# Claim a task (sets assignee + in_progress atomically)
bd update <id> --claim --json

# Update issue fields
bd update <id> --description "new description"
bd update <id> --title "new title"
bd update <id> --priority 1

# Close when done
bd close <id> --reason "Completed" --json

# List and search
bd list --status open
bd list --priority 1
bd blocked
bd stats

# Show details
bd show <id> --json

# Dependency management
bd dep add <child> <parent>
bd dep tree <id>
bd dep cycles
```

## Issue Types

| Type | When to use |
|------|-------------|
| `bug` | Something broken |
| `feature` | New functionality |
| `task` | Work item (tests, docs, refactoring) |
| `epic` | Large feature with subtasks |
| `chore` | Maintenance (dependencies, tooling) |

## Priorities

| Priority | Meaning |
|----------|---------|
| `0` | Critical (security, data loss, broken builds) |
| `1` | High (major features, important bugs) |
| `2` | Medium (default, nice-to-have) |
| `3` | Low (polish, optimization) |
| `4` | Backlog (future ideas) |

## Agent Workflow

1. **Check ready work**: `bd ready --json` shows unblocked issues
2. **Claim your task**: `bd update <id> --claim --json`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   ```bash
   bd create "Found bug" --description="Details" -p 1 --deps discovered-from:<parent-id> --json
   ```
5. **Complete**: `bd close <id> --reason "Done" --json`

## Hierarchical Issues (Epics)

```bash
# Create epic
bd create "Auth System" -t epic -p 1
# Returns: dobby-a3f8

# Create child tasks
bd create "Design login UI" -p 1 --parent dobby-a3f8
bd create "Backend validation" -p 1 --parent dobby-a3f8

# View hierarchy
bd dep tree dobby-a3f8
```

## Commit Messages

Include issue ID in commit messages for traceability:

```bash
git commit -m "feat: add auth validation (dobby-abc)"
```

## Session Completion ("Landing the Plane")

When ending a work session, complete ALL steps:

1. **File issues** for remaining work
2. **Run quality gates** (if code changed): `bun run lint && bun run typecheck && bun run test`
3. **Update issue status**: Close finished work
4. **Push to remote**:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Verify**: All changes committed AND pushed

## Important Rules

- Always use `--json` flag for programmatic/parseable output
- Link discovered work with `discovered-from` dependencies
- Check `bd ready` before asking "what should I work on?"
- Do NOT use `bd edit` (opens interactive editor) -- use `bd update` with flags
- Use stdin for descriptions with special characters:
  ```bash
  echo 'Description with `backticks`' | bd create "Title" --stdin
  ```

## Dolt Sync

```bash
# Push issue database to remote
bd dolt push

# Pull teammates' changes
bd dolt pull
```

## Troubleshooting

```bash
# Health check
bd doctor

# Database info
bd info --schema --json

# Check version
bd version
```
