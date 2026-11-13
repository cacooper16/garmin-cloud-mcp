/**
 * Prompt templates: one-click starters in clients that support MCP prompts
 * (e.g. Claude's connector menu). Each names the cheapest tool calls for the
 * job, so a common question costs one or two small calls instead of an
 * exploration.
 *
 * PROMPTS is the single source of truth for both the server and the Claude
 * Desktop extension's manifest (scripts/sync-manifest-prompts.mjs copies it
 * into mcpb/manifest.json). Claude Desktop checks every prompt the extension
 * serves against the manifest's `text`, after substituting
 * `${arguments.name}`, and rejects any difference. So templates are plain
 * text with placeholders, rendered by renderTemplate() with Claude Desktop's
 * exact rule: no defaults, no conditionals. Arguments are required, so the
 * placeholder is always filled in.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface PromptDef {
	name: string;
	title: string;
	description: string;
	arguments: { name: string; description: string }[];
	/** Placeholders are ${arguments.<name>}. No leading or trailing whitespace. */
	template: string;
}

const PERIOD_ARG = {
	name: "period",
	description:
		"The time span, in your own words or as a named period: e.g. last 30 days, last_90_days, this_month, last_month, this_year.",
};
const PERIOD_RULE =
	"Use the closest named period (last_7_days, last_28_days, last_30_days, last_90_days, last_180_days, last_365_days, this_week, last_week, this_month, last_month, this_year, last_year), or start_date/end_date if none fits.";

export const PROMPTS: PromptDef[] = [
	{
		name: "readiness_check",
		title: "Am I ready to train today?",
		description: "Recovery check from last night's sleep, HRV, resting HR, Body Battery and recent training load.",
		arguments: [],
		template:
			"Am I ready to train hard today? Call get_readiness once (date 'today'). " +
			"Compare last night against my own recent averages, call out anything unusual in HRV, resting HR, sleep or training load, " +
			"and finish with a one-line recommendation (hard / moderate / easy / rest) and why. Keep it short.",
	},
	{
		name: "sleep_report",
		title: "Sleep report",
		description: "Sleep duration, stages, score and consistency over a period, with weekday patterns.",
		arguments: [PERIOD_ARG],
		template:
			"Give me a sleep report for this period: ${arguments.period}. " +
			`${PERIOD_RULE} ` +
			"Call summarize_wellness with include ['sleep','hrv'] twice: group_by 'week' for the trend and group_by 'weekday' for patterns. " +
			"Cover average duration vs need, deep/REM, sleep score, consistency, any weekday pattern, and two or three practical suggestions.",
	},
	{
		name: "training_review",
		title: "Training review",
		description: "Volume, pace, intensity distribution and load trend for a sport over a period.",
		arguments: [
			PERIOD_ARG,
			{ name: "activity_type", description: "The sport, e.g. running, cycling or swimming, or 'all' for every sport." },
		],
		template:
			"Review my training over this period: ${arguments.period}. Sport: ${arguments.activity_type}. " +
			`${PERIOD_RULE} ` +
			"Call summarize_activities with group_by 'week', with activity_type set to that sport's Garmin type key (e.g. running, cycling), or no activity_type if the sport is 'all'. " +
			"Cover volume and consistency, pace trend, time in HR zones (how much is easy vs hard), the load trend (weekly change and acute:chronic ratio), and the longest/fastest efforts. " +
			"Use search_activities with sort_by only if you need to name a specific session.",
	},
	{
		name: "weekly_checkin",
		title: "Weekly check-in",
		description: "This week vs last week: training, sleep, stress and recovery.",
		arguments: [],
		template:
			"Give me a weekly check-in. Call summarize_activities with period 'last_28_days' and group_by 'week', " +
			"and summarize_wellness with period 'last_28_days' and group_by 'week'. " +
			"Compare the latest week with the previous ones: training volume and load, sleep, resting HR, HRV, stress. " +
			"Highlight what improved, what slipped, and one focus for next week.",
	},
	{
		name: "compare_recent",
		title: "Compare recent sessions",
		description: "Side-by-side comparison of my most recent sessions of one type.",
		arguments: [{ name: "activity_type", description: "The sport, e.g. running or cycling." }],
		template:
			"Compare my most recent sessions of this sport: ${arguments.activity_type}. " +
			"Call search_activities with activity_type set to that sport's Garmin type key (e.g. running) and limit 5, " +
			"then compare_activities on the ones of similar distance. Show pace, HR, cadence and training effect side by side and say what changed.",
	},
];

/**
 * Fills ${arguments.<name>} exactly as Claude Desktop does when it checks a
 * prompt: a supplied argument becomes its value ("" if undefined); a missing
 * one leaves the placeholder as it is.
 */
export function renderTemplate(template: string, args: Record<string, unknown>): string {
	return template.replace(/\$\{arguments\.(\w+)\}/g, (match, name: string) =>
		name in args ? (args[name] === undefined ? "" : String(args[name])) : match,
	);
}

export function registerGarminPrompts(server: McpServer) {
	for (const p of PROMPTS) {
		const meta = { title: p.title, description: p.description };
		const render = (args: Record<string, unknown> = {}) => ({
			messages: [{ role: "user" as const, content: { type: "text" as const, text: renderTemplate(p.template, args) } }],
		});
		if (!p.arguments.length) server.registerPrompt(p.name, meta, () => render());
		else {
			const shape = Object.fromEntries(p.arguments.map((a) => [a.name, z.string().describe(a.description)]));
			server.registerPrompt(p.name, { ...meta, argsSchema: z.object(shape) }, (args) => render(args));
		}
	}
}
