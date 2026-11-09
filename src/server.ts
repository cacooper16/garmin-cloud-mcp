// The MCP server itself: tools, prompts and instructions. Shared by the
// Cloudflare Worker (src/index.ts) and the local stdio entrypoint
// (src/stdio.ts), so keep this file free of Worker-only imports.
import { McpServer } from "@modelcontextprotocol/server";
import type { GarminClient } from "./garmin.ts";
import { registerGarminPrompts } from "./prompts.ts";
import { registerGarminTools } from "./tools.ts";

/** Reported to clients as serverInfo.version. Must match package.json (test/version.test.ts). */
export const SERVER_VERSION = "1.2.0";

const INSTRUCTIONS =
	"Read-only access to the user's own Garmin Connect data. Dates are the user's local calendar dates (YYYY-MM-DD). " +
	"Pick the smallest tool that answers the question, usually in one call: " +
	"'how am I / recovered / ready to train / how did I sleep last night' -> get_readiness (defaults to today); " +
	"trends in sleep, resting HR, HRV, stress, steps or Body Battery over weeks or months -> summarize_wellness (set include to just the sources needed); " +
	"training totals, distances, paces or trends -> summarize_activities; " +
	"weekday patterns -> group_by 'weekday'; " +
	"specific workouts, longest or fastest -> search_activities (sort_by), then get_activity for one or compare_activities for 2-5; " +
	"per-km or per-mile splits, laps or interval reps, fastest 1 km/5 km/10 km within a run, time in HR zones or HR drift for one activity -> get_activity_analysis (get_activity's splitSummaries are only warm-up/active/cool-down totals, not km splits); " +
	"day-by-day values for a short range -> get_daily_summaries, get_sleep_summaries, get_hrv_summaries. " +
	"Prefer period (e.g. last_30_days, this_month, last_week) and 'today'/'yesterday' over computing dates: they resolve in the user's time zone. " +
	"Tools return compact, readable fields by default; only pass detail='full' when a needed field is missing. Long ranges are split automatically, so don't chunk them yourself. " +
	"SCOPE: these tools are the complete Garmin Personal API. It covers daily summaries, sleep, HRV, Body Battery, stress, heart rate, steps, SpO2, fitness age, weight and weight goals, hydration, nutrition, menstrual cycle, profile/HR zones and recorded activities (summary, detail, and splits/laps/best efforts/HR zones from the activity file). " +
	"It does NOT include golf scorecards or shot data, Garmin's own training status/readiness score, training plans, race predictions, VO2 max history, Garmin's all-time personal records (best efforts within one activity ARE available via get_activity_analysis), courses, gear, badges, challenges, or social data. " +
	"If the user asks about any of those, say the Garmin Personal API doesn't provide it, offer what the available tools can show instead, and do not call tools hoping to find it.";

/**
 * Builds the Garmin MCP server. `makeClient` is called lazily, on the first
 * tool call, so listing tools and prompts never needs a real API key.
 */
export function createGarminServer(makeClient: () => GarminClient): McpServer {
	const server = new McpServer({ name: "garmin", version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

	let client: GarminClient | undefined;
	registerGarminTools(server, () => {
		client ??= makeClient();
		return client;
	});
	registerGarminPrompts(server);
	return server;
}
