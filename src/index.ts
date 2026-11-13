import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { GarminClient } from "./garmin.ts";
import { isAllowedUser } from "./allowlist.ts";
import { GitHubHandler, type Props } from "./github-handler.ts";
import { createGarminServer } from "./server.ts";

/**
 * get_personal_bests downloads one FIT file per uncached activity. Cloudflare's
 * free plan allows 50 outbound requests per request (and little CPU), so the
 * Worker downloads at most this many per call; the rest come on the next call.
 */
const WORKER_MAX_DOWNLOADS_PER_CALL = 15;

// One server (and Garmin client) per request; the bearer token cache lives at module/KV level.
function createServer() {
	return createGarminServer(
		() => new GarminClient({ apiKey: env.GARMIN_API_KEY, kv: env.OAUTH_KV, cacheResponses: true }),
		{ personalBests: { maxDownloads: WORKER_MAX_DOWNLOADS_PER_CALL } },
	);
}

const mcpHandler = createMcpHandler(createServer);

const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		// Defence in depth: tokens are only ever issued to the allowed user, but
		// re-check on every call in case ALLOWED_GITHUB_USER_ID is changed later.
		// The OAuth provider decrypts the token's props onto ctx.props before calling us.
		const props = (ctx as ExecutionContext & { props?: Props }).props;
		if (!isAllowedUser(props?.githubId, bindings.ALLOWED_GITHUB_USER_ID)) {
			return new Response("Forbidden", { status: 403 });
		}
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

export default new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	tokenEndpoint: "/token",
	defaultHandler: GitHubHandler as unknown as ExportedHandler<Env>,
	resourceMetadata: { resource: env.MCP_RESOURCE },
});
