# Technical Specification: Real-time Admin UI Updates

## 1. Meta Information

- **Branch:** `feat/realtime-admin`
- **Epic:** TBD
- **PRD:** N/A (admin UX improvement)

## 2. Context

The admin UI requires a manual page refresh to see job status changes. When a job transitions from `provisioning` → `executing` → `completed`, the admin must reload the page to see the new status. This makes it impossible to monitor jobs in real-time. The log viewer already streams in real-time via SSE, but the rest of the page is static.

## 3. Key Technical Drivers

- **Real-time feedback:** Job status, duration, cost, and PR URL should update live without page refresh
- **Minimal complexity:** Use existing infrastructure (TanStack Query is wired up but unused)
- **Server Component compatibility:** Keep Server Components for initial render (SEO, fast TTFB), add client-side polling for updates
- **No WebSocket overhead:** Polling every few seconds is sufficient for job status — it changes infrequently

## 4. Current State

### 4.1. Job List Page (`/admin/jobs`)

- Server Component, direct Drizzle queries
- Filter via `router.push()` (full server re-render)
- No polling, no revalidation
- Shows stale data until navigation

### 4.2. Job Detail Page (`/admin/jobs/[id]`)

- Server Component, single Drizzle query
- Log viewer streams via SSE (real-time)
- Stop button does `router.refresh()` after action
- Status, duration, cost, PR URL are all static after initial render

### 4.3. TanStack Query

- Set up in `providers.tsx` with `PersistQueryClientProvider` + IndexedDB persister
- `staleTime: 1 minute`, `gcTime: 24 hours`
- **Zero `useQuery` calls** in the entire codebase — infrastructure exists but is unused

### 4.4. Log Viewer

- Client Component, manual `fetch` + `ReadableStream` consuming SSE
- Polls CloudWatch every 2s, auto-reconnects every 55s
- Already real-time — no changes needed

## 5. Proposed Solution

Add client-side polling via TanStack Query to both the job list and job detail pages. Server Components still handle the initial render. Client Components poll API endpoints for updates and merge fresh data into the UI.

### 5.1. New API Endpoints

#### `GET /api/admin/jobs` — Job list polling endpoint

Returns the same data as the server-rendered page but as JSON.

```ts
// apps/web/src/app/api/admin/jobs/route.ts
export async function GET(request: NextRequest) {
    await requireAdminSession();
    const status = request.nextUrl.searchParams.get("status") ?? "active";

    // Same query as page.tsx
    const [jobRows, activeCount, completedCount] = await Promise.all([...]);

    return NextResponse.json({ jobs: jobRows, activeCount, completedCount });
}
```

#### `GET /api/admin/jobs/[id]` — Job detail polling endpoint

Already exists (`apps/web/src/app/api/admin/jobs/[id]/route.ts`) but only for internal use. Verify it returns all needed fields (status, prUrl, startedAt, finishedAt, costFlops, resumeCount, logStreamName).

### 5.2. Job List — Client Polling Component

New client component that polls the job list and re-renders the table:

```tsx
// apps/web/src/app/admin/jobs/job-list-live.tsx
"use client";

import { useQuery } from "@tanstack/react-query";

interface Props {
    initialJobs: Job[];
    initialCounts: { active: number; completed: number };
    status: string;
}

export function JobListLive({ initialJobs, initialCounts, status }: Props) {
    const { data } = useQuery({
        queryKey: ["admin-jobs", status],
        queryFn: () => fetch(`/api/admin/jobs?status=${status}`).then(r => r.json()),
        initialData: { jobs: initialJobs, activeCount: initialCounts.active, completedCount: initialCounts.completed },
        refetchInterval: 5_000,        // Poll every 5s
        refetchOnWindowFocus: true,
        refetchIntervalInBackground: false, // Stop polling when tab not visible
    });

    return (
        <>
            <JobStatusFilter activeCount={data.activeCount} completedCount={data.completedCount} current={status} />
            <JobTable jobs={data.jobs} />
        </>
    );
}
```

The Server Component page passes initial data as props (SSR), then the client component takes over polling:

```tsx
// In page.tsx:
export default async function AdminJobsPage({ searchParams }) {
    const [jobRows, activeCount, completedCount] = await Promise.all([...]);

    return (
        <JobListLive
            initialJobs={jobRows}
            initialCounts={{ active: activeCount, completed: completedCount }}
            status={statusFilter}
        />
    );
}
```

### 5.3. Job Detail — Client Polling Component

New client component that polls job status and updates the detail view:

```tsx
// apps/web/src/app/admin/jobs/[id]/job-detail-live.tsx
"use client";

import { useQuery } from "@tanstack/react-query";

interface Props {
    initialJob: Job;
}

export function JobDetailLive({ initialJob }: Props) {
    const { data: job } = useQuery({
        queryKey: ["admin-job", initialJob.id],
        queryFn: () => fetch(`/api/admin/jobs/${initialJob.id}`).then(r => r.json()),
        initialData: initialJob,
        refetchInterval: (query) => {
            // Stop polling when job reaches terminal state
            const status = query.state.data?.status;
            if (["completed", "failed", "timed_out", "stopped"].includes(status)) {
                return false;
            }
            return 3_000; // Poll every 3s while active
        },
        refetchOnWindowFocus: true,
    });

    return (
        <>
            <JobHeader job={job} />
            <TimingAndCost job={job} />
            <TaskDescription task={job.task} />
            {/* LogViewer and StopButton remain unchanged */}
        </>
    );
}
```

Key behavior:
- **Polls every 3s** while job is active
- **Stops polling** when job reaches terminal state (completed, failed, timed_out, stopped)
- **Updates in-place:** status badge, duration (live counter), cost, PR URL all update without refresh
- **Initial data** from SSR, no loading state on first render

### 5.4. Live Duration Counter

For active jobs, show a ticking duration counter instead of static text:

```tsx
// apps/web/src/app/admin/jobs/[id]/live-duration.tsx
"use client";

import { useEffect, useState } from "react";

export function LiveDuration({ startedAt, finishedAt }: { startedAt: string | null; finishedAt: string | null }) {
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        if (finishedAt || !startedAt) return;
        const interval = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(interval);
    }, [startedAt, finishedAt]);

    if (!startedAt) return <span>—</span>;
    const end = finishedAt ? new Date(finishedAt).getTime() : now;
    const duration = end - new Date(startedAt).getTime();
    return <span>{formatDuration(duration)}</span>;
}
```

### 5.5. Polling Intervals

| Page | Interval | Condition |
|------|----------|-----------|
| Job list | 5s | Always (while tab visible) |
| Job detail | 3s | While job is active |
| Job detail | stopped | When job reaches terminal state |
| Log viewer | 2s | Unchanged (existing SSE) |

### 5.6. What Updates Live

**Job list page:**
- Job status badges (color changes)
- Job count tabs (active/completed counts)
- New jobs appearing in the list
- Jobs moving between filter tabs

**Job detail page:**
- Status badge
- Duration (live ticking counter for active jobs)
- Finished timestamp (appears when job completes)
- PR URL (appears when PR is created)
- Cost (updates when job completes)
- Stop button (disappears when job reaches terminal state)

### 5.7. No Changes Needed

- **Log viewer** — already real-time via SSE
- **Auth/session** — no changes
- **Server-side rendering** — kept for initial page load
- **TanStack Query setup** — already configured in `providers.tsx`

### 5.8. Pros and Cons

- **Pros:** Real-time updates; uses existing TanStack Query infrastructure; SSR preserved for first render; minimal API surface (reuse existing patterns); stops polling for terminal jobs
- **Cons:** Polling adds load (1 request per 3-5s per open admin tab); not true push (up to 5s delay for list, 3s for detail); each poll re-fetches full job data
- **Alternatives considered:**
  - **SSE for job status:** More complex server-side, Vercel has 60s function timeout, overkill for status updates
  - **WebSocket:** Requires persistent connection infrastructure, not worth it for admin UI
  - **`router.refresh()` on interval:** Simpler but causes full page re-render, no granular control

## 6. Testing Strategy

### 6.1. Unit Tests — `job-list-live.test.tsx`

- Renders initial data without fetch
- After 5s, fetches updated data and re-renders
- Status filter change triggers new query key
- Counts update when polling returns new values
- New job appears in list after poll
- Stops polling when tab not visible (`refetchIntervalInBackground: false`)

### 6.2. Unit Tests — `job-detail-live.test.tsx`

- Renders initial job data without fetch
- Polls every 3s while job is active
- Stops polling when status becomes terminal
- PR URL appears when poll returns it
- Status badge updates on status change
- Cost updates on completion
- Stop button disappears on terminal state

### 6.3. Unit Tests — `live-duration.test.tsx`

- Shows "—" when startedAt is null
- Shows static duration when finishedAt is set
- Ticks every second when active (no finishedAt)
- Stops ticking when finishedAt appears
- Formats correctly: "1m 30s", "1h 5m", etc.

### 6.4. API Tests — `GET /api/admin/jobs`

- Returns job list with counts
- Filters by status parameter
- Requires admin session (401 without)
- Returns correct JSON shape

## 7. Definition of Done

### Universal

- [ ] Tests pass (`bun run test`)
- [ ] TypeScript compiles cleanly (`bun run typecheck`)
- [ ] Linter passes (`bun run lint`)

### Feature-Specific

- [ ] Job list polls every 5s and updates table + counts in-place
- [ ] Job detail polls every 3s while active, stops on terminal
- [ ] Live duration counter ticks every second for active jobs
- [ ] PR URL appears live when created
- [ ] Status badge updates live
- [ ] Stop button disappears on terminal state
- [ ] No unnecessary re-renders (React Query handles this)
- [ ] Polling stops when browser tab is not visible
- [ ] Initial SSR render preserved (no loading flash)
- [ ] TanStack Query `useQuery` used (not hand-rolled polling)

## 8. References

- TanStack Query `refetchInterval`: https://tanstack.com/query/latest/docs/react/guides/query-options
- Current providers setup: `apps/web/src/components/providers.tsx`
- Current job list page: `apps/web/src/app/admin/jobs/page.tsx`
- Current job detail page: `apps/web/src/app/admin/jobs/[id]/page.tsx`
- Current log viewer: `apps/web/src/app/admin/jobs/[id]/log-viewer.tsx`
