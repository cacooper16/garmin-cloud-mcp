/**
 * Personal bests and race estimates across many activities, computed from
 * each activity's FIT analysis (see analysis.ts). The Personal API has no
 * personal records endpoint, so this is the only way to get them.
 *
 * Two parts: loadMany() fetches analyses within per-call limits (cached ones
 * are free; each uncached one is a file download), and personalBests() /
 * racePredictions() are pure functions over what was loaded.
 */

import {
	type Analysis,
	ANALYSIS_VERSION,
	type AnalysisSource,
	analysisCacheName,
	BEST_EFFORTS,
	clock,
	loadAnalysis,
	pace,
	type Unit,
} from "./analysis.ts";
import { mapLimit } from "./ranges.ts";
import type { Raw } from "./util.ts";

export const PB_DISTANCES = BEST_EFFORTS.map(([label]) => label) as [string, ...string[]];
const METRES = new Map(BEST_EFFORTS);

/** Riegel's fatigue exponent. */
export const RIEGEL_EXPONENT = 1.06;
/** Race estimates only from best efforts at least this long (in practice 5 km and up). */
export const MIN_PREDICTION_SOURCE_M = 3000;
/** Never extrapolate more than this multiple of the source distance, up or down. */
export const MAX_PREDICTION_RATIO = 4;
/** Race estimates use efforts from the last this-many days of the range. */
export const PREDICTION_WINDOW_DAYS = 90;
const PREDICT: [string, number][] = BEST_EFFORTS.filter(([, m]) => m >= 5000);

/** One analysed activity. */
export interface RunEntry {
	id: string;
	name?: string;
	/** Local start date, YYYY-MM-DD. */
	date: string;
	analysis: Analysis;
}

// ---- loading ----------------------------------------------------------------

export interface LoadLimits {
	/** Most activities analysed per call, newest first. */
	maxActivities: number;
	/** Most uncached analyses (file downloads) per call. */
	maxDownloads: number;
	/** Stop starting downloads after this long; finished ones are cached for the next call. */
	timeBudgetMs: number;
	concurrency: number;
}

export interface LoadResult {
	runs: RunEntry[];
	/** Activities with no FIT file (manual entries, GPX/TCX imports). */
	noFile: number;
	/** Not analysed this call (download or time limit); a later call continues. */
	deferred: number;
	/** Garmin returned 429; the rest were left. */
	rateLimited: boolean;
	/** Other per-activity failures, with the first reason. */
	failed: number;
	firstError?: string;
	/** Analyses that had to be downloaded this call. */
	downloaded: number;
}

/**
 * Loads analyses for `activities` (already newest first and within the cap).
 * Cached analyses are always used; downloads stop at the per-call limits or
 * at the first 429, and what was done so far is returned.
 */
export async function loadMany(
	src: AnalysisSource,
	activities: Raw[],
	limits: LoadLimits,
	opts: { now?: () => number; describe?: (err: unknown) => string } = {},
): Promise<LoadResult> {
	const now = opts.now ?? Date.now;
	const started = now();
	const out: LoadResult = { runs: [], noFile: 0, deferred: 0, rateLimited: false, failed: 0, downloaded: 0 };
	let downloads = 0;
	const results = await mapLimit(activities, limits.concurrency, async (a): Promise<RunEntry | undefined> => {
		const id = String(a.activityId);
		const entry = (analysis: Analysis): RunEntry => ({
			id,
			name: typeof a.activityName === "string" ? a.activityName : undefined,
			date: String(a.startTimeLocal ?? "").slice(0, 10),
			analysis,
		});
		const cached = await src.getCached<Analysis>(analysisCacheName(id));
		if (cached?.v === ANALYSIS_VERSION) return entry(cached);
		if (out.rateLimited || downloads >= limits.maxDownloads || now() - started > limits.timeBudgetMs) {
			out.deferred++;
			return undefined;
		}
		downloads++;
		try {
			const loaded = await loadAnalysis(src, id);
			if ("unavailable" in loaded) {
				out.noFile++;
				return undefined;
			}
			out.downloaded++;
			return entry(loaded.analysis);
		} catch (err) {
			if ((err as { status?: number }).status === 429) {
				out.rateLimited = true;
				out.deferred++;
			} else {
				out.failed++;
				out.firstError ??= opts.describe?.(err) ?? (err instanceof Error ? err.message : String(err));
			}
			return undefined;
		}
	});
	out.runs = results.filter((r): r is RunEntry => r !== undefined);
	return out;
}

// ---- personal bests ---------------------------------------------------------

interface Candidate {
	time: number;
	date: string;
	id: string;
	name?: string;
	avgHr?: number;
}

/**
 * Fastest effort at each distance across the runs, with the next two. Ties
 * (same time to the second) go to the earlier date, since that one set it.
 */
export function personalBests(runs: RunEntry[], distances: readonly string[], unit: Unit) {
	return distances.map((label) => {
		const metres = METRES.get(label);
		const efforts: Candidate[] = [];
		for (const r of runs) {
			const e = r.analysis.bestEfforts?.find((x) => x.label === label);
			if (e) efforts.push({ time: e.time, date: r.date, id: r.id, name: r.name, avgHr: e.avgHr });
		}
		if (!metres || !efforts.length) return { distance: label, best: "no activity in this range covered it" };
		efforts.sort((a, b) => Math.round(a.time) - Math.round(b.time) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
		const [best, ...rest] = efforts as [Candidate, ...Candidate[]];
		const tied = rest.filter((x) => Math.round(x.time) === Math.round(best.time)).length;
		return {
			distance: label,
			time: clock(best.time),
			pace: pace(metres, best.time, unit),
			date: best.date,
			activity: best.name,
			activity_id: best.id,
			avg_hr: best.avgHr === undefined ? undefined : Math.round(best.avgHr),
			...(tied ? { tied_by: tied } : {}),
			next: rest.slice(0, 2).map((x) => ({ time: clock(x.time), date: x.date, activity_id: x.id })),
		};
	});
}

// ---- race predictions ---------------------------------------------------------

/** Riegel: T2 = T1 × (D2/D1)^1.06. */
export function riegel(t1: number, d1: number, d2: number): number {
	return t1 * (d2 / d1) ** RIEGEL_EXPONENT;
}

interface Source {
	metres: number;
	time: number;
	label: string;
	date: string;
	id: string;
}

/** Two sources count as equally close to a race when their log-distance gaps differ by less than this (~10%). */
const CLOSE = Math.log(1.1);

/**
 * Race estimates for 5 km to marathon from the best efforts (5 km and up)
 * since `from`.
 *
 * - If the user ran the race distance itself in the window, that time is the
 *   anchor: no formula beats an actual result.
 * - Otherwise Riegel from the effort closest in distance (it's most accurate
 *   over short jumps), using the fastest effort at that distance; when two
 *   distances are about equally close, the more recent effort wins. Never
 *   more than 4x in either direction.
 *
 * Whole runs aren't used: they're mostly easy runs, so they'd bias estimates slow.
 */
export function racePredictions(runs: RunEntry[], from: string, unit: Unit) {
	const sources: Source[] = [];
	for (const r of runs) {
		if (r.date < from) continue;
		for (const e of r.analysis.bestEfforts ?? []) {
			if (e.distance >= MIN_PREDICTION_SOURCE_M) sources.push({ metres: e.distance, time: e.time, label: e.label, date: r.date, id: r.id });
		}
	}
	if (!sources.length) return `no 5 km or longer effort since ${from}, so no estimates`;

	// Fastest effort at each distance (ties: the more recent).
	const best = new Map<number, Source>();
	for (const src of sources) {
		const cur = best.get(src.metres);
		if (!cur || src.time < cur.time || (src.time === cur.time && src.date > cur.date)) best.set(src.metres, src);
	}

	const rows = PREDICT.flatMap(([label, metres]) => {
		const actual = best.get(metres);
		if (actual) {
			return [
				{
					distance: label,
					estimate: clock(actual.time),
					pace: pace(metres, actual.time, unit),
					basis: "actual",
					from: `you ran ${clock(actual.time)} on ${actual.date} (activity ${actual.id})`,
				},
			];
		}
		const gap = (s: Source) => Math.abs(Math.log(metres / s.metres));
		const eligible = [...best.values()].filter((s) => gap(s) <= Math.log(MAX_PREDICTION_RATIO));
		if (!eligible.length) return [];
		const nearest = Math.min(...eligible.map(gap));
		const src = eligible
			.filter((s) => gap(s) - nearest < CLOSE)
			.sort((a, b) => b.date.localeCompare(a.date) || gap(a) - gap(b))[0]!;
		const time = riegel(src.time, src.metres, metres);
		return [
			{
				distance: label,
				estimate: clock(time),
				pace: pace(metres, time, unit),
				basis: "riegel",
				from: `${src.label} in ${clock(src.time)} on ${src.date} (activity ${src.id})`,
			},
		];
	});
	return rows.length ? rows : "no recent effort within 4x of these distances, so no estimates";
}

