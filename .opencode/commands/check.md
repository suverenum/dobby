---
description: Run lint, typecheck, and tests
agent: build
---

Run the full pre-commit validation suite. Execute these commands sequentially and report any failures:

!`bun run lint`
!`bun run typecheck`
!`bun run test`

If any step fails, focus on the errors and fix them before moving on to the next step.
