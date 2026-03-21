import { requireAdminSession } from "../../../lib/session";

export default async function AdminJobsPage() {
	await requireAdminSession();

	return (
		<div className="p-8">
			<h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Jobs</h1>
			<p className="mt-2 text-zinc-500">Job list coming soon.</p>
		</div>
	);
}
