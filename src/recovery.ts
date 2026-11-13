/**
 * Does recovery (sleep, HRV, Body Battery) relate to how the user runs?
 * Pairs each run with that morning's wellness (sleep and HRV are filed under
 * the date the user woke up, so the run's own date is the night before it),
 * then compares runs after the best third of nights with runs after the
 * worst third.
 *
 * Runs differ in intensity, and both speed and heart rate rise with it, so
 * raw pace or "metres per heartbeat" mostly measure what kind of run it was.
 * Instead, fit the user's own speed-for-heart-rate line across all the runs
 * and score each run by how much faster or slower it was than that line
 * predicts for its heart rate. That residual is what gets compared.
 *
 * Correlation only: route, weather and the kind of run vary too, and the
 * output says so every time.
 */

import { clock, KM, MILE, type Unit } from "./analysis.ts";
import { num, type Raw, round, typeKeyOf } from "./util.ts";
import type { DayRow } from "./wellness.ts";

export const MEASURES = ["sleep_score", "sleep_hours", "overnight_hrv", "morning_body_battery"] as const;
export type Measure = (typeof MEASURES)[number];

/** Each group (best and worst third) needs about this many runs before anything is concluded. */
export const MIN_GROUP = 8;
/** A relationship is only called meaningful at |r| of at least this. */
export const MIN_R = 0.3;
/** Groups whose average HR differs by more than this hold different kinds of runs. */
export const HR_GAP_BPM = 8;
/** Runs shorter than this are too noisy to compare. */
export const MIN_RUN_SECONDS = 20 * 60;

const PICK: Record<Measure, (r: DayRow) => unknown> = {
	sleep_score: (r) => r.sleep?.score,
	sleep_hours: (r) => r.sleep?.sleep_h,
	overnight_hrv: (r) => r.hrv?.lastNightAvg,
	// The day's peak, which on most days is on waking. The daily summary has no wake-time value.
	morning_body_battery: (r) => r.daily?.body_battery_max,
};

const LABEL: Record<Measure, string> = {
	sleep_score: "sleep score",
	sleep_hours: "hours slept",
	overnight_hrv: "overnight HRV (ms)",
	morning_body_battery: "morning Body Battery (the day's peak, usually on waking)",
};

/** Which wellness sources a set of measures needs. */
export function sourcesFor(measures: readonly Measure[]): Set<"daily" | "sleep" | "hrv"> {
	const out = new Set<"daily" | "sleep" | "hrv">();
	for (const m of measures) out.add(m === "morning_body_battery" ? "daily" : m === "overnight_hrv" ? "hrv" : "sleep");
	return out;
}

export interface RunPoint {
	date: string;
	id: string;
	/** Metres per second. */
	speed: number;
	/** Seconds per metre. */
	secPerMetre: number;
	hr: number;
	wellness: Partial<Record<Measure, number>>;
}

export interface Excluded {
	races: number;
	under_20_min: number;
	manual: number;
	no_hr_or_distance: number;
}

/**
 * Like-for-like runs only: no races, nothing under 20 minutes, no manual
 * entries, and each needs distance, time and average HR.
 */
export function pairRuns(activities: Raw[], rows: DayRow[]): { runs: RunPoint[]; excluded: Excluded } {
	const byDate = new Map(rows.map((r) => [r.date, r]));
	const excluded: Excluded = { races: 0, under_20_min: 0, manual: 0, no_hr_or_distance: 0 };
	const runs: RunPoint[] = [];
	for (const a of activities) {
		if (a.manualActivity === true) {
			excluded.manual++;
			continue;
		}
		if (typeKeyOf(a, "eventType") === "race") {
			excluded.races++;
			continue;
		}
		const secs = num(a.movingDuration) ?? num(a.duration) ?? 0;
		if (secs < MIN_RUN_SECONDS) {
			excluded.under_20_min++;
			continue;
		}
		const dist = num(a.distance) ?? 0;
		const hr = num(a.averageHR) ?? 0;
		if (dist <= 0 || hr <= 0) {
			excluded.no_hr_or_distance++;
			continue;
		}
		const date = String(a.startTimeLocal ?? "").slice(0, 10);
		const day = byDate.get(date);
		const wellness: Partial<Record<Measure, number>> = {};
		if (day) {
			for (const m of MEASURES) {
				const v = num(PICK[m](day));
				if (v !== undefined && v > 0) wellness[m] = v;
			}
		}
		runs.push({
			date,
			id: String(a.activityId ?? ""),
			speed: dist / secs,
			secPerMetre: secs / dist,
			hr,
			wellness,
		});
	}
	return { runs, excluded };
}

export function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Pearson's r; undefined when either series has no spread. */
export function pearson(xs: number[], ys: number[]): number | undefined {
	const n = xs.length;
	if (n < 3 || n !== ys.length) return undefined;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < n; i++) {
		const dx = xs[i]! - mx;
		const dy = ys[i]! - my;
		sxy += dx * dy;
		sxx += dx * dx;
		syy += dy * dy;
	}
	return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : undefined;
}

/** Least-squares line y = a + b·x; flat (b = 0) when x has no spread. */
export function linearFit(xs: number[], ys: number[]): { a: number; b: number } {
	const n = xs.length;
	const mx = xs.reduce((s, x) => s + x, 0) / n;
	const my = ys.reduce((s, y) => s + y, 0) / n;
	let sxy = 0;
	let sxx = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i]! - mx) * (ys[i]! - my);
		sxx += (xs[i]! - mx) ** 2;
	}
	const b = sxx > 0 ? sxy / sxx : 0;
	return { a: my - b * mx, b };
}

function strength(r: number): string {
	const a = Math.abs(r);
	return a < 0.5 ? "a moderate" : "a strong";
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Best third vs worst third of runs by one measure (higher is better for all
 * four), compared at the same heart rate: each run's pace against what the
 * user's own speed-for-HR line (fitted on all `runs`) predicts for its HR.
 */
export function compareByMeasure(runs: RunPoint[], measure: Measure, unit: Unit) {
	const withData = runs.filter((r) => r.wellness[measure] !== undefined);
	const sorted = [...withData].sort((a, b) => a.wellness[measure]! - b.wellness[measure]!);
	const third = Math.floor(sorted.length / 3);
	const head = { measure, about: LABEL[measure], runs_with_data: withData.length };
	if (third < MIN_GROUP) {
		return {
			...head,
			best_third_n: third,
			worst_third_n: third,
			result: `Not enough data: ${withData.length} comparable runs have a ${LABEL[measure]} value, so each third would have ${third} (need about ${MIN_GROUP}). No conclusion drawn; try a longer range.`,
		};
	}

	// The user's speed-for-HR line, from every comparable run in the range.
	const fit = linearFit(
		runs.map((r) => r.hr),
		runs.map((r) => r.speed),
	);
	const expected = (r: RunPoint) => fit.a + fit.b * r.hr;
	const unitM = unit === "km" ? KM : MILE;
	const per = unit === "km" ? "km" : "mi";
	/** Seconds per unit slower (+) or faster (-) than expected for this run's HR. */
	const paceResidual = (r: RunPoint) => {
		const e = expected(r);
		return e > 0 ? (r.secPerMetre - 1 / e) * unitM : 0;
	};

	const worst = sorted.slice(0, third);
	const best = sorted.slice(-third);
	const group = (g: RunPoint[]) => {
		const vals = g.map((r) => r.wellness[measure]!);
		return {
			n: g.length,
			[measure]: `${round(Math.min(...vals))}-${round(Math.max(...vals))}`,
			avg_hr: Math.round(mean(g.map((r) => r.hr))),
			pace: `${clock(median(g.map((r) => r.secPerMetre)) * unitM)} /${per}`,
			[`vs_expected_s_per_${per}`]: Math.round(median(g.map(paceResidual))),
		};
	};
	const b = group(best);
	const w = group(worst);
	const diff = Math.round(median(best.map(paceResidual)) - median(worst.map(paceResidual)));
	const hrGap = b.avg_hr - w.avg_hr;
	// r between the measure and speed above/below the line (positive: better nights, faster for the HR).
	const r = pearson(
		withData.map((x) => x.wellness[measure]!),
		withData.map((x) => x.speed - expected(x)),
	);
	const meaningful = r !== undefined && Math.abs(r) >= MIN_R;

	const atSameHr =
		diff === 0
			? "the same pace for the same heart rate as"
			: `${Math.abs(diff)} s/${per} ${diff < 0 ? "faster" : "slower"} for the same heart rate than`;
	const relation =
		r === undefined
			? "There's no spread to correlate, so no relationship to report."
			: meaningful
				? `r = ${round(r, 2)}: ${strength(r)} relationship${r > 0 ? " (better nights, faster runs for the effort)" : " (better nights, slower runs for the effort)"}.`
				: `r = ${round(r, 2)}, under ${MIN_R}: too weak to call a relationship.`;
	const hrNote =
		Math.abs(hrGap) > HR_GAP_BPM
			? ` The two groups' average HR differs by ${Math.abs(hrGap)} bpm, so they hold different kinds of runs (${hrGap < 0 ? "easier" : "harder"} ones after better nights); the same-HR comparison allows for that, but treat it with more caution.`
			: "";
	return {
		...head,
		best_third: b,
		worst_third: w,
		[`difference_s_per_${per}_at_same_hr`]: diff,
		avg_hr_difference: hrGap,
		correlation_r: r === undefined ? undefined : round(r, 2),
		meaningful,
		result: `After the best third of nights, runs were ${atSameHr} after the worst third. ${relation}${hrNote}`,
	};
}

export const CAVEAT =
	"Correlation, not proof: route, terrain and heat differ between days too, and a bad night may also change what you chose to run. " +
	"Each run is compared with your own speed-for-heart-rate line (fitted across these runs), so easy and hard runs are judged fairly; " +
	"vs_expected is seconds slower (+) or faster (-) than that line predicts for the run's heart rate. Races, runs under 20 minutes and manual entries are left out.";
