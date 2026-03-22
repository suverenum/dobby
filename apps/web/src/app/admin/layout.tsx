import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { clearAdminSession, validateAdminSession } from "../../lib/session";

async function logout() {
	"use server";
	await clearAdminSession();
	redirect("/admin/login");
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
	const isAuthenticated = await validateAdminSession();

	if (!isAuthenticated) {
		return <>{children}</>;
	}

	return (
		<div className="flex min-h-svh flex-col">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b">
				<div className="flex w-full items-center justify-between px-4 lg:px-6">
					<h1 className="text-base font-medium">Dobby</h1>
					<form action={logout}>
						<Button variant="ghost" size="sm" type="submit" className="cursor-pointer">
							Logout
						</Button>
					</form>
				</div>
			</header>
			<div className="flex flex-1 flex-col">{children}</div>
		</div>
	);
}
