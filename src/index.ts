import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { GarminClient } from "./garmin.ts";
import { isAllowedUser } from "./allowlist.ts";
import { mcpResource } from "./resource.ts";
import { GitHubHandler, type Props } from "./github-handler.ts";
import { createGarminServer, SERVER_VERSION } from "./server.ts";
import { optedOut, UpdateCheck } from "./update.ts";

/**
 * get_personal_bests downloads one FIT file per uncached activity. Cloudflare's
 * free plan allows 50 outbound requests per request (and little CPU), so the
 * Worker downloads at most this many per call; the rest come on the next call.
 */
const WORKER_MAX_DOWNLOADS_PER_CALL = 15;

/**
 * Update notice (see update.ts): checked at most daily in the background via
 * waitUntil, cached in KV, shown on the first tool result of each day. Off
 * with GARMIN_MCP_NO_UPDATE_CHECK = "1" in wrangler.jsonc's vars.
 */
const update = new UpdateCheck({
	current: SERVER_VERSION,
	install: { type: "cloud" },
	kv: env.OAUTH_KV,
	perDay: true,
	disabled: optedOut((env as Env & { GARMIN_MCP_NO_UPDATE_CHECK?: string }).GARMIN_MCP_NO_UPDATE_CHECK),
});

// One server (and Garmin client) per request; the bearer token cache lives at module/KV level.
function createServer() {
	return createGarminServer(
		() => new GarminClient({ apiKey: env.GARMIN_API_KEY, kv: env.OAUTH_KV, cacheResponses: true }),
		{ personalBests: { maxDownloads: WORKER_MAX_DOWNLOADS_PER_CALL }, update },
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
		// Never delays the response: the check finishes after it, if it runs at all.
		ctx.waitUntil(update.refresh());
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

/** MCP_RESOURCE is optional: older deployments set it in wrangler.jsonc, new ones needn't. */
type Bindings = Env & { MCP_RESOURCE?: string };

/**
 * The OAuth provider takes its resource URL as a fixed option, so keep one
 * per resource. In practice that's one per hostname the Worker answers on
 * (workers.dev, a custom domain), built on first use in each isolate.
 */
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(resource: string): OAuthProvider<Env> {
	let p = providers.get(resource);
	if (!p) {
		p = new OAuthProvider<Env>({
			apiHandler,
			apiRoute: "/mcp",
			authorizeEndpoint: "/authorize",
			clientRegistrationEndpoint: "/register",
			tokenEndpoint: "/token",
			defaultHandler: GitHubHandler as unknown as ExportedHandler<Env>,
			resourceMetadata: { resource },
		});
		providers.set(resource, p);
	}
	return p;
}

export default {
	fetch(request: Request, bindings: Bindings, ctx: ExecutionContext) {
		const resource = mcpResource(request, bindings);
		let provider: OAuthProvider<Env>;
		try {
			provider = providerFor(resource);
		} catch (err) {
			// The provider refuses a resource that isn't HTTPS (or http on localhost).
			console.error("bad MCP resource URL:", resource, err instanceof Error ? err.message : String(err));
			return new Response(
				`This server's URL (${resource}) isn't usable for sign-in: it must be https. If MCP_RESOURCE is set in wrangler.jsonc, check it.`,
				{ status: 500 },
			);
		}
		return provider.fetch(request, bindings, ctx);
	},
} satisfies ExportedHandler<Bindings>;
