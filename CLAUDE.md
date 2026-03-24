# CLAUDE.md

## Project Overview

Dobby is an ephemeral AI coding service. Callers submit a task + GitHub repo via REST API, Dobby provisions an ECS Fargate Spot container running an AI coding agent (Ralphex), and returns a draft pull request. Billing is per-minute in FLOPS tokens via the Machine Payments Protocol.

The codebase is a Bun monorepo using Next.js 16 (App Router, Turbopack, React Compiler), Turborepo, Drizzle ORM + Neon Postgres, Tailwind CSS v4, Biome, Vitest, and Playwright.

## Essential Commands

```bash
bun run dev          # Start all packages in dev mode
bun run build        # Production build
bun run test         # Run unit tests (Vitest)
bun run test:e2e     # Run E2E tests (Playwright)
bun run lint         # Lint with Biome
bun run typecheck    # TypeScript type checking
bun run format       # Format with Biome + Prettier (Tailwind class sort)
bun run format:check # Check formatting
bun run storybook    # Start Storybook for UI components
```

## Architecture

### Monorepo Structure

- `apps/web/` — Next.js application (API, admin UI, job orchestration)
- `packages/ui/` — Shared UI components (Radix + CVA + Tailwind + Storybook 10)
- `packages/utils/` — Shared utilities (cn, etc.)
- `packages/tsconfig/` — Shared TypeScript configs
- `runner/` — Docker container that clones repos, runs the AI agent, creates PRs

### Key Patterns

- Server Components by default, `'use client'` only when needed
- Domain-driven design: business logic in `src/domain/`
- Server actions for mutations, TanStack Query for server state, Zustand for client state
- Zod for env validation and API request schemas
- Sentry + PostHog degrade gracefully when keys are missing
- CAS (Compare-And-Swap) for concurrent DB updates
- Fargate Spot with auto-resume on interruption

### Styling

- Tailwind CSS v4 with PostCSS + Protocol theme (emerald accent, zinc neutrals)
- Dark mode via `next-themes` with system preference sync
- CVA for component variants, `cn()` from `@suverenum/utils`
- `@tailwindcss/typography` for prose content

## Testing

- Unit tests: Vitest + React Testing Library (colocated `*.test.ts(x)`)
- E2E tests: Playwright (`apps/web/e2e/`)
- Run from root: `bun run test` / `bun run test:e2e`

## Database

- Drizzle ORM + Neon serverless Postgres
- Schema in `apps/web/src/db/schema.ts` (single `jobs` table)
- Migrations via `drizzle-kit` (run from `apps/web/`): `db:generate`, `db:migrate`, `db:push`, `db:studio`

## Guidelines & Workflow

- `AGENTS.md` — instructions for AI coding agents
- `guidelines/workflow.md` — product improvement workflow (PRD → SPEC → tasks → implement)
- `guidelines/docs/` — PRD and SPEC templates
- `guidelines/roles/` — role-specific guidelines (EM, Engineer)
- `specs/` — product specs per feature branch
