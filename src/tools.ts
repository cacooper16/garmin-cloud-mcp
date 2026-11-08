import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { compactActivity, summarizeActivities, trainingLoadRatio } from "./activities.ts";
import { formatAnalysis, type HrZones, loadAnalysis, SECTIONS, type Unit, zonesFromApi } from "./analysis.ts";
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
import { PERIODS, type Period, resolvePeriod, todayIn } from "./periods.ts";
import { addDays, daysBetween, mapLimit, mergeChunks, splitRange } from "./ranges.ts";
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

export function registerGarminTools(server: McpServer, garmin: () => GarminClient) {
	type Req = { path: string; params?: Record<string, string> };
	type RangeOpts = {
		/** Garmin's own per-call limit for this endpoint; longer ranges are split and fetched in parallel. */
		chunkDays?: number;
		/** Default (compact) shaping; detail: "full" skips it. */
		compact?: (payload: unknown) => unknown;
	};

	// Profile settings (time zone) are fetched only when a relative date is used, and cached for a day.
	let settingsPromise: Promise<Record<string, unknown>> | undefined;
	const settings = () =>
		(settingsPromise ??= garmin()
			.get(SETTINGS, undefined, { cacheTtl: 86_400 })
			.then((v): Record<string, unknown> => (isObj(v) ? v : {}))
			.catch((): Record<string, unknown> => ({})));
	const userToday = async () => {
		const tz = (await settings()).timeZone;
		return todayIn(typeof tz === "string" ? tz : undefined);
	};
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
					const shaped = opts.compact && args.detail !== "full" ? opts.compact(data) : data;
					return failed.length ? { data: shaped, unavailable: failed } : shaped;
				}),
		);

	const dayTool = (
		name: string,
		title: string,
		description: string,
		path: (d: string) => Req,
		compact?: (payload: Record<string, unknown>) => unknown,
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
					return compact && args.detail !== "full" && isObj(data) ? compact(data) : data;
				}),
		);

	const each = (fn: (r: Record<string, unknown>) => unknown) => (payload: unknown) =>
		Array.isArray(payload) ? payload.filter(isObj).map(fn) : payload;

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
		"Nightly sleep over a range, one row per night: hours of sleep/deep/light/REM/awake, sleep score and factor ratings, insights, HR, stress, respiration (avg/low/high), SpO2, " +
			"sleep need vs baseline with what drove it (training load, e.g. HIGH_ACWR_AND_CHRONIC, HRV, sleep history, naps) and next night's need.",
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
		"HRV summary plus individual readings for one night. Use get_hrv_summaries unless the readings themselves matter.",
		(d) => ({ path: `/hrv-service/hrv/${d}` }),
	);
	rangeTool(
		"get_body_battery",
		"Body Battery",
		"Daily Body Battery over a range: charged, drained, highest, lowest, Garmin's key readings for the day in local time (about 6: midnight, overnight peak, morning, afternoon, last), and the events that moved it (sleep, activities, stress).",
		(s, e) => ({
			path: "/wellness-service/wellness/bodyBattery/reports/daily",
			params: { startDate: s, endDate: e },
		}),
		{ chunkDays: 31, compact: each(compactBodyBattery) },
	);
	rangeTool(
		"get_stress",
		"Stress",
		"Daily stress over a range: overall level and time in high/medium/low/rest stress (seconds).",
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
				return compactHeartRate(data, window);
			}),
	);
	rangeTool(
		"get_steps",
		"Steps",
		"Daily step totals, distance and goals over a range.",
		(s, e) => ({ path: `/usersummary-service/stats/steps/daily/${s}/${e}` }),
		{ chunkDays: 28 },
	);
	rangeTool(
		"get_wellness_activity_summaries",
		"Wellness activity summaries",
		"Wellness activity summaries over a range (all-day movement, as opposed to recorded workouts).",
		(s, e) => ({ path: `/wellnessactivity-service/activity/summary/range/${s}/${e}` }),
	);
	dayTool(
		"get_spo2",
		"Pulse Ox (one day)",
		"SpO2 for one day: average, lowest, sleep average, 7-day average and hourly averages. detail='full' adds every reading and altitude data.",
		(d) => ({ path: `/wellness-service/wellness/daily/spo2acclimation/${d}` }),
		compactSpo2,
	);
	dayTool(
		"get_fitness_age",
		"Fitness age",
		"Fitness age and the factors behind it, as of a date.",
		(d) => ({ path: `/fitnessage-service/fitnessage/v2/${d}` }),
	);
	rangeTool(
		"get_weight",
		"Weight",
		"All weight and body composition measurements over a range.",
		(s, e) => ({ path: `/weight-service/weight/range/${s}/${e}`, params: { includeAll: "true" } }),
	);
	rangeTool(
		"get_hydration",
		"Hydration",
		"Daily hydration logs over a range.",
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
	};
	const filterParams = (f: Filters) => ({
		startDate: f.start_date,
		endDate: f.end_date,
		activityType: f.activity_type,
		activitySubType: f.activity_subtype,
		eventType: f.event_type,
		minDistance: f.min_distance_m,
		maxDistance: f.max_distance_m,
	});

	server.registerTool(
		"search_activities",
		{
			title: "Search activities",
			description:
				"List individual recorded activities (runs, rides, swims, strength, etc.) with the activity_id needed for get_activity. " +
				"For totals, averages or trends over weeks/months, use summarize_activities instead: it is far smaller. " +
				"Default detail='compact' returns key stats only (distance m, duration/movingDuration s, averageSpeed/maxSpeed m/s, HR, elevation, calories, cadence, power, training effect). " +
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
				const parts = await mapLimit(splitRange(s, e, MAX_RANGE_DAYS), FETCH_CONCURRENCY, ([cs, ce]) =>
					settle(`${cs}..${ce}`, fetchActivities(g, filterParams({ ...args, start_date: cs, end_date: ce })), unavailable),
				);
				if (parts.every((p) => p === undefined)) throw new GarminApiError(unavailable.join("; "));
				const all = parts.flatMap((p) => p?.list ?? []);
				return {
					start_date: s,
					end_date: e,
					activities: all.length,
					...(parts.some((p) => p?.capped) && {
						note: `Stopped at ${MAX_SUMMARY_ACTIVITIES} activities in a 92-day stretch; narrow the range or filter by type for complete totals.`,
					}),
					groups: orNone(summarizeActivities(all, args.group_by), "no matching activities in this range"),
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
			description: "Structured workouts linked to one activity, if any.",
			inputSchema: activityId,
			annotations: { ...READ_ONLY, title: "Activity workouts" },
		},
		({ activity_id }) =>
			run(() => garmin().get(`${ACTIVITY(activity_id)}/workouts`)),
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
				"hr_zones: time in each of the user's HR zones. drift: first vs second half pace, HR and aerobic decoupling. " +
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
				// Garmin's measurementSystem is "metric", "statute_us" or "statute_uk" (miles).
				const system = (await settings()).measurementSystem;
				const resolvedUnit: Unit = unit ?? (typeof system === "string" && system.startsWith("statute") ? "mile" : "km");
				let zones: HrZones | undefined;
				let zonesUnavailable: string | undefined;
				if (include.includes("hr_zones") && a.hasHr) {
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
		"The user's effective weight goals and goal ranges over a date range.",
		(s, e) => ({ path: `/goal-service/goal/user/effective/weightgoal/${s}/${e}` }),
	);
	server.registerTool(
		"get_menstrual_cycle",
		{
			title: "Menstrual cycle (one day)",
			description:
				"Menstrual cycle summary plus that day's logged data (symptoms, flow, mood) and predictions, as of a date.",
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
				return { summary, dayView };
			}),
	);

	// No raw-path escape hatch on purpose: these tools cover every endpoint in
	// Garmin's Personal API Swagger spec, so a generic GET only invited the model to
	// guess at endpoints that don't exist (golf, training status, etc.). The binary
	// /download-service/files/activity/{id} is read only by get_activity_analysis.
	// Omitted from the spec's 26 paths: /usersummary-service/usersummary/daily (same
	// data as get_daily_summaries) and /weight-service/weight/all (same as get_weight).
}
