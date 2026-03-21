# Dobby

Monorepo boilerplate with Next.js 16, Bun, Turborepo, Drizzle ORM, Neon Postgres, Tailwind CSS v4, Protocol theme, Storybook, Biome, Vitest, Playwright, Sentry, and PostHog.

## Quick Start

```bash
# 1. Clone (or use GitHub template)
gh repo create my-project --template suverenum/boiler
cd my-project

# 2. Run setup script
chmod +x setup.sh
./setup.sh

# 3. Start developing
bun run dev
```

The setup script will:
1. Rename all `@suverenum` / `dobby` placeholders to your project name
2. Optionally create and link a Vercel project
3. Optionally create a Neon Postgres database
4. Generate `.env.local` and install dependencies

## Commands

| Command | Description |
|---|---|
| `bun run dev` | Start all packages in dev mode (Turbopack) |
| `bun run build` | Production build (Turborepo cached) |
| `bun run test` | Run unit tests (Vitest) |
| `bun run test:e2e` | Run E2E tests (Playwright) |
| `bun run lint` | Lint with Biome |
| `bun run typecheck` | TypeScript type checking |
| `bun run format` | Format with Biome + Prettier (Tailwind class sort) |
| `bun run format:check` | Check formatting |
| `bun run storybook` | Start Storybook for UI components |
| `bun run build-storybook` | Build static Storybook site |

### Database (run from `apps/web/`)

| Command | Description |
|---|---|
| `bun run db:generate` | Generate Drizzle migrations |
| `bun run db:migrate` | Run migrations |
| `bun run db:push` | Push schema directly (dev) |
| `bun run db:studio` | Open Drizzle Studio |

## Structure

```
├── apps/web/              Next.js 16 application
├── packages/ui/           Shared UI components (Radix + CVA + Storybook)
├── packages/utils/        Shared utilities (cn, etc.)
├── packages/tsconfig/     Shared TypeScript configs
├── guidelines/            PRD/SPEC templates, role guides, workflow
├── specs/                 Product specs per feature branch
├── .claude/skills/        Claude Code skills for the stack
├── .github/workflows/     CI pipeline + Claude Code review
└── setup.sh               Post-clone setup script
```

## Stack

| Category | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack, React Compiler) |
| Language | TypeScript (strict) |
| Runtime | Bun 1.3+ |
| Monorepo | Bun workspaces + Turborepo |
| Database | Drizzle ORM + Neon serverless Postgres |
| Styling | Tailwind CSS v4 + Protocol theme (emerald/zinc) |
| Dark mode | next-themes (system preference sync) |
| Server state | TanStack Query |
| Client state | Zustand |
| Validation | Zod |
| UI components | Radix primitives + CVA + Storybook 10 |
| Linting | Biome |
| Testing | Vitest + React Testing Library + Playwright |
| Observability | Sentry + PostHog |
| CI/CD | GitHub Actions + Claude Code review |

## UI Components

The `packages/ui/` library includes Protocol-themed components:

- **Button** — 7 variants (default, secondary, filled, outline, text, destructive, ghost)
- **Card** — with Header, Title, Description, Content, Footer
- **Input** — 3 sizes (sm, default, lg)
- **Tag** — 5 colors (emerald, sky, amber, rose, zinc) x 2 variants
- **Prose** — Typography wrapper for long-form content
- **GridPattern** — Decorative SVG grid pattern
- **HeroPattern** — Gradient hero background with grid overlay

Run `bun run storybook` to browse all components.

## Environment Variables

Copy `.env.example` to `apps/web/.env.local` (the setup script does this automatically).

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon Postgres connection string |
| `SESSION_SECRET` | No | HMAC key for session cookies |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Sentry error tracking |
| `SENTRY_AUTH_TOKEN` | No | Sentry source maps (CI) |
| `NEXT_PUBLIC_POSTHOG_KEY` | No | PostHog analytics |
| `NEXT_PUBLIC_POSTHOG_HOST` | No | PostHog API host (defaults to us.i.posthog.com) |
| `ANTHROPIC_API_KEY` | No | Claude Code review on PRs |
| `TURBO_TOKEN` | No | Turborepo remote cache |
| `TURBO_TEAM` | No | Vercel team for remote cache |

Optional services (Sentry, PostHog) degrade gracefully when keys are missing.

## AI Agent Workflow

This template includes a structured workflow for AI-assisted development:

1. **PRD** — Product requirement document (`guidelines/docs/prd.md`)
2. **SPEC** — Technical specification (`guidelines/docs/spec.md`)
3. **Tasks** — Decomposed into actionable items
4. **Implement** — TDD with colocated tests

See `guidelines/workflow.md` for the full process and `guidelines/roles/` for role-specific guides.

## Deploy

Push to `main` for automatic Vercel deployment. The CI pipeline runs lint, format check, typecheck, tests, and build on every push and PR. Claude Code automatically reviews PRs when `ANTHROPIC_API_KEY` is configured.

## Prerequisites

- [Bun](https://bun.sh/) 1.3+
- [Node.js](https://nodejs.org/) 20.19+
- [Vercel CLI](https://vercel.com/cli) (optional, for setup)
- [Neon CLI](https://neon.tech/docs/reference/neon-cli) (optional, for setup)
- [jq](https://jqlang.github.io/jq/) (required if using Neon setup step)
