# AGENTS.md

Instructions for AI coding agents (Claude Code, Cursor, Copilot, etc.) working on this codebase.

## Before You Start

1. Read `CLAUDE.md` for project overview and architecture
2. Check `specs/` for product requirements and technical specs
3. Run `bun run typecheck && bun run test` to verify the codebase is healthy

## Build, Lint, Test Commands

```bash
# All commands run from the repo root via Turborepo unless noted
bun run dev              # Start all packages in dev mode
bun run build            # Production build (all workspaces)
bun run lint             # Lint with Biome (biome check .)
bun run typecheck        # TypeScript type checking (all workspaces)
bun run format           # Format with Prettier (Tailwind sort) + Biome
bun run format:check     # Check formatting without writing
bun run storybook        # Start Storybook for packages/ui

# Tests — all workspaces
bun run test             # Run all unit tests (Vitest)
bun run test:e2e         # Run E2E tests (Playwright, from apps/web)

# Run a single test file (run from the package directory)
bunx vitest run src/domain/jobs/billing.test.ts          # from apps/web/
bunx vitest run src/button.test.tsx                       # from packages/ui/

# Watch mode for a single test
bunx vitest src/domain/jobs/billing.test.ts               # from apps/web/

# Database commands (run from apps/web/)
bun run db:generate      # Generate Drizzle migrations
bun run db:migrate       # Run migrations
bun run db:push          # Push schema to DB
bun run db:studio        # Open Drizzle Studio
```

Pre-commit hook runs `bunx lint-staged` (Prettier for Tailwind class sort + Biome check).

## Code Style

### Formatting (enforced by Biome + Prettier)

- **Tabs** for indentation (width 2), line width **100**
- **Double quotes** for JS/JSX strings
- **Semicolons** always
- **Trailing commas** on everything (except JSON)
- **Organize imports** automatically (Biome assist)
- Prettier is used **only** for Tailwind class sorting via `prettier-plugin-tailwindcss`

### TypeScript

- **Strict mode** enabled (`strict: true`, `noUncheckedIndexedAccess: true`)
- Target ES2022, module ESNext, bundler resolution
- Use `type` keyword for type-only imports — **enforced** (`useImportType: error`)
- No `any` — **enforced** (`noExplicitAny: error`)
- No unused variables or imports — **enforced** (both `error`)
- `useConst` and `useTemplate` are **warnings**
- `noNonNullAssertion` is **off** (non-null assertions are allowed)

### Naming Conventions

| Element          | Convention               | Example                                   |
| ---------------- | ------------------------ | ----------------------------------------- |
| Files            | kebab-case               | `status-filter.tsx`, `use-mobile.ts`      |
| Components       | PascalCase               | `StatusFilter`, `ThemeToggle`             |
| Functions        | camelCase                | `calculateJobCost`, `generateJobId`       |
| Constants        | UPPER_SNAKE_CASE         | `ACTIVE_STATUSES`, `JOB_ID_PREFIX`        |
| Types/Interfaces | PascalCase               | `JobStatus`, `ButtonProps`                |
| Test files       | colocated `.test.ts(x)`  | `billing.test.ts` next to `billing.ts`    |
| Story files      | colocated `.stories.tsx` | `button.stories.tsx` next to `button.tsx` |
| Packages         | `@suverenum/[name]`      | `@suverenum/ui`, `@suverenum/utils`       |

### Imports

```typescript
// Workspace packages (raw TypeScript, no build step)
import { cn } from "@suverenum/utils";
import { Button } from "@suverenum/ui";

// App-internal via path alias (@/ -> apps/web/src/)
import { getEnv } from "@/lib/env";
import { jobs } from "@/db/schema";

// Type-only imports (enforced by Biome)
import type { NextConfig } from "next";
import type { ComponentProps } from "react";

// Zod v4
import { z } from "zod/v4";
```

### Error Handling

- Validate inputs with Zod `safeParse`; return 400 with `z.prettifyError()` on failure
- Use semantic HTTP status codes: 400, 401, 402, 404, 409, 429, 500
- Use CAS (Compare-And-Swap) for concurrent DB updates — check `.returning()` length
- Graceful degradation: Sentry/PostHog/Telegram silently skip if keys are missing
- Clean up orphaned resources (e.g., ECS tasks) if DB writes fail after provisioning
- React error boundaries (`error.tsx`, `global-error.tsx`) catch and report to Sentry
- Do NOT add error handling for impossible scenarios

## Writing Code

- Default to **Server Components**. Only add `"use client"` when you need interactivity
- Keep route files thin — business logic belongs in `src/domain/`
- Each domain is self-contained: `actions/`, `components/`, `hooks/`, `queries/`
- Colocate tests next to source files: `component.tsx` + `component.test.tsx`
- No comments unless the logic is non-obvious
- No docstrings unless explicitly requested
- No emojis in code or commits unless requested
- Three similar lines are better than a premature abstraction

## Writing Tests

- **Vitest** + **React Testing Library** for unit tests
- **Playwright** for E2E tests (in `apps/web/e2e/`)
- Test behavior, not implementation details
- Mock at module boundaries (hooks, actions), not internal functions
- Both web and UI vitest configs use jsdom environment + `@testing-library/jest-dom`
- Use `_resetEnv()` / `_resetClient()` style helpers for resetting singletons in tests

## Commits

- Use conventional commits: `feat:`, `fix:`, `chore:`, `test:`, `docs:`
- Keep commits focused — one logical change per commit
- Run `bun run lint && bun run typecheck && bun run test` before committing
- Do NOT skip pre-commit hooks (`--no-verify`)
- Do NOT push directly to `main` — use a PR

## Adding a New Domain

New domains go in `src/domain/[name]/` with subdirectories: `actions/`, `components/`, `hooks/`, `queries/`. Export public API via `index.ts` barrel file.

## Adding a New Shared Package

1. Create `packages/[name]/` with `package.json` (name `@suverenum/[name]`), `tsconfig.json`
2. Export raw TypeScript (no build step), add `workspace:*` dependency in consumers
3. Add to `transpilePackages` in `apps/web/next.config.ts`

## UI Components

New components go in `packages/ui/src/`: component file + Storybook story + export from `index.ts`.
Uses shadcn/ui (base-nova style) + Radix + CVA + Tailwind v4. Use `cn()` from `@suverenum/utils`.
Run `bun run storybook` to develop components visually.

## Key Files

| File                          | Purpose                                        |
| ----------------------------- | ---------------------------------------------- |
| `apps/web/src/lib/env.ts`     | Environment variable validation (Zod)          |
| `apps/web/src/lib/session.ts` | Session management (HMAC, bearer tokens)       |
| `apps/web/src/lib/mpp.ts`     | Machine Payments Protocol (FLOPS billing)      |
| `apps/web/src/lib/kms.ts`     | AWS KMS encrypt/decrypt for secrets            |
| `apps/web/src/db/schema.ts`   | Drizzle DB schema (jobs table)                 |
| `apps/web/src/domain/jobs/`   | Core domain: billing, status, concurrency, ECS |
| `runner/`                     | Docker runner (clone, execute agent, PR)       |
| `biome.json`                  | Linting + formatting rules                     |
| `turbo.json`                  | Task orchestration config                      |
| `packages/tsconfig/base.json` | Shared strict TypeScript config                |

## Do NOT

- Add dependencies without checking if they're already available in the workspace
- Create new files when editing existing ones would suffice
- Add error handling for impossible scenarios
- Over-abstract — three similar lines are better than a premature helper
- Skip the pre-commit hooks (`--no-verify`)
- Push directly to `main` without a PR
- Use `any` — it will fail the linter
- Leave unused imports or variables — they are errors, not warnings
