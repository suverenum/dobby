import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	reactCompiler: true,
	serverExternalPackages: ["import-in-the-middle", "require-in-the-middle"],
	transpilePackages: ["@template/ui", "@template/utils"],
};

export default withSentryConfig(nextConfig, {
	silent: !process.env.CI,
	bundleSizeOptimizations: {
		excludeDebugStatements: true,
	},
	sourcemaps: {
		disable: !process.env.SENTRY_AUTH_TOKEN,
	},
});
