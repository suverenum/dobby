import * as Sentry from "@sentry/nextjs";

export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
		if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
			Sentry.init({
				dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
				tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
			});
		}
	}
}

export const onRequestError = Sentry.captureRequestError;
