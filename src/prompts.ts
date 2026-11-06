/**
 * Prompt templates: one-click starters in clients that support MCP prompts
 * (e.g. Claude's connector menu). Each
 * names the cheapest tool calls for the job, so a common question costs one
 * or two small calls instead of an exploration.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const user = (text: string) => ({
	messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

const PERIOD_HINT =
	"a named period such as last_7_days, last_30_days, last_90_days, this_month, last_month or this_year";

export function registerGarminPrompts(server: McpServer) {
	server.registerPrompt(
		"readiness_check",
		{
			title: "Am I ready to train today?",
			description: "Recovery check from last night's sleep, HRV, resting HR, Body Battery and recent training load.",
		},
		() =>
			user(
				"Am I ready to train hard today? Call get_readiness once (date 'today'). " +
					"Compare last night against my own recent averages, call out anything unusual in HRV, resting HR, sleep or training load, " +
					"and finish with a one-line recommendation (hard / moderate / easy / rest) and why. Keep it short.",
			),
	);

	server.registerPrompt(
		"sleep_report",
		{
			title: "Sleep report",
			description: "Sleep duration, stages, score and consistency over a period, with weekday patterns.",
			argsSchema: z.object({
				period: z.string().optional().describe(`Defaults to last_30_days. Or ${PERIOD_HINT}.`),
			}),
		},
		({ period }) =>
			user(
				`Give me a sleep report for ${period || "last_30_days"}. ` +
					"Call summarize_wellness with include ['sleep','hrv'] twice: group_by 'week' for the trend and group_by 'weekday' for patterns. " +
					"Cover average duration vs need, deep/REM, sleep score, consistency, any weekday pattern, and two or three practical suggestions.",
			),
	);

	server.registerPrompt(
		"training_review",
		{
			title: "Training review",
			description: "Volume, pace, intensity distribution and load trend for a sport over a period.",
			argsSchema: z.object({
				period: z.string().optional().describe(`Defaults to last_90_days. Or ${PERIOD_HINT}.`),
				activity_type: z.string().optional().describe("e.g. running, cycling, swimming. Defaults to all."),
			}),
		},
		({ period, activity_type }) =>
			user(
				`Review my ${activity_type || "training"} over ${period || "last_90_days"}. ` +
					`Call summarize_activities with group_by 'week'${activity_type ? ` and activity_type '${activity_type}'` : ""}. ` +
					"Cover volume and consistency, pace trend, time in HR zones (how much is easy vs hard), training load trend, and the longest/fastest efforts. " +
					"Use search_activities with sort_by only if you need to name a specific session.",
			),
	);

	server.registerPrompt(
		"weekly_checkin",
		{
			title: "Weekly check-in",
			description: "This week vs last week: training, sleep, stress and recovery.",
		},
		() =>
			user(
				"Give me a weekly check-in. Call summarize_activities with period 'last_28_days' and group_by 'week', " +
					"and summarize_wellness with period 'last_28_days' and group_by 'week'. " +
					"Compare the latest week with the previous ones: training volume and load, sleep, resting HR, HRV, stress. " +
					"Highlight what improved, what slipped, and one focus for next week.",
			),
	);

	server.registerPrompt(
		"compare_recent",
		{
			title: "Compare recent sessions",
			description: "Side-by-side comparison of my most recent sessions of one type.",
			argsSchema: z.object({
				activity_type: z.string().optional().describe("e.g. running. Defaults to running."),
			}),
		},
		({ activity_type }) =>
			user(
				`Compare my most recent ${activity_type || "running"} sessions. ` +
					`Call search_activities with activity_type '${activity_type || "running"}' and limit 5, ` +
					"then compare_activities on the ones of similar distance. Show pace, HR, cadence and training effect side by side and say what changed.",
			),
	);
}
