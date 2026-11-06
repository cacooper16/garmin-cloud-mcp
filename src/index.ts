import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { GarminClient } from "./garmin.ts";
import { isAllowedUser } from "./allowlist.ts";
import { GitHubHandler, type Props } from "./github-handler.ts";
import { registerGarminPrompts } from "./prompts.ts";
import { registerGarminTools } from "./tools.ts";

function createServer() {
	const server = new McpServer(
		{ name: "garmin", version: "1.0.0" },
		{
			instructions:
				"Read-only access to the user's own Garmin Connect data. Dates are the user's local calendar dates (YYYY-MM-DD). " +
				"Pick the smallest tool that answers the question, usually in one call: " +
				"'how am I / recovered / ready to train / how did I sleep last night' -> get_readiness (defaults to today); " +
				"trends in sleep, resting HR, HRV, stress, steps or Body Battery over weeks or months -> summarize_wellness (set include to just the sources needed); " +
				"training totals, distances, paces or trends -> summarize_activities; " +
				"weekday patterns -> group_by 'weekday'; " +
				"specific workouts, longest or fastest -> search_activities (sort_by), then get_activity for one or compare_activities for 2-5; " +
				"day-by-day values for a short range -> get_daily_summaries, get_sleep_summaries, get_hrv_summaries. " +
				"Prefer period (e.g. last_30_days, this_month, last_week) and 'today'/'yesterday' over computing dates: they resolve in the user's time zone. " +
				"Tools return compact, readable fields by default; only pass detail='full' when a needed field is missing. Long ranges are split automatically, so don't chunk them yourself. " +
				"SCOPE: these tools are the complete Garmin Personal API. It covers daily summaries, sleep, HRV, Body Battery, stress, heart rate, steps, SpO2, fitness age, weight and weight goals, hydration, nutrition, menstrual cycle, profile/HR zones and recorded activities (summary and detail). " +
				"It does NOT include golf scorecards or shot data, Garmin's own training status/readiness score, training plans, race predictions, VO2 max history, personal records, courses, gear, badges, challenges, or social data. " +
				"If the user asks about any of those, say the Garmin Personal API doesn't provide it, offer what the available tools can show instead, and do not call tools hoping to find it.",
		},
	);

	// One client per request; the bearer token cache lives at module/KV level.
	let client: GarminClient | undefined;
	registerGarminTools(server, () => {
		client ??= new GarminClient({ apiKey: env.GARMIN_API_KEY, kv: env.OAUTH_KV, cacheResponses: true });
		return client;
	});
	registerGarminPrompts(server);
	return server;
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
