/**
 * Named periods ("last_7_days", "this_month") resolved in the user's own time
 * zone, so the model doesn't have to compute dates and "today" means the user's
 * today, not UTC's.
 */

import { addDays } from "./ranges.ts";

export const PERIODS = [
	"today",
	"yesterday",
	"last_7_days",
	"last_28_days",
	"last_30_days",
	"last_90_days",
	"last_180_days",
	"last_365_days",
	"this_week",
	"last_week",
	"this_month",
	"last_month",
	"this_year",
	"last_year",
] as const;
export type Period = (typeof PERIODS)[number];

/** Today's calendar date in an IANA time zone; falls back to UTC if the zone is unknown. */
export function todayIn(timeZone: string | undefined, now = new Date()): string {
	try {
		// en-CA formats as YYYY-MM-DD.
		return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC" }).format(now);
	} catch {
		return now.toISOString().slice(0, 10);
	}
}

const DAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Weekday names in display order (weeks start Monday). */
export const WEEK_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Short weekday name for a YYYY-MM-DD date. */
export function weekday(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	return Number.isNaN(d.getTime()) ? "" : DAY[d.getUTCDay()]!;
}

/** The Monday on or before a YYYY-MM-DD date. */
export function weekStart(date: string): string {
	return addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
}

/** Resolves a named period to an inclusive [start, end] ending no later than today. Weeks start Monday. */
export function resolvePeriod(period: Period, today: string): [string, string] {
	const [y, m] = today.split("-").map(Number) as [number, number];
	const monday = weekStart(today);
	const pad = (n: number) => String(n).padStart(2, "0");
	switch (period) {
		case "today":
			return [today, today];
		case "yesterday":
			return [addDays(today, -1), addDays(today, -1)];
		case "last_7_days":
			return [addDays(today, -6), today];
		case "last_28_days":
			return [addDays(today, -27), today];
		case "last_30_days":
			return [addDays(today, -29), today];
		case "last_90_days":
			return [addDays(today, -89), today];
		case "last_180_days":
			return [addDays(today, -179), today];
		case "last_365_days":
			return [addDays(today, -364), today];
		case "this_week":
			return [monday, today];
		case "last_week":
			return [addDays(monday, -7), addDays(monday, -1)];
		case "this_month":
			return [`${y}-${pad(m)}-01`, today];
		case "last_month": {
			const firstThis = `${y}-${pad(m)}-01`;
			const lastPrev = addDays(firstThis, -1);
			return [`${lastPrev.slice(0, 7)}-01`, lastPrev];
		}
		case "this_year":
			return [`${y}-01-01`, today];
		case "last_year":
			return [`${y - 1}-01-01`, `${y - 1}-12-31`];
	}
}
