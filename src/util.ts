/** Small helpers shared by the compaction and aggregation modules. */

export type Raw = Record<string, unknown>;

export const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** A number, or the `.value` of a {value} wrapper (Garmin uses both). */
export function num(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (isObj(v)) return num(v.value);
	return undefined;
}

export const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;

/** `typeKey` of a nested type object, e.g. activityType or eventTypeDTO. */
export function typeKeyOf(a: Raw, field: string): string | undefined {
	const t = a[field];
	return isObj(t) && typeof t.typeKey === "string" ? t.typeKey : undefined;
}

/** Pace as m:ss per unit, from a speed in m/s; undefined when there's no speed. */
export function paceFrom(metresPerSecond: number | undefined, unitMetres: number): string | undefined {
	if (!metresPerSecond || metresPerSecond <= 0) return undefined;
	const secs = unitMetres / metresPerSecond;
	const m = Math.floor(secs / 60);
	const s = Math.round(secs % 60);
	return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, "0")}`;
}
