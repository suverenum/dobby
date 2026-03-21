export default function NotFound() {
	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
			<h1 className="text-4xl font-bold">404</h1>
			<p className="text-lg text-gray-600">Page not found.</p>
			<a href="/" className="text-blue-600 underline hover:text-blue-800">
				Go home
			</a>
		</main>
	);
}
