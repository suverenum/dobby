# AGENTS.md

Instructions for AI coding agents (Claude Code, Cursor, Copilot, etc.) working on this codebase.

## Before You Start

1. Read `CLAUDE.md` for project overview and architecture
2. Check `specs/` for product requirements and technical specs
3. Run `bun run typecheck && bun run test` to verify the codebase is healthy

## Code Style

- **Biome** handles linting and formatting. Run `bun run lint` before committing.
- **Tabs** for indentation, **double quotes**, **trailing commas**, **semicolons**
- **No comments** unless the logic is non-obvious
- **No docstrings** unless explicitly requested
- **No emojis** in code or commits unless requested

## Writing Code

- Default to **Server Components**. Only add `"use client"` when you need interactivity
- Keep route files thin — business logic belongs in `src/domain/`
- Each domain is self-contained: `actions/`, `components/`, `hooks/`, `queries/`
- Colocate tests: `component.tsx` + `component.test.tsx` in the same directory
- Use `@/` path alias for app imports, `@suverenum/ui` and `@suverenum/utils` for shared packages

## Writing Tests

- Use Vitest + React Testing Library
- Test behavior, not implementation
- Mock at module boundaries (hooks, actions), not internal functions
- Colocate tests next to source files

## Commits

- Use conventional commits: `feat:`, `fix:`, `chore:`, `test:`, `docs:`
- Keep commits focused — one logical change per commit
- Run `bun run lint && bun run typecheck && bun run test` before committing

## Adding a New Domain

```
src/domain/[name]/
├── actions/           # Server actions
├── components/        # Domain UI (colocated tests)
├── hooks/             # Client-side hooks
└── queries/           # Data fetching (server)
```

## Adding a New Shared Package

1. Create `packages/[name]/` with `package.json`, `tsconfig.json`
2. Name it `@suverenum/[name]`
3. Export raw TypeScript (no build step)
4. Add `workspace:*` dependency in consuming packages
5. Add to `transpilePackages` in `apps/web/next.config.ts`

## UI Components

New components go in `packages/ui/src/`. Each component needs:
- The component file (`component.tsx`)
- A Storybook story (`component.stories.tsx`)
- Export from `packages/ui/src/index.ts`

Existing components: Button, Card, Input, Tag, Prose, GridPattern, HeroPattern.

Run `bun run storybook` to develop components visually.

## Key Files

| File | Purpose |
|---|---|
| `apps/web/src/lib/env.ts` | Environment variable validation (Zod) |
| `apps/web/src/lib/session.ts` | Session management |
| `apps/web/src/db/schema.ts` | Drizzle DB schema |
| `packages/ui/.storybook/main.ts` | Storybook config |
| `biome.json` | Linting + formatting rules |
| `turbo.json` | Task orchestration config |

## Do NOT

- Add dependencies without checking if they're already available in the workspace
- Create new files when editing existing ones would suffice
- Add error handling for impossible scenarios
- Over-abstract — three similar lines are better than a premature helper
- Skip the pre-commit hooks (`--no-verify`)
- Push directly to `main` without a PR

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
