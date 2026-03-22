import { redirect } from "next/navigation";
import { validateAdminSession } from "../lib/session";

export default async function Home() {
	const isAuthenticated = await validateAdminSession();
	redirect(isAuthenticated ? "/admin/jobs" : "/admin/login");
}
