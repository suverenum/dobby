"use client";

import { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
	type PersistedClient,
	type Persister,
	PersistQueryClientProvider,
} from "@tanstack/react-query-persist-client";
import { del, get, set } from "idb-keyval";
import { usePathname, useSearchParams } from "next/navigation";
import { ThemeProvider, useTheme } from "next-themes";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { Suspense, useEffect, useState } from "react";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
if (posthogKey && typeof window !== "undefined" && !posthog.__loaded) {
	posthog.init(posthogKey, {
		api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
		person_profiles: "identified_only",
		capture_pageview: false,
	});
}

const IDB_KEY = "tanstack-query-cache";

const idbPersister: Persister = {
	persistClient: async (client: PersistedClient) => {
		await set(IDB_KEY, client);
	},
	restoreClient: async () => {
		return await get<PersistedClient>(IDB_KEY);
	},
	removeClient: async () => {
		await del(IDB_KEY);
	},
};

function ThemeWatcher() {
	const { resolvedTheme, setTheme } = useTheme();

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");

		function onMediaChange() {
			const systemTheme = media.matches ? "dark" : "light";
			if (resolvedTheme === systemTheme) {
				setTheme("system");
			}
		}

		onMediaChange();
		media.addEventListener("change", onMediaChange);
		return () => media.removeEventListener("change", onMediaChange);
	}, [resolvedTheme, setTheme]);

	return null;
}

function PostHogPageview() {
	const pathname = usePathname();
	const searchParams = useSearchParams();

	// biome-ignore lint/correctness/useExhaustiveDependencies: searchParams triggers re-capture on query-only navigations
	useEffect(() => {
		if (pathname && posthog) {
			// Send pathname only — avoid leaking sensitive query params (OAuth codes,
			// magic-link tokens, invite params) to PostHog. Projects that need query
			// param attribution can opt in by appending searchParams here.
			const url = window.location.origin + pathname;
			posthog.capture("$pageview", { $current_url: url });
		}
	}, [pathname, searchParams]);

	return null;
}

function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: 1000 * 60 * 60 * 24,
				staleTime: 1000 * 60,
			},
		},
	});
}

export function Providers({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(makeQueryClient);

	const content = (
		<ThemeProvider attribute="class" disableTransitionOnChange>
			<ThemeWatcher />
			<PersistQueryClientProvider client={queryClient} persistOptions={{ persister: idbPersister }}>
				{children}
				{process.env.NODE_ENV === "development" && <ReactQueryDevtools initialIsOpen={false} />}
			</PersistQueryClientProvider>
		</ThemeProvider>
	);

	if (posthogKey) {
		return (
			<PostHogProvider client={posthog}>
				<Suspense fallback={null}>
					<PostHogPageview />
				</Suspense>
				{content}
			</PostHogProvider>
		);
	}

	return content;
}
