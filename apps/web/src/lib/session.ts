import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const SESSION_COOKIE_NAME = "dobby_admin_session";
const SESSION_MAX_AGE = 60 * 60 * 24; // 24 hours in seconds

/**
 * Create a signed session token using HMAC-SHA256.
 * The token format is: payload.signature
 */
async function sign(payload: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	const sigHex = Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${payload}.${sigHex}`;
}

/**
 * Verify a signed session token and return the payload if valid.
 */
async function verify(token: string, secret: string): Promise<string | null> {
	const lastDot = token.lastIndexOf(".");
	if (lastDot === -1) return null;

	const payload = token.slice(0, lastDot);
	const expectedToken = await sign(payload, secret);
	if (token !== expectedToken) return null;

	return payload;
}

function getSessionSecret(): string {
	const secret = process.env.SESSION_SECRET;
	if (!secret || secret.length < 16) {
		throw new Error("SESSION_SECRET must be set and at least 16 characters");
	}
	return secret;
}

/**
 * Set the admin session cookie after successful login.
 */
export async function createAdminSession(): Promise<void> {
	const secret = getSessionSecret();
	const payload = JSON.stringify({
		role: "admin",
		iat: Math.floor(Date.now() / 1000),
	});
	const token = await sign(payload, secret);

	const cookieStore = await cookies();
	cookieStore.set(SESSION_COOKIE_NAME, token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		maxAge: SESSION_MAX_AGE,
		path: "/",
	});
}

/**
 * Validate the admin session cookie. Returns true if session is valid.
 */
export async function validateAdminSession(): Promise<boolean> {
	let secret: string;
	try {
		secret = getSessionSecret();
	} catch {
		return false;
	}

	const cookieStore = await cookies();
	const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
	if (!sessionCookie?.value) return false;

	const payload = await verify(sessionCookie.value, secret);
	if (!payload) return false;

	try {
		const data = JSON.parse(payload);
		if (data.role !== "admin") return false;

		// Check expiration
		const age = Math.floor(Date.now() / 1000) - data.iat;
		if (age > SESSION_MAX_AGE) return false;

		return true;
	} catch {
		return false;
	}
}

/**
 * Require admin session — redirects to login if not authenticated.
 * Use in server components / layouts.
 */
export async function requireAdminSession(): Promise<void> {
	const valid = await validateAdminSession();
	if (!valid) {
		redirect("/admin/login");
	}
}

/**
 * Clear the admin session cookie (logout).
 */
export async function clearAdminSession(): Promise<void> {
	const cookieStore = await cookies();
	cookieStore.delete(SESSION_COOKIE_NAME);
}
