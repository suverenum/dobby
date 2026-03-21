import { Button } from "@template/ui";
import { ThemeToggle } from "../components/theme-toggle";

export default function Home() {
	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
			<div className="absolute right-4 top-4">
				<ThemeToggle />
			</div>
			<h1 className="text-4xl font-bold text-zinc-900 dark:text-white">Template App</h1>
			<p className="text-lg text-zinc-600 dark:text-zinc-400">
				Your project is ready. Start building.
			</p>
			<div className="flex gap-3">
				<Button>Get Started</Button>
				<Button variant="secondary">Learn More</Button>
			</div>
		</main>
	);
}
