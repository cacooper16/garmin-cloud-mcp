/**
 * OAuth front door. The MCP client (Claude, ChatGPT, ...) is sent here to authorise; we
 * bounce the browser to GitHub to prove who you are, then only issue an MCP
 * token if the GitHub account matches ALLOWED_GITHUB_USER_ID.
 *
 * Adapted from Cloudflare's remote-mcp-github-oauth demo, with two changes:
 *   1. The allowlist check happens at login, so nobody else ever gets a token
 *      (the demo let any GitHub user in and only gated individual tools).
 *   2. We don't keep the GitHub access token; we only needed it to learn who
 *      you are.
 */
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { isAllowedUser } from "./allowlist.ts";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils.ts";

/** Stored (encrypted) on each MCP token; available to tool handlers. */
export type Props = {
	githubId: number;
	login: string;
};

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.text("Garmin MCP server. Connect your MCP client (Claude, ChatGPT, Cursor, ...) to /mcp.", 200));

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) return c.text("Invalid request", 400);

	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie } = await bindStateToSession(stateToken);
		return redirectToGithub(c.req.raw, c.env, stateToken, { "Set-Cookie": setCookie });
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();
	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			name: "Garmin MCP",
			description:
				"Read-only access to your Garmin Connect health and activity data. You'll sign in with GitHub to prove it's you.",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();
		const { clearCookie: clearCsrfCookie } = validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}
		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch {
			return c.text("Invalid state data", 400);
		}
		if (!state.oauthReqInfo?.clientId) return c.text("Invalid request", 400);

		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionCookie } = await bindStateToSession(stateToken);

		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionCookie);
		headers.append("Set-Cookie", clearCsrfCookie); // CSRF tokens are one-time use
		return redirectToGithub(c.req.raw, c.env, stateToken, headers);
	} catch (error) {
		if (error instanceof OAuthError) return error.toResponse();
		console.error("POST /authorize error:", error instanceof Error ? error.message : error);
		return c.text("Internal server error", 500);
	}
});

app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;
	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error) {
		if (error instanceof OAuthError) return error.toResponse();
		return c.text("Internal server error", 500);
	}
	if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request data", 400);

	const code = c.req.query("code");
	if (!code) return c.text("Missing code", 400);

	// Exchange GitHub's code for a short-lived GitHub token, just to read /user.
	const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			client_id: c.env.GITHUB_CLIENT_ID,
			client_secret: c.env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: new URL("/callback", c.req.url).href,
		}),
	});
	const tokenJson = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
	if (!tokenRes.ok || !tokenJson.access_token) {
		return c.text("GitHub sign-in failed", 502);
	}

	const userRes = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${tokenJson.access_token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "garmin-mcp",
		},
	});
	if (!userRes.ok) return c.text("Could not read GitHub profile", 502);
	const user = (await userRes.json()) as { id: number; login: string };

	// The gate. Everyone except the configured account stops here, token-less.
	if (!isAllowedUser(user.id, c.env.ALLOWED_GITHUB_USER_ID)) {
		console.warn("Rejected login attempt from GitHub user id", user.id);
		return c.text("This server is private.", 403);
	}

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: oauthReqInfo,
		userId: String(user.id),
		metadata: { label: user.login },
		scope: oauthReqInfo.scope,
		props: { githubId: user.id, login: user.login } satisfies Props,
	});

	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);
	return new Response(null, { status: 302, headers });
});

function redirectToGithub(
	request: Request,
	env: Env,
	stateToken: string,
	headers: HeadersInit = {},
): Response {
	const url = new URL("https://github.com/login/oauth/authorize");
	url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	url.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
	url.searchParams.set("scope", ""); // identity only; no repo or email access
	url.searchParams.set("state", stateToken);
	url.searchParams.set("response_type", "code");

	const h = new Headers(headers);
	h.set("Location", url.href);
	return new Response(null, { status: 302, headers: h });
}

export { app as GitHubHandler };
