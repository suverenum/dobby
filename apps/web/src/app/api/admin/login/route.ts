import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { getEnv } from "../../../../lib/env";
import { createAdminSession } from "../../../../lib/session";

const loginSchema = z.object({
	password: z.string().min(1, "Password is required"),
});

export async function POST(request: Request) {
	const env = getEnv();
	const passwordHash = env.DOBBY_ADMIN_PASSWORD_HASH;

	if (!passwordHash) {
		return NextResponse.json({ error: "Admin login is not configured" }, { status: 503 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = loginSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: "Password is required" }, { status: 400 });
	}

	const { password } = parsed.data;
	const match = await bcrypt.compare(password, passwordHash);

	if (!match) {
		return NextResponse.json({ error: "Invalid password" }, { status: 401 });
	}

	await createAdminSession();

	return NextResponse.json({ success: true });
}
