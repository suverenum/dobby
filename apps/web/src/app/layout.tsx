import type { Metadata } from "next";
import { Providers } from "../components/providers";
import "./globals.css";

export const metadata: Metadata = {
	title: "Template App",
	description: "A boilerplate Next.js application",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className="h-full" suppressHydrationWarning>
			<body className="flex min-h-full bg-white antialiased dark:bg-zinc-900">
				<Providers>
					<div className="w-full">{children}</div>
				</Providers>
			</body>
		</html>
	);
}
