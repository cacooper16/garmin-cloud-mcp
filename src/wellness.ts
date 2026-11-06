/**
 * Aggregations over the wellness endpoints, for the two most common question
 * shapes: "how am I doing today?" (readiness) and "how has X trended?"
 * (summarizeWellness). Both return a few hundred characters instead of
 * thousands of daily rows.
 */

import { compactDailySummary, compactSleep } from "./compact.ts";
import { WEEK_ORDER, weekday, weekStart } from "./periods.ts";
import { num, type Raw, round } from "./util.ts";

export type WellnessGroupBy = "week" | "month" | "weekday" | "total";

/** One merged row per date across daily summary, sleep and HRV. */
export type DayRow = { date: string; daily?: Raw; sleep?: Raw; hrv?: Raw };

export function joinByDate(daily: Raw[], sleep: Raw[], hrv: Raw[]): DayRow[] {
	const days = new Map<string, DayRow>();
	const at = (date: unknown) => {
		if (typeof date !== "string") return undefined;
		let r = days.get(date);
		if (!r) days.set(date, (r = { date }));
		return r;
	};
	for (const d of daily) {
		const r = at(d.calendarDate);
		if (r) r.daily = compactDailySummary(d);
	}
	for (const s of sleep) {
		const r = at(s.calendarDate);
		if (r && num(s.sleepTimeSeconds)) r.sleep = compactSleep(s);
	}
	for (const h of hrv) {
		const r = at(h.calendarDate);
		if (r) r.hrv = h;
	}
	return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Collects values and reports avg (and optionally min/max), skipping missing days. */
class Stat {
	private v: number[] = [];
	add(x: unknown) {
		const n = num(x);
		if (n !== undefined) this.v.push(n);
	}
	get n() {
		return this.v.length;
	}
	avg(dp = 1) {
		if (!this.v.length) return undefined;
		return round(this.v.reduce((s, x) => s + x, 0) / this.v.length, dp);
	}
	sum() {
		return this.v.length ? this.v.reduce((s, x) => s + x, 0) : undefined;
	}
	min() {
		return this.v.length ? Math.min(...this.v) : undefined;
	}
	max() {
		return this.v.length ? Math.max(...this.v) : undefined;
	}
}

const METRICS = {
	steps: (r: DayRow) => r.daily?.steps,
	resting_hr: (r: DayRow) => r.daily?.resting_hr,
	stress_avg: (r: DayRow) => r.daily?.stress_avg,
	body_battery_max: (r: DayRow) => r.daily?.body_battery_max,
	body_battery_min: (r: DayRow) => r.daily?.body_battery_min,
	intensity_moderate_min: (r: DayRow) => r.daily?.intensity_moderate_min,
	intensity_vigorous_min: (r: DayRow) => r.daily?.intensity_vigorous_min,
	respiration_avg: (r: DayRow) => r.daily?.respiration_avg,
	sleep_h: (r: DayRow) => r.sleep?.sleep_h,
	deep_h: (r: DayRow) => r.sleep?.deep_h,
	rem_h: (r: DayRow) => r.sleep?.rem_h,
	sleep_score: (r: DayRow) => r.sleep?.score,
	hrv_overnight: (r: DayRow) => r.hrv?.lastNightAvg,
} as const;

const SUMMED = new Set(["intensity_moderate_min", "intensity_vigorous_min"]);
const WITH_RANGE = new Set(["resting_hr", "hrv_overnight", "sleep_h", "sleep_score"]);

/**
 * Per-period averages (intensity minutes are summed). Each metric reports how
 * many days had data, so gaps (watch not worn) are visible rather than hidden.
 */
export function summarizeWellness(rows: DayRow[], groupBy: WellnessGroupBy) {
	const groups = new Map<string, DayRow[]>();
	for (const r of rows) {
		const k =
			groupBy === "total"
				? "total"
				: groupBy === "month"
					? r.date.slice(0, 7)
					: groupBy === "weekday"
						? weekday(r.date)
						: weekStart(r.date);
		let g = groups.get(k);
		if (!g) groups.set(k, (g = []));
		g.push(r);
	}
	const entries = [...groups.entries()];
	if (groupBy === "weekday") entries.sort(([a], [b]) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
	return entries.map(([period, days]) => {
		const out: Raw = { period, days: days.length };
		for (const [name, pick] of Object.entries(METRICS)) {
			const s = new Stat();
			for (const d of days) s.add(pick(d));
			if (!s.n) continue;
			if (SUMMED.has(name)) {
				out[`${name}_total`] = s.sum();
				continue;
			}
			out[name] = s.avg(name.endsWith("_h") ? 2 : name === "steps" ? 0 : 1);
			if (WITH_RANGE.has(name) && groupBy !== "week") out[`${name}_range`] = [s.min(), s.max()];
			if (s.n < days.length) out[`${name}_days`] = s.n;
		}
		return out;
	});
}

/**
 * "How am I today?": the target day's sleep, HRV, resting HR, stress and Body
 * Battery, each next to the user's own recent average, plus recent training.
 */
export function buildReadiness(
	date: string,
	rows: DayRow[],
	recentActivities: Raw[],
	extra: { training_load?: unknown; unavailable?: string[] } = {},
) {
	const today = rows.find((r) => r.date === date);
	const prior = rows.filter((r) => r.date < date);
	const avg = (pick: (r: DayRow) => unknown, dp = 1) => {
		const s = new Stat();
		for (const r of prior) s.add(pick(r));
		return s.avg(dp);
	};
	const hrv = today?.hrv;
	return {
		date,
		sleep: today?.sleep ?? "no sleep recorded for this date",
		sleep_prior_avg: {
			sleep_h: avg((r) => r.sleep?.sleep_h, 2),
			score: avg((r) => r.sleep?.score),
		},
		hrv: hrv
			? {
					last_night: hrv.lastNightAvg,
					weekly_avg: hrv.weeklyAvg,
					status: hrv.status,
					baseline: hrv.baseline,
				}
			: "no HRV recorded for this date",
		resting_hr: today?.daily?.resting_hr,
		resting_hr_prior_avg: avg((r) => r.daily?.resting_hr),
		body_battery: today?.daily
			? {
					max: today.daily.body_battery_max,
					min: today.daily.body_battery_min,
					charged: today.daily.body_battery_charged,
				}
			: undefined,
		stress_avg_yesterday: prior.at(-1)?.daily?.stress_avg,
		prior_days_compared: prior.length,
		training_load: extra.training_load,
		// Said explicitly: an empty list would be stripped and read as "not checked".
		recent_activities: recentActivities.length ? recentActivities : "none in the last 3 days",
		unavailable: extra.unavailable?.length ? extra.unavailable : undefined,
	};
}
