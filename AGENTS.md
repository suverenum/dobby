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
- Use `@/` path alias for app imports, `@template/ui` and `@template/utils` for shared packages

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
2. Name it `@template/[name]`
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
