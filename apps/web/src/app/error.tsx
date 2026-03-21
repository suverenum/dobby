"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function ErrorPage({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		Sentry.captureException(error);
	}, [error]);
	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
			<h1 className="text-4xl font-bold">Something went wrong</h1>
			<p className="text-lg text-gray-600">An unexpected error occurred. Please try again.</p>
			<button
				type="button"
				onClick={reset}
				className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
			>
				Try again
			</button>
		</main>
	);
}
