import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { compactActivity, type LeadIn, loadTimeline, summarizeActivities, trainingLoadRatio } from "./activities.ts";
import { BEST_EFFORTS, formatAnalysis, type HrZones, loadAnalysis, SECTIONS, type Unit, zonesFromApi } from "./analysis.ts";
import {
	compactActivityDetail,
	compactBodyBattery,
	compactDailySummary,
	compactHeartRate,
	compactSleep,
	compactSpo2,
	dailySummaryRows,
	stripNoise,
} from "./compact.ts";
import { GarminApiError, type GarminClient } from "./garmin.ts";
import { CAVEAT, compareByMeasure, MEASURES, pairRuns, sourcesFor } from "./recovery.ts";
import { type LoadLimits, loadMany, PB_DISTANCES, personalBests, PREDICTION_WINDOW_DAYS, racePredictions } from "./records.ts";
import { PERIODS, type Period, resolvePeriod, todayIn } from "./periods.ts";
import { addDays, daysBetween, mapLimit, mergeChunks, splitRange } from "./ranges.ts";
import { localizeTimes } from "./times.ts";
import { isObj } from "./util.ts";
import { buildReadiness, joinByDate, summarizeWellness } from "./wellness.ts";

/** Longest date range a single call may cover. Split longer questions into chunks. */
export const MAX_RANGE_DAYS = 92;
/** Tool output cap. Some Garmin payloads (intraday HR, sleep epochs) are huge. */
export const MAX_OUTPUT_CHARS = 120_000;
/** summarize_activities returns aggregates only, so it can safely span a year. */
export const MAX_SUMMARY_RANGE_DAYS = 366;
/** Safety cap on activities fetched per 92-day chunk of a summary (10 pages of 100). */
export const MAX_SUMMARY_ACTIVITIES = 1000;
/** Garmin's largest activity-list page. */
const ACTIVITY_PAGE = 100;
/** Activity details barely change once uploaded (a rename at most), so cache them for a day. */
const ACTIVITY_CACHE_TTL = 86_400;
/** Parallel Garmin requests per tool call when a range is split into chunks. */
const FETCH_CONCURRENCY = 4;
const ACTIVITY_LIST = "/activitylist-service/activities/search/activities";
const SETTINGS = "/userprofile-service/userprofile/settings";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;

// ---- input schemas ------------------------------------------------------

const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
	.refine((s) => isRealDate(s), "Not a real calendar date");

const dayOrRelative = z
	.union([isoDate, z.enum(["today", "yesterday"])])
	.describe("YYYY-MM-DD, or 'today' / 'yesterday' (resolved in the user's Garmin time zone).");

const day = z.object({ date: dayOrRelative });

const period = z
	.enum(PERIODS)
	.optional()
	.describe("Named period resolved in the user's time zone (weeks start Monday). Use instead of start_date/end_date.");

const range = z.object({
	period,
	start_date: isoDate.optional().describe("First day, YYYY-MM-DD, inclusive. Required unless period is given."),
	end_date: isoDate
		.optional()
		.describe(`Last day, YYYY-MM-DD, inclusive. Defaults to start_date. Max span ${MAX_RANGE_DAYS} days.`),
});

type DateArgs = { period?: Period; start_date?: string; end_date?: string };

const activityId = z.object({
	activity_id: z
		.string()
		.regex(/^\d+$/, "Numeric activity ID")
		.describe("Garmin activity ID, from search_activities."),
});

// ---- helpers ------------------------------------------------------------

export function isRealDate(s: string): boolean {
	const d = new Date(`${s}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function resolveRange(start: string, end?: string, maxDays = MAX_RANGE_DAYS): [string, string] {
	const e = end ?? start;
	const days = daysBetween(start, e);
	if (days < 0) throw new GarminApiError("end_date is before start_date");
	if (days + 1 > maxDays) {
		throw new GarminApiError(
			`Range is ${days + 1} days; max is ${maxDays}. Split it into smaller calls.`,
		);
	}
	return [start, e];
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function formatResult(data: unknown): ToolResult {
	let text = JSON.stringify(stripNoise(data) ?? null);
	if (text.length > MAX_OUTPUT_CHARS) {
		text =
			text.slice(0, MAX_OUTPUT_CHARS) +
			`\n\n[TRUNCATED: response was ${text.length.toLocaleString()} chars. ` +
			"Narrow the date range, drop detail='full', or use summarize_wellness / summarize_activities instead.]";
	}
	return { content: [{ type: "text", text }] };
}

/** Empty lists are stripped from output, so say "none" explicitly rather than omit the field. */
const orNone = <T,>(list: T[], none: string): T[] | string => (list.length ? list : none);

function errorText(err: unknown): string {
	return err instanceof GarminApiError
		? err.message
		: err instanceof Error && err.name === "TimeoutError"
			? "Garmin did not respond within 30s. Try again or narrow the request."
			: "Unexpected error talking to Garmin.";
}

function formatError(err: unknown): ToolResult {
	const msg = errorText(err);
	// Log the error shape only, never response bodies (health data).
	console.error("tool error:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
	return { content: [{ type: "text", text: msg }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
	try {
		return formatResult(await fn());
	} catch (err) {
		return formatError(err);
	}
}

// ---- tools --------------------------------------------------------------

/** Limits that differ between the local server and the Worker. */
export interface ToolOptions {
	/** get_personal_bests: activity analyses per call (see records.ts). */
	personalBests?: Partial<LoadLimits>;
}

/**
 * Local default: up to 150 activities per call, with no download cap beyond
 * that and a time budget so the call returns before MCP clients give up
 * (their default timeout is about 60s). The Worker passes a lower download
 * cap: Cloudflare limits outbound requests and CPU time per request.
 */
export const PERSONAL_BESTS_LIMITS: LoadLimits = {
	maxActivities: 150,
	maxDownloads: 150,
	timeBudgetMs: 40_000,
	concurrency: 3,
};

export function registerGarminTools(server: McpServer, garmin: () => GarminClient, options: ToolOptions = {}) {
	type Req = { path: string; params?: Record<string, string> };
	type RangeOpts = {
		/** Garmin's own per-call limit for this endpoint; longer ranges are split and fetched in parallel. */
		chunkDays?: number;
		/** Default (compact) shaping, given the user's time zone; detail: "full" skips it. */
		compact?: (payload: unknown, timeZone?: string) => unknown;
	};

	// Profile settings (time zone) are fetched only when a relative date is used, and cached for a day.
	let settingsPromise: Promise<Record<string, unknown>> | undefined;
	const settings = () =>
		(settingsPromise ??= garmin()
			.get(SETTINGS, undefined, { cacheTtl: 86_400 })
			.then((v): Record<string, unknown> => (isObj(v) ? v : {}))
			.catch((): Record<string, unknown> => ({})));
	/** The user's Garmin profile time zone (IANA), for dates and local times. */
	const userTimeZone = async () => {
		const tz = (await settings()).timeZone;
		return typeof tz === "string" ? tz : undefined;
	};
	const userToday = async () => todayIn(await userTimeZone());
	const resolveDay = async (date: string) =>
		date === "today" ? userToday() : date === "yesterday" ? addDays(await userToday(), -1) : date;
	/**
	 * Resolves period or start/end dates. A missing end_date means start_date
	 * (one day), or today when `openEnd` is set: for the summary tools, a bare
	 * start_date reads as "since".
	 */
	const resolveDates = async (
		a: DateArgs,
		maxDays = MAX_RANGE_DAYS,
		opts: { openEnd?: boolean } = {},
	): Promise<[string, string]> => {
		if (a.period) {
			const [s, e] = resolvePeriod(a.period, await userToday());
			return resolveRange(s, e, maxDays);
		}
		if (!a.start_date) throw new GarminApiError("Give either period or start_date.");
		const end = a.end_date ?? (opts.openEnd ? await userToday() : undefined);
		return resolveRange(a.start_date, end, maxDays);
	};

	const detailParam = z
		.enum(["compact", "full"])
		.default("compact")
		.describe("compact (default) keeps the meaningful fields in readable units; full returns Garmin's raw payload.");

	/**
	 * Fetches a range, splitting it to respect Garmin's per-endpoint limit.
	 * A failed chunk doesn't sink the rest: its dates are listed in `failed`.
	 * Only when every chunk fails is the error thrown.
	 */
	const fetchRange = async (
		path: (s: string, e: string) => Req,
		s: string,
		e: string,
		chunkDays = MAX_RANGE_DAYS,
	): Promise<{ data: unknown; failed: string[] }> => {
		const g = garmin();
		const chunks = splitRange(s, e, chunkDays);
		const results = await mapLimit(chunks, FETCH_CONCURRENCY, async ([cs, ce]) => {
			const req = path(cs, ce);
			try {
				return { ok: true as const, value: await g.get(req.path, req.params) };
			} catch (err) {
				return { ok: false as const, err, label: `${cs}..${ce}: ${errorText(err)}` };
			}
		});
		const failed: string[] = [];
		const values: unknown[] = [];
		let firstErr: unknown;
		for (const r of results) {
			if (r.ok) values.push(r.value);
			else {
				firstErr ??= r.err;
				failed.push(r.label);
			}
		}
		if (!values.length && failed.length) throw firstErr;
		return { data: mergeChunks(values), failed };
	};

	/** Pages through the activity list until a short page; `capped` if it stopped at `cap`. */
	const fetchActivities = async (
		g: GarminClient,
		params: Record<string, string | number | undefined>,
		cap = MAX_SUMMARY_ACTIVITIES,
	) => {
		const list: Record<string, unknown>[] = [];
		for (let start = 0; start < cap; start += ACTIVITY_PAGE) {
			const page = await g.get(ACTIVITY_LIST, { ...params, start, limit: ACTIVITY_PAGE });
			if (!Array.isArray(page)) break;
			list.push(...page.filter(isObj));
			if (page.length < ACTIVITY_PAGE) return { list, capped: false };
		}
		return { list, capped: list.length >= cap };
	};

	/** Runs independent fetches; failures become short notes instead of failing the tool. */
	const settle = async <T,>(label: string, p: Promise<T>, unavailable: string[]): Promise<T | undefined> => {
		try {
			return await p;
		} catch (err) {
			unavailable.push(`${label}: ${errorText(err)}`);
			return undefined;
		}
	};

	const rangeTool = (
		name: string,
		title: string,
		description: string,
		path: (s: string, e: string) => Req,
		opts: RangeOpts = {},
	) =>
		server.registerTool(
			name,
			{
				title,
				description,
				inputSchema: opts.compact ? range.extend({ detail: detailParam }) : range,
				annotations: { ...READ_ONLY, title },
			},
			(args: DateArgs & { detail?: "compact" | "full" }) =>
				run(async () => {
					const [s, e] = await resolveDates(args);
					const { data, failed } = await fetchRange(path, s, e, opts.chunkDays);
					// Tools with a compact shape keep detail='full' as Garmin's raw payload;
					// the rest are returned as Garmin sends them, with times made local.
					const shaped =
						opts.compact && args.detail === "full"
							? data
							: opts.compact
								? opts.compact(data, await userTimeZone())
								: localizeTimes(data, undefined, await userTimeZone());
					return failed.length ? { data: shaped, unavailable: failed } : shaped;
				}),
		);

	const dayTool = (
		name: string,
		title: string,
		description: string,
		path: (d: string) => Req,
		compact?: (payload: Record<string, unknown>, timeZone?: string) => unknown,
	) =>
		server.registerTool(
			name,
			{
				title,
				description,
				inputSchema: compact ? day.extend({ detail: detailParam }) : day,
				annotations: { ...READ_ONLY, title },
			},
			(args: { date: string; detail?: "compact" | "full" }) =>
				run(async () => {
					const req = path(await resolveDay(args.date));
					const data = await garmin().get(req.path, req.params);
					if (!compact) return localizeTimes(data, undefined, await userTimeZone());
					return args.detail !== "full" && isObj(data) ? compact(data, await userTimeZone()) : data;
				}),
		);

	const each = (fn: (r: Record<string, unknown>, timeZone?: string) => unknown) => (payload: unknown, timeZone?: string) =>
		Array.isArray(payload) ? payload.filter(isObj).map((r) => fn(r, timeZone)) : payload;

	const DAILY = (s: string, e: string) => ({
		path: "/usersummary-service/v2/dailysummaries",
		params: { startDate: s, endDate: e },
	});
	const SLEEP = (s: string, e: string) => ({
		path: "/sleep-service/sleep/dailySleepSummariesByDate",
		params: { startDate: s, endDate: e },
	});
	const HRV = (s: string, e: string) => ({ path: `/hrv-service/hrv/daily/${s}/${e}` });
	const hrvRows = (p: unknown) =>
		(isObj(p) && Array.isArray(p.hrvSummaries) ? p.hrvSummaries : []).filter(isObj);

	// -- Overview and composite tools (cheapest answers to the common questions)
	server.registerTool(
		"get_readiness",
		{
			title: "Readiness snapshot",
			description:
				"Best first call for 'how recovered am I', 'should I train hard today', 'how did I sleep last night'. " +
				"One compact object: that night's sleep (score, stages, HR, respiration), HRV vs baseline and status, resting HR, Body Battery, " +
				"each compared with the user's previous 7 days; training load (last 7 days vs 28-day weekly average); and activities from the last 3 days. " +
				"Sleep is filed under the date the user woke up, so use 'today' for last night.",
			inputSchema: z.object({ date: dayOrRelative.default("today") }),
			annotations: { ...READ_ONLY, title: "Readiness snapshot" },
		},
		(args) =>
			run(async () => {
				const date = await resolveDay(args.date);
				const from = addDays(date, -7);
				const g = garmin();
				const unavailable: string[] = [];
				const [daily, sleep, hrv, acts] = await Promise.all([
					settle("daily summary", g.get(DAILY(from, date).path, DAILY(from, date).params), unavailable),
					settle("sleep", g.get(SLEEP(from, date).path, SLEEP(from, date).params), unavailable),
					settle("hrv", g.get(HRV(from, date).path), unavailable),
					settle("activities", fetchActivities(g, { startDate: addDays(date, -27), endDate: date }), unavailable),
				]);
				const rows = joinByDate(
					dailySummaryRows(daily),
					Array.isArray(sleep) ? sleep.filter(isObj) : [],
					hrvRows(hrv),
					await userTimeZone(),
				);
				const list = acts?.list ?? [];
				const recentFrom = addDays(date, -2);
				const recent = list
					.filter((a) => String(a.startTimeLocal ?? "").slice(0, 10) >= recentFrom)
					.map(compactActivity);
				return buildReadiness(date, rows, recent, {
					training_load: acts === undefined ? undefined : trainingLoadRatio(list, date),
					unavailable,
				});
			}),
	);

	server.registerTool(
		"summarize_wellness",
		{
			title: "Summarize wellness trends",
			description:
				"Best tool for wellness trends over weeks or months ('has my sleep improved', 'resting HR trend this year', 'stress lately'). " +
				"Returns per-period averages only: steps, resting HR, stress, Body Battery high/low, intensity minutes (totals), respiration, " +
				"sleep hours/deep/REM/score, overnight HRV, with min-max ranges for key metrics and day counts where data is missing. " +
				"group_by='weekday' answers 'which days do I sleep worst / most stressed'. " +
				`Range up to ${MAX_SUMMARY_RANGE_DAYS} days; fetches and aggregates in the server.`,
			inputSchema: z.object({
				period,
				start_date: isoDate.optional().describe("First day, YYYY-MM-DD, inclusive. Required unless period is given."),
				end_date: isoDate.optional().describe("Last day, YYYY-MM-DD, inclusive. Defaults to today."),
				group_by: z.enum(["week", "month", "weekday", "total"]).default("month"),
				include: z
					.array(z.enum(["daily", "sleep", "hrv"]))
					.min(1)
					.default(["daily", "sleep", "hrv"])
					.describe("Data sources to include. Drop ones the question doesn't need for a faster answer."),
			}),
			annotations: { ...READ_ONLY, title: "Summarize wellness trends" },
		},
		(args) =>
			run(async () => {
				const [s, e] = await resolveDates(args, MAX_SUMMARY_RANGE_DAYS, { openEnd: true });
				const want = new Set<string>(args.include);
				const unavailable: string[] = [];
				const source = async (name: string, path: (s: string, e: string) => Req, chunk: number) => {
					if (!want.has(name)) return undefined;
					const r = await settle(name, fetchRange(path, s, e, chunk), unavailable);
					for (const f of r?.failed ?? []) unavailable.push(`${name} ${f}`);
					return r?.data;
				};
				const [daily, sleep, hrv] = await Promise.all([
					source("daily", DAILY, 365),
					source("sleep", SLEEP, 31),
					source("hrv", HRV, MAX_RANGE_DAYS),
				]);
				const rows = joinByDate(
					dailySummaryRows(daily),
					Array.isArray(sleep) ? sleep.filter(isObj) : [],
					hrvRows(hrv),
				);
				return {
					start_date: s,
					end_date: e,
					groups: orNone(summarizeWellness(rows, args.group_by), "no wellness data in this range"),
					unavailable: unavailable.length ? unavailable : undefined,
				};
			}),
	);

	rangeTool(
		"get_daily_summaries",
		"Daily summaries",
		"One flat row per day: steps, distance, floors, calories, resting/min/max HR, intensity minutes, stress, Body Battery, respiration, SpO2, hydration. " +
			"For trends over more than a few weeks use summarize_wellness instead.",
		DAILY,
		{ chunkDays: 365, compact: (p) => dailySummaryRows(p).map(compactDailySummary) },
	);

	server.registerTool(
		"get_profile",
		{
			title: "Profile and HR zones",
			description:
				"User profile settings (units, measurement system, birth year, etc.) and heart-rate zones. Useful context before interpreting training data.",
			annotations: { ...READ_ONLY, title: "Profile and HR zones" },
		},
		() =>
			run(async () => {
				const g = garmin();
				const [settings, heartRateZones] = await Promise.all([
					g.get(SETTINGS, undefined, { cacheTtl: 86_400 }),
					g.get("/biometric-service/heartRateZones/v2"),
				]);
				return { settings, heartRateZones };
			}),
	);

	// -- Sleep and recovery
	rangeTool(
		"get_sleep_summaries",
		"Sleep summaries",
		"Night-by-night sleep over a range, one compact row per night filed under the date the user woke up: start_local/end_local as local 'YYYY-MM-DD HH:MM'; hours of sleep, deep, light, REM and awake (and naps); " +
			"sleep score with its quality and factor ratings; average HR, stress and respiration (avg/low/high); SpO2 average/lowest; sleep need vs baseline in minutes with what drove it " +
			"(training load, e.g. HIGH_ACWR_AND_CHRONIC, HRV, sleep history, naps) and next night's need; Garmin's insights. " +
			"For last night alone use get_readiness or get_sleep; for trends over weeks or months use summarize_wellness. " +
			`Up to ${MAX_RANGE_DAYS} days per call: pass a period (e.g. last_7_days, last_30_days, this_month) or start_date/end_date. detail='full' returns Garmin's raw records.`,
		SLEEP,
		{ chunkDays: 31, compact: each(compactSleep) },
	);
	dayTool(
		"get_sleep",
		"Sleep (one night)",
		"One night's sleep, same compact shape as get_sleep_summaries. Use detail='full' for Garmin's complete record.",
		(d) => ({ path: "/sleep-service/sleep/dailySleep", params: { date: d } }),
		compactSleep,
	);
	rangeTool(
		"get_hrv_summaries",
		"HRV summaries",
		"Daily heart rate variability over a range: overnight average, 5-minute high, 7-day average, baseline band, status.",
		HRV,
	);
	dayTool(
		"get_hrv",
		"HRV detail (one night)",
		"HRV summary plus individual readings for one night, times in local 'YYYY-MM-DD HH:MM'. Use get_hrv_summaries unless the readings themselves matter.",
		(d) => ({ path: `/hrv-service/hrv/${d}` }),
	);
	rangeTool(
		"get_body_battery",
		"Body Battery",
		"Daily Body Battery (Garmin's 0-100 energy estimate) over a range, one compact row per day: charged, drained, highest and lowest; the key readings the Personal API provides, in local time " +
			"(about 6 a day: midnight, overnight peak, morning, afternoon, last); the events that moved it (sleep, activities, stress); and Garmin's end-of-day feedback. Event and feedback times are local too. " +
			"For today's state use get_readiness; for trends over weeks or months use summarize_wellness (Body Battery high/low per period). " +
			`Up to ${MAX_RANGE_DAYS} days per call: pass a period (e.g. last_7_days, last_30_days, this_month) or start_date/end_date. detail='full' returns Garmin's raw report.`,
		(s, e) => ({
			path: "/wellness-service/wellness/bodyBattery/reports/daily",
			params: { startDate: s, endDate: e },
		}),
		{ chunkDays: 31, compact: each(compactBodyBattery) },
	);
	rangeTool(
		"get_stress",
		"Stress",
		"Day-by-day all-day stress over a range, one row per day as Garmin returns it: calendarDate, then values with overallStressLevel (Garmin's 0-100 score) " +
			"and highStressDuration, mediumStressDuration, lowStressDuration and restStressDuration in seconds. " +
			"For trends over weeks or months, or 'which weekday am I most stressed', use summarize_wellness (stress per period, group_by='weekday'); stress during sleep is avg_stress in get_sleep_summaries. " +
			`Up to ${MAX_RANGE_DAYS} days per call: pass a period (e.g. last_7_days, last_30_days, this_month) or start_date/end_date.`,
		(s, e) => ({ path: `/usersummary-service/stats/stress/daily/${s}/${e}` }),
		{ chunkDays: 28 },
	);

	// -- Heart, activity volume, body
	const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
	server.registerTool(
		"get_heart_rate",
		{
			title: "Heart rate (one day)",
			description:
				"Heart rate for one day: resting, min, max, 7-day resting average, and hourly min/avg/max in local time. " +
				"Give from/to (local HH:MM) to also get every ~2-minute reading in that window, e.g. overnight or around a workout. " +
				"detail='full' returns Garmin's raw payload (every reading, large).",
			inputSchema: day.extend({
				from: localTime.optional().describe("Start of a full-resolution window, local HH:MM. Defaults to 00:00 when only 'to' is given."),
				to: localTime.optional().describe("End of the window, local HH:MM, inclusive. Defaults to 23:59 when only 'from' is given."),
				detail: detailParam,
			}),
			annotations: { ...READ_ONLY, title: "Heart rate (one day)" },
		},
		(args) =>
			run(async () => {
				const date = await resolveDay(args.date);
				const data = await garmin().get("/wellness-service/wellness/dailyHeartRate", { date });
				if (args.detail === "full" || !isObj(data)) return data;
				const window = args.from || args.to ? { from: args.from, to: args.to } : undefined;
				if (window?.from && window.to && window.from > window.to) {
					throw new GarminApiError("'from' is after 'to'. For an overnight window, call once per date.");
				}
				return compactHeartRate(data, window, await userTimeZone());
			}),
	);
	rangeTool(
		"get_steps",
		"Steps",
		"Day-by-day steps over a range, one row per day as Garmin returns it: calendarDate, totalSteps, totalDistance (metres) and stepGoal. " +
			"get_daily_summaries has the same steps alongside floors, calories, HR and stress; for weekly or monthly averages over longer spans use summarize_wellness. " +
			`Up to ${MAX_RANGE_DAYS} days per call: pass a period (e.g. last_7_days, last_30_days, this_month) or start_date/end_date.`,
		(s, e) => ({ path: `/usersummary-service/stats/steps/daily/${s}/${e}` }),
		{ chunkDays: 28 },
	);
	rangeTool(
		"get_wellness_activity_summaries",
		"Wellness activity summaries",
		"Garmin's wellness activity summaries over a range: all-day movement records kept apart from recorded workouts, returned as Garmin sends them. " +
			"Often empty; for daily movement use get_daily_summaries or get_steps, and for workouts search_activities or summarize_activities. " +
			`Up to ${MAX_RANGE_DAYS} days per call: pass a period (e.g. last_7_days, last_30_days, this_month) or start_date/end_date.`,
		(s, e) => ({ path: `/wellnessactivity-service/activity/summary/range/${s}/${e}` }),
	);
	dayTool(
		"get_spo2",
		"Pulse Ox (one day)",
		"SpO2 for one day: average, lowest, sleep average, 7-day average and hourly averages, times in local 'YYYY-MM-DD HH:MM'. detail='full' adds every reading and altitude data.",
		(d) => ({ path: `/wellness-service/wellness/daily/spo2acclimation/${d}` }),
		compactSpo2,
	);
	dayTool(
		"get_fitness_age",
		"Fitness age",
		"Garmin's fitness age as of a date: chronologicalAge, fitnessAge (a decimal; round it) and previousFitnessAge, plus the components behind it, " +
			"each with a value and a stale flag: rhr (resting HR), vigorousDaysAvg and vigorousMinutesAvg (weekly averages over numOfWeeksForIm recent weeks), and bmi with its lastMeasurementDate. " +
			"BMI comes from the last weight entry, so it is often old. It changes slowly, so date='today' is usually all you need. This is not VO2 max, which the Personal API doesn't provide.",
		(d) => ({ path: `/fitnessage-service/fitnessage/v2/${d}` }),
	);
	rangeTool(
		"get_weight",
		"Weight",
		"Weight and body composition measurements over a range, from a Garmin smart scale or entered manually in Garmin Connect, returned as Garmin sends them: weights are in grams (74000 = 74 kg); date is the local measurement time, 'YYYY-MM-DD HH:MM'. " +
			"Often empty, since it needs a smart scale or manual entries. When nothing was recorded in the range, the result holds only previousDateWeight, " +
			"the last measurement before it: check its calendarDate before treating it as current. " +
			`Up to ${MAX_RANGE_DAYS} days per call: pass a period (e.g. last_7_days, last_30_days, this_month) or start_date/end_date. For longer histories, make several calls.`,
		(s, e) => ({ path: `/weight-service/weight/range/${s}/${e}`, params: { includeAll: "true" } }),
	);
	rangeTool(
		"get_hydration",
		"Hydration",
		"Water intake the user logged in Garmin Connect, day by day over a range, as Garmin returns it. " +
			"Usually empty: Garmin only records hydration that is logged, so an empty result means nothing was logged, not that the user drank nothing. " +
			"get_daily_summaries also carries hydration_ml per day. " +
			`Up to ${MAX_RANGE_DAYS} days per call: pass a period (e.g. last_7_days, last_30_days, this_month) or start_date/end_date.`,
		(s, e) => ({ path: `/usersummary-service/stats/hydration/daily/${s}/${e}` }),
		{ chunkDays: 31 },
	);

	// -- Activities (recorded workouts)
	const activityFilters = {
		period,
		start_date: isoDate.optional().describe("Only activities on/after this date."),
		end_date: isoDate.optional().describe("Only activities on/before this date."),
		activity_type: z
			.string()
			.regex(/^[a-z_]+$/)
			.optional()
			.describe("Parent type key, e.g. running, cycling, swimming, strength_training, walking, hiking."),
		activity_subtype: z
			.string()
			.regex(/^[a-z_]+$/)
			.optional()
			.describe("Subtype key within activity_type, e.g. trail_running, treadmill_running, road_cycling."),
		event_type: z
			.enum(["race", "training", "recreation", "fitness", "specialEvent", "uncategorized"])
			.optional()
			.describe("Only activities tagged with this event type, e.g. race."),
		min_distance_m: z.number().int().min(0).optional().describe("Minimum distance in metres."),
		max_distance_m: z.number().int().min(0).optional().describe("Maximum distance in metres."),
		name_contains: z.string().trim().min(1).max(100).optional().describe("Text the activity name contains (case-insensitive), e.g. 'parkrun' or 'tempo'."),
		min_duration_min: z.number().min(0).optional().describe("Minimum duration in minutes."),
		max_duration_min: z.number().min(0).optional().describe("Maximum duration in minutes."),
		min_elevation_gain_m: z.number().min(0).optional().describe("Minimum elevation gain in metres."),
		max_elevation_gain_m: z.number().min(0).optional().describe("Maximum elevation gain in metres."),
		exclude_children: z
			.boolean()
			.optional()
			.describe("Hide the legs of multisport activities (e.g. a triathlon's swim/bike/run), keeping the parent."),
		area: z
			.object({
				north: z.number().min(-90).max(90),
				south: z.number().min(-90).max(90),
				west: z.number().min(-180).max(180),
				east: z.number().min(-180).max(180),
			})
			.optional()
			.describe("Only activities that started inside this latitude/longitude box (decimal degrees)."),
	};
	type Filters = {
		period?: Period;
		start_date?: string;
		end_date?: string;
		activity_type?: string;
		activity_subtype?: string;
		event_type?: string;
		min_distance_m?: number;
		max_distance_m?: number;
		name_contains?: string;
		min_duration_min?: number;
		max_duration_min?: number;
		min_elevation_gain_m?: number;
		max_elevation_gain_m?: number;
		exclude_children?: boolean;
		area?: { north: number; south: number; west: number; east: number };
	};
	const secs = (min: number | undefined) => (min === undefined ? undefined : Math.round(min * 60));
	const filterParams = (f: Filters) => ({
		startDate: f.start_date,
		endDate: f.end_date,
		activityType: f.activity_type,
		activitySubType: f.activity_subtype,
		eventType: f.event_type,
		minDistance: f.min_distance_m,
		maxDistance: f.max_distance_m,
		// Verified against the live API: search matches the name, durations are
		// seconds, min/maxElevation filter on elevation gain in metres.
		search: f.name_contains,
		minDuration: secs(f.min_duration_min),
		maxDuration: secs(f.max_duration_min),
		minElevation: f.min_elevation_gain_m,
		maxElevation: f.max_elevation_gain_m,
		excludeChildren: f.exclude_children ? "true" : undefined,
		upperLatitude: f.area?.north,
		lowerLatitude: f.area?.south,
		leftLongitude: f.area?.west,
		rightLongitude: f.area?.east,
	});

	server.registerTool(
		"search_activities",
		{
			title: "Search activities",
			description:
				"List individual recorded activities (runs, rides, swims, strength, etc.) with the activity_id needed for get_activity and get_activity_analysis. " +
				"Filter by date, type, race, distance, duration, elevation gain, name text or a lat/long box. " +
				"For totals, averages or trends over weeks/months, use summarize_activities instead: it is far smaller. " +
				"Default detail='compact' returns key stats only (startTimeLocal as local 'YYYY-MM-DD HH:MM', distance m, duration/movingDuration s, averageSpeed/maxSpeed m/s, HR, elevation, calories, cadence, power, training effect). " +
				"Use detail='full' only when a field you need is missing, and with a small limit. " +
				"Sport-specific extras such as golf scorecards, shot data or dive logs are NOT available.",
			inputSchema: z.object({
				...activityFilters,
				sort_by: z
					.enum(["startLocal", "distance", "duration", "averageSpeed", "elevationGain"])
					.default("startLocal")
					.describe("Sort field. Use distance or averageSpeed to find longest or fastest."),
				sort_order: z.enum(["desc", "asc"]).default("desc"),
				detail: z.enum(["compact", "full"]).default("compact"),
				limit: z.number().int().min(1).max(100).default(20).describe("Max results (1-100)."),
				start: z.number().int().min(0).default(0).describe("Offset for paging."),
			}),
			annotations: { ...READ_ONLY, title: "Search activities" },
		},
		(args) =>
			run(async () => {
				const dates = args.period ? await resolveDates(args, 100_000) : undefined;
				const list = await garmin().get(ACTIVITY_LIST, {
					...filterParams(dates ? { ...args, start_date: dates[0], end_date: dates[1] } : args),
					sortBy: args.sort_by,
					sortOrder: args.sort_order,
					start: args.start,
					limit: args.limit,
				});
				if (args.detail === "full" || !Array.isArray(list)) return list;
				return list.map((a) => compactActivity(a as Record<string, unknown>));
			}),
	);

	server.registerTool(
		"summarize_activities",
		{
			title: "Summarize activities",
			description:
				"Best tool for activity totals and trends (e.g. 'how far did I run each month', 'has my pace improved'). " +
				"Fetches every matching activity in the range and returns only aggregates per period and type: count, distance (km and mi), moving time, elevation, longest, " +
				"average speed and pace (distance-weighted), fastest average pace, average HR, training load, and time in HR zones 1-5 (minutes and %, for zone 2 / 80-20 questions). " +
				"With group_by 'week' or 'month' it also returns load_trend: load per period, % change vs the previous period, and the acute:chronic ratio at the end of each, " +
				"with flags for a ratio above 1.3 or a rise over 30%. Use group_by='week' for 'am I building too fast / ramping up too quickly', " +
				"and for 'compare this block with my last one' (e.g. last_90_days by week, or two ranges). " +
				`Range up to ${MAX_SUMMARY_RANGE_DAYS} days.`,
			inputSchema: z.object({
				...activityFilters,
				start_date: isoDate.optional().describe("First day, YYYY-MM-DD, inclusive. Required unless period is given."),
				end_date: isoDate.optional().describe("Last day, YYYY-MM-DD, inclusive. Defaults to today."),
				group_by: z.enum(["week", "month", "weekday", "total"]).default("month"),
			}),
			annotations: { ...READ_ONLY, title: "Summarize activities" },
		},
		(args) =>
			run(async () => {
				const [s, e] = await resolveDates(args, MAX_SUMMARY_RANGE_DAYS, { openEnd: true });
				const g = garmin();
				// Split into 92-day chunks fetched in parallel (a year is one round of
				// four), paging within a chunk only when it holds 100+ activities.
				const unavailable: string[] = [];
				const timeline = args.group_by === "week" || args.group_by === "month" ? args.group_by : undefined;
				// The load trend needs the 28 days before the range, so the first
				// period's acute:chronic ratio has a full chronic window.
				const leadInFetch = timeline
					? fetchActivities(g, filterParams({ ...args, start_date: addDays(s, -28), end_date: addDays(s, -1) })).catch(() => undefined)
					: undefined;
				const parts = await mapLimit(splitRange(s, e, MAX_RANGE_DAYS), FETCH_CONCURRENCY, ([cs, ce]) =>
					settle(`${cs}..${ce}`, fetchActivities(g, filterParams({ ...args, start_date: cs, end_date: ce })), unavailable),
				);
				if (parts.every((p) => p === undefined)) throw new GarminApiError(unavailable.join("; "));
				const all = parts.flatMap((p) => p?.list ?? []);
				const leadIn = await leadInFetch;
				const leadInState: LeadIn = !leadIn ? "unavailable" : leadIn.list.length ? "ok" : "empty";
				return {
					start_date: s,
					end_date: e,
					activities: all.length,
					...(parts.some((p) => p?.capped) && {
						note: `Stopped at ${MAX_SUMMARY_ACTIVITIES} activities in a 92-day stretch; narrow the range or filter by type for complete totals.`,
					}),
					groups: orNone(summarizeActivities(all, args.group_by), "no matching activities in this range"),
					load_trend: timeline ? loadTimeline([...(leadIn?.list ?? []), ...all], s, e, timeline, leadInState) : undefined,
					unavailable: unavailable.length ? unavailable : undefined,
				};
			}),
	);

	/** km or mile: the explicit choice, else the user's Garmin unit setting. */
	const unitFor = async (unit?: Unit): Promise<Unit> => {
		// Garmin's measurementSystem is "metric", "statute_us" or "statute_uk" (miles).
		const system = (await settings()).measurementSystem;
		return unit ?? (typeof system === "string" && system.startsWith("statute") ? "mile" : "km");
	};

	const pbLimits: LoadLimits = { ...PERSONAL_BESTS_LIMITS, ...options.personalBests };
	server.registerTool(
		"get_personal_bests",
		{
			title: "Personal bests and race estimates",
			description:
				"Fastest 1 km, 1 mile, 5 km, 10 km, half and marathon across many activities, each with date, activity, pace, avg HR and the next two best efforts; " +
				"plus race time estimates for 5 km to marathon from the last 90 days of the range: your actual time where you ran the distance, otherwise Riegel from the effort closest in distance. " +
				"Use for 'what's my 5k PB', 'fastest half this year', 'what could I run a 10k in'. " +
				"These are computed from the user's activity files (fastest continuous stretch within each run), NOT Garmin's official personal records, which the Personal API doesn't provide; " +
				"estimates are estimates, not Garmin's race predictor. " +
				`Analyses the newest ${pbLimits.maxActivities} matching activities per call. The first call over a long range is slow (each activity's file is downloaded once, then cached). ` +
				"The result starts with complete. If complete is false (the fields are then named provisional_*), the bests are NOT final: call again with the same arguments " +
				"(it continues from the cache) until complete is true, or tell the user the results are partial. Defaults to the last 365 days and running.",
			inputSchema: z.object({
				period,
				start_date: isoDate.optional().describe("First day, YYYY-MM-DD, inclusive. Defaults to 365 days ago."),
				end_date: isoDate.optional().describe("Last day, YYYY-MM-DD, inclusive. Defaults to today."),
				activity_type: z
					.string()
					.regex(/^[a-z_]+$/)
					.default("running")
					.describe("Parent type key, e.g. running (includes trail and treadmill), walking, hiking."),
				distances: z
					.array(z.enum(PB_DISTANCES))
					.min(1)
					.optional()
					.describe("Distances to report. Defaults to all six."),
				unit: z.enum(["km", "mile"]).optional().describe("Pace unit. Defaults to the user's Garmin unit setting."),
			}),
			annotations: { ...READ_ONLY, title: "Personal bests and race estimates" },
		},
		(args) =>
			run(async () => {
				const [s, e] =
					args.period || args.start_date
						? await resolveDates(args, 100_000, { openEnd: true })
						: resolvePeriod("last_365_days", await userToday());
				const distances = args.distances ?? PB_DISTANCES;
				const g = garmin();
				const { list, capped } = await fetchActivities(g, {
					...filterParams({ activity_type: args.activity_type, start_date: s, end_date: e }),
					sortBy: "startLocal",
					sortOrder: "desc",
				});
				// Only activities long enough for a requested distance (or a race
				// estimate) are worth a download; manual entries have no file.
				const shortest = Math.min(...distances.map((d) => BEST_EFFORTS.find(([l]) => l === d)![1]), 3000);
				let manual = 0;
				const eligible = list
					.filter((a) => {
						if (a.manualActivity === true) return (manual++, false);
						return (typeof a.distance === "number" ? a.distance : 0) >= shortest - 1;
					})
					.sort((a, b) => String(b.startTimeLocal ?? "").localeCompare(String(a.startTimeLocal ?? "")));
				const chosen = eligible.slice(0, pbLimits.maxActivities);
				const loaded = await loadMany(g, chosen, pbLimits, { describe: errorText });
				const unit = await unitFor(args.unit);
				const predictFrom = addDays(e, -(PREDICTION_WINDOW_DAYS - 1));

				// Partial results must never read as final: say so first, and rename
				// the result fields, until every chosen activity has been analysed.
				const complete = !loaded.deferred && !loaded.rateLimited;
				const what = args.activity_type === "running" ? "runs" : `${args.activity_type} activities`;
				const status = complete
					? undefined
					: `Partial: ${loaded.runs.length} of ${chosen.length} ${what} analysed so far` +
						(loaded.rateLimited
							? " (Garmin rate-limited the file downloads). Wait a minute, then call again before answering; "
							: ". Call again to continue (finished analyses are cached) before answering; ") +
						"these are not the final bests.";
				const notes: string[] = [];
				if (eligible.length > chosen.length || capped) {
					notes.push(
						`${capped ? "Over 1000" : eligible.length} matching activities; analysed the newest ${chosen.length} (back to ${chosen.at(-1)?.startTimeLocal?.toString().slice(0, 10)}). ` +
							"For older records, ask about a shorter or earlier range.",
					);
				}
				const noFile = manual + loaded.noFile;
				if (noFile) notes.push(`${noFile} activities skipped: no FIT file (manual entries or GPX/TCX imports).`);
				if (loaded.failed) notes.push(`${loaded.failed} activities couldn't be read: ${loaded.firstError}`);

				const bests = loaded.runs.length
					? personalBests(loaded.runs, distances, unit)
					: complete
						? `no ${args.activity_type} activities with a FIT file in this range`
						: "none analysed yet";
				const estimates = {
					note:
						`From efforts since ${predictFrom}. basis 'actual': you ran that distance, so your best time there is shown. ` +
						"basis 'riegel': estimated (T2 = T1 x (D2/D1)^1.06) from your fastest effort at the closest distance you ran, within 4x. Estimates, not Garmin's race predictor.",
					estimates: racePredictions(loaded.runs, predictFrom, unit),
				};
				// Key order is output order: completeness first.
				return {
					complete,
					status,
					start_date: s,
					end_date: e,
					activity_type: args.activity_type,
					activities_analysed: loaded.runs.length,
					activities_to_analyse: chosen.length,
					...(complete
						? { personal_bests: bests, race_estimates: estimates }
						: { provisional_personal_bests: bests, provisional_race_estimates: estimates }),
					source: "computed from your activity files, not Garmin's official records",
					notes: notes.length ? notes : undefined,
				};
			}),
	);

	server.registerTool(
		"analyze_recovery_impact",
		{
			title: "Recovery vs running performance",
			description:
				"Does sleep, HRV or Body Battery relate to how the user runs? Pairs each run with the night before it (sleep score, hours slept, overnight HRV) and that morning's Body Battery, " +
				"then compares runs after the best third of nights with runs after the worst third at the same heart rate: it fits the user's own speed-for-HR line across the runs " +
				"and scores each run by how much faster or slower it was than expected for its HR, so easy and hard runs compare fairly. Returns each group's average HR and pace, " +
				"the difference in s/km (or s/mi) at the same HR, and a correlation, called meaningful only at |r| >= 0.3 with 8+ runs per group. " +
				"Warns when the groups' average HR differs by over 8 bpm (different kinds of runs). Races, runs under 20 minutes and manual entries are left out. " +
				"Use for 'does poor sleep hurt my running', 'do I run better when my HRV is high'. Says when there's too little data to conclude; correlation, not proof. " +
				`Defaults to the last 180 days and running; range up to ${MAX_SUMMARY_RANGE_DAYS} days.`,
			inputSchema: z.object({
				period,
				start_date: isoDate.optional().describe("First day, YYYY-MM-DD, inclusive. Defaults to 180 days ago."),
				end_date: isoDate.optional().describe("Last day, YYYY-MM-DD, inclusive. Defaults to today."),
				activity_type: z
					.string()
					.regex(/^[a-z_]+$/)
					.default("running")
					.describe("Parent type key, e.g. running, cycling, walking."),
				measure: z
					.enum([...MEASURES, "all"])
					.default("all")
					.describe("Recovery measure to compare by; 'all' does each. Pick one for a faster answer."),
				unit: z.enum(["km", "mile"]).optional().describe("Pace unit. Defaults to the user's Garmin unit setting."),
			}),
			annotations: { ...READ_ONLY, title: "Recovery vs running performance" },
		},
		(args) =>
			run(async () => {
				const [s, e] =
					args.period || args.start_date
						? await resolveDates(args, MAX_SUMMARY_RANGE_DAYS, { openEnd: true })
						: resolvePeriod("last_180_days", await userToday());
				const measures = args.measure === "all" ? [...MEASURES] : [args.measure];
				const want = sourcesFor(measures);
				const g = garmin();
				const unavailable: string[] = [];
				const source = async (name: "daily" | "sleep" | "hrv", path: (s: string, e: string) => Req, chunk: number) => {
					if (!want.has(name)) return undefined;
					const r = await settle(name, fetchRange(path, s, e, chunk), unavailable);
					for (const f of r?.failed ?? []) unavailable.push(`${name} ${f}`);
					return r?.data;
				};
				const [parts, daily, sleep, hrv] = await Promise.all([
					mapLimit(splitRange(s, e, MAX_RANGE_DAYS), FETCH_CONCURRENCY, ([cs, ce]) =>
						settle(`activities ${cs}..${ce}`, fetchActivities(g, filterParams({ activity_type: args.activity_type, start_date: cs, end_date: ce })), unavailable),
					),
					source("daily", DAILY, 365),
					source("sleep", SLEEP, 31),
					source("hrv", HRV, MAX_RANGE_DAYS),
				]);
				if (parts.every((p) => p === undefined)) throw new GarminApiError(unavailable.join("; "));
				const rows = joinByDate(dailySummaryRows(daily), Array.isArray(sleep) ? sleep.filter(isObj) : [], hrvRows(hrv));
				const { runs, excluded } = pairRuns(parts.flatMap((p) => p?.list ?? []), rows);
				const unit = await unitFor(args.unit);
				return {
					start_date: s,
					end_date: e,
					activity_type: args.activity_type,
					runs_compared: runs.length,
					excluded: Object.values(excluded).some(Boolean) ? excluded : undefined,
					results: measures.map((m) => compareByMeasure(runs, m, unit)),
					caveat: CAVEAT,
					unavailable: unavailable.length ? unavailable : undefined,
				};
			}),
	);

	const ACTIVITY = (id: string) => `/activity-service/activity/${id}`;
	server.registerTool(
		"get_activity",
		{
			title: "Activity detail",
			description:
				"One activity in detail: distance, times, pace (per km and mile), speed, HR, cadence, running dynamics, power, training effect and load, temperature, RPE/feel, and split summaries (warm-up/active/cool-down totals, not per-km; use get_activity_analysis for km/mile splits and laps). " +
				"detail='full' returns Garmin's raw record (200+ fields).",
			inputSchema: activityId.extend({ detail: detailParam }),
			annotations: { ...READ_ONLY, title: "Activity detail" },
		},
		({ activity_id, detail }) =>
			run(async () => {
				const a = await garmin().get(ACTIVITY(activity_id), undefined, { cacheTtl: ACTIVITY_CACHE_TTL });
				return detail === "full" || !isObj(a) ? a : compactActivityDetail(a);
			}),
	);

	server.registerTool(
		"compare_activities",
		{
			title: "Compare activities",
			description:
				"Side-by-side compact detail for 2-5 activities (same fields as get_activity), fetched in parallel. " +
				"Use for 'compare my last two long runs' or 'how did this race compare with last year's'; get the IDs from search_activities.",
			inputSchema: z.object({
				activity_ids: z
					.array(z.string().regex(/^\d+$/, "Numeric activity ID"))
					.min(2)
					.max(5)
					.describe("2-5 Garmin activity IDs."),
			}),
			annotations: { ...READ_ONLY, title: "Compare activities" },
		},
		({ activity_ids }) =>
			run(async () => {
				const g = garmin();
				const unavailable: string[] = [];
				const rows = await Promise.all(
					activity_ids.map((id) =>
						settle(`activity ${id}`, g.get(ACTIVITY(id), undefined, { cacheTtl: ACTIVITY_CACHE_TTL }), unavailable),
					),
				);
				if (rows.every((r) => r === undefined)) throw new GarminApiError(unavailable.join("; "));
				return {
					activities: rows.filter(isObj).map(compactActivityDetail),
					unavailable: unavailable.length ? unavailable : undefined,
				};
			}),
	);

	server.registerTool(
		"get_activity_workouts",
		{
			title: "Activity workouts",
			description:
				"The planned workout linked to one recorded activity, if any: workoutName, sport and steps, each with intensity, durationType/durationValue (metres for DISTANCE) " +
				"and a target (e.g. targetType SPEED with targetValueLow/High in m/s). An activity started from one of Garmin's daily suggested workouts may carry only a workoutPhrase " +
				"(e.g. EASY_WEEK_LOAD_BASE); an empty result means no workout was linked. " +
				"This is the plan; for how each rep actually went use get_activity_analysis (laps). Get the ID from search_activities.",
			inputSchema: activityId,
			annotations: { ...READ_ONLY, title: "Activity workouts" },
		},
		({ activity_id }) =>
			run(async () => localizeTimes(await garmin().get(`${ACTIVITY(activity_id)}/workouts`), undefined, await userTimeZone())),
	);

	server.registerTool(
		"get_activity_analysis",
		{
			title: "Activity analysis (splits, laps, best efforts)",
			description:
				"Per-km or per-mile splits, the watch's laps / workout reps, best efforts, time in HR zones and first-vs-second-half drift for ONE recorded activity, " +
				"computed from Garmin's original FIT file. Use for 'my km splits', 'did I negative split', 'fastest 5 km in this run', 'how long in zone 2', 'did my HR drift'. " +
				"splits: one row per km/mile (time, pace, cumulative time, avg/max HR, cadence, power, elevation gain/loss), timer time so pauses don't count, final partial split labelled with its distance. " +
				"laps: the watch's own laps with intensity (warmup/active/cooldown/rest) and trigger (manual, distance, ...). " +
				"best_efforts: fastest continuous 1 km, 1 mile, 5 km, 10 km, half and marathon the activity is long enough for, with where each started. " +
				"hr_zones: time in each HR zone, as the watch recorded it with the zones in effect then (matches Garmin Connect and summarize_activities). drift: first vs second half pace, HR and aerobic decoupling. " +
				"Get the ID from search_activities. Manual entries and GPX/TCX imports return a short 'unavailable' note.",
			inputSchema: activityId.extend({
				include: z
					.array(z.enum(SECTIONS))
					.min(1)
					.default([...SECTIONS])
					.describe("Sections to return. Drop ones the question doesn't need for a shorter answer."),
				unit: z
					.enum(["km", "mile"])
					.optional()
					.describe("Split length and pace unit. Defaults to the user's Garmin unit setting."),
			}),
			annotations: { ...READ_ONLY, title: "Activity analysis" },
		},
		({ activity_id, include, unit }) =>
			run(async () => {
				const g = garmin();
				const loaded = await loadAnalysis(g, activity_id);
				if ("unavailable" in loaded) return { activity_id, unavailable: loaded.unavailable };
				const a = loaded.analysis;
				const resolvedUnit = await unitFor(unit);
				let zones: HrZones | undefined;
				let zonesUnavailable: string | undefined;
				// Current zones are only needed when the FIT file didn't record its own.
				if (include.includes("hr_zones") && a.hasHr && !a.recordedZones) {
					try {
						zones = zonesFromApi(
							await g.get("/biometric-service/heartRateZones/v2", undefined, { cacheTtl: 86_400 }),
							a.sport,
						);
					} catch (err) {
						zonesUnavailable = errorText(err);
					}
				}
				return { activity_id, ...formatAnalysis(a, { unit: resolvedUnit, include, zones, zonesUnavailable }) };
			}),
	);

	// -- Nutrition, goals, women's health
	dayTool(
		"get_nutrition",
		"Nutrition (one day)",
		"Food log for one day: nutrition goals, calories and nutrients consumed, and per-meal breakdown.",
		(d) => ({ path: `/nutrition-service/food/logs/${d}`, params: { includeMedia: "false" } }),
	);
	rangeTool(
		"get_weight_goals",
		"Weight goals",
		"The weight goal the user set in Garmin Connect that was in effect over a range, with its goal range, returned as Garmin sends it. " +
			"Empty ({}) when no weight goal is set, which is common. Pair with get_weight to track progress. " +
			`Up to ${MAX_RANGE_DAYS} days per call: pass a period (e.g. last_7_days, last_30_days, this_month) or start_date/end_date.`,
		(s, e) => ({ path: `/goal-service/goal/user/effective/weightgoal/${s}/${e}` }),
	);
	server.registerTool(
		"get_menstrual_cycle",
		{
			title: "Menstrual cycle (one day)",
			description:
				"Menstrual cycle tracking as of one date, in two parts returned as Garmin sends them: summary (Garmin's cycle summary for that date) and dayView (Garmin's day view for that date, with anything logged). " +
				"Empty unless the user tracks their cycle in Garmin Connect. date accepts YYYY-MM-DD, 'today' or 'yesterday'; call once per date.",
			inputSchema: day,
			annotations: { ...READ_ONLY, title: "Menstrual cycle (one day)" },
		},
		(args) =>
			run(async () => {
				const date = await resolveDay(args.date);
				const g = garmin();
				const [summary, dayView] = await Promise.all([
					g.get(`/periodichealth-service/menstrualcycle/summary/${date}`),
					g.get(`/periodichealth-service/menstrualcycle/dayview/${date}`, { reducedResponse: "true" }),
				]);
				return localizeTimes({ summary, dayView }, undefined, await userTimeZone());
			}),
	);

	// No raw-path escape hatch on purpose: these tools cover every endpoint in
	// Garmin's Personal API Swagger spec, so a generic GET only invited the model to
	// guess at endpoints that don't exist (golf, training status, etc.). The binary
	// /download-service/files/activity/{id} is read only by get_activity_analysis.
	// Omitted from the spec's 26 paths: /usersummary-service/usersummary/daily (same
	// data as get_daily_summaries) and /weight-service/weight/all (same as get_weight).
}
