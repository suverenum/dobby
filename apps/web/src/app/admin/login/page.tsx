"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";

export default function AdminLoginPage() {
	const router = useRouter();
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError("");
		setLoading(true);

		try {
			const res = await fetch("/api/admin/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			});

			if (res.ok) {
				router.push("/admin/jobs");
			} else {
				const data = await res.json();
				setError(data.error || "Login failed");
			}
		} catch {
			setError("Network error");
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="flex min-h-svh items-center justify-center p-6 md:p-10">
			<div className="w-full max-w-sm">
				<Card>
					<CardHeader className="text-center">
						<CardTitle className="text-2xl">Dobby</CardTitle>
						<CardDescription>Enter your password to access the admin panel</CardDescription>
					</CardHeader>
					<CardContent>
						<form onSubmit={handleSubmit} className="grid gap-4">
							<div className="grid gap-2">
								<Label htmlFor="password">Password</Label>
								<Input
									id="password"
									type="password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									placeholder="Enter admin password"
									required
								/>
							</div>
							{error && <p className="text-destructive text-sm">{error}</p>}
							<Button type="submit" className="w-full" disabled={loading}>
								{loading ? "Signing in..." : "Sign in"}
							</Button>
						</form>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
