# Product Improvement Building Workflow

This document outlines the steps to build product improvements.

## Workflow Steps

### 1. Create Branch

Create a git branch for the feature. Create a spec folder in `/specs/{branch}/` for long-form documents.

### 2. Prepare Product Requirement Document (PRD)

- **Responsible**: Product Manager (Agent)
- **Task**: Write a Product Requirement Document following the [strict PRD format](docs/prd.md) within the spec folder. Name file `requirements.md`.
- **Gate**: User reviews and approves PRD

### 3. Prepare Technical Specification (SPEC)

- **Responsible**: Software Architect (Agent)
- **Task**: Document technical implementation details, system architecture, and engineering design within the spec folder following [strict SPEC format](docs/spec.md). Name file `spec.md`.
- **Gate**: User reviews and approves SPEC

### 4. Decompose into Tasks

- **Responsible**: Engineering / Project Manager (Agent)
- **Task**: Decompose the PRD and SPEC into actionable tasks with dependencies. Each task gets a discipline prefix (FE:, BE:, TST:, QA:, INFR:) and design context.
- **Gate**: User reviews task breakdown

### 5. Implement Code

- **Responsible**: Software Engineer (Agent)
- **Task**: Execute tasks following the PRD (requirements), SPEC (technical decisions), and individual task design context.
- **Coverage target**: 90% line coverage for all new/changed code.
- **Methodology**:
  - `test-driven-development` — RED-GREEN-REFACTOR cycle for all code changes
  - `verification-before-completion` — evidence before closing any task

### 6. Write and Execute Tests

- **Responsible**: Software Engineer in Test (Agent)
- **Task**: Develop test cases, write automated tests, and verify the implementation meets acceptance criteria.
- **Coverage**: Run `bun run test` and verify coverage on new/changed files.

### 7. Close Feature

- **Responsible**: Engineering / Project Manager (Agent)
- **Task**: Verify all tasks closed, open PR, ensure CI is green.
