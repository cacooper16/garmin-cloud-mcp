/**
 * Garmin timestamps in the user's local wall-clock time, as "YYYY-MM-DD HH:MM".
 *
 * Garmin sends times in several shapes, and the model mis-reads raw ones (it
 * added the UTC offset to an already-local epoch and reported bedtime an hour
 * late). Everything the compact output returns goes through here instead:
 *
 * - `*Local` fields are local wall-clock time. As epoch ms they're encoded as
 *   if that wall-clock time were UTC (sleep, weight `date`), so they're
 *   formatted in UTC with no offset applied. As strings
 *   ("2026-11-08T22:41:10.0", "2026-11-08 22:41:10") they're just reformatted.
 * - `*GMT` / `*Gmt` fields are real UTC instants (epoch ms, or ISO strings
 *   without a "Z"). They need the record's own offset from UTC added.
 */

import { isObj, type Raw } from "./util.ts";

const LOCAL_STRING = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/;

/** True for epoch milliseconds (rules out seconds, ids and small numbers). */
const isEpochMs = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) > 1e11;

/** "YYYY-MM-DD HH:MM" from a local wall-clock value: epoch ms encoded as UTC, or an ISO-like local string. */
export function localStamp(v: unknown): string | undefined {
	if (isEpochMs(v)) {
		const iso = new Date(v).toISOString();
		return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
	}
	if (typeof v === "string") {
		const m = LOCAL_STRING.exec(v);
		if (m) return `${m[1]} ${m[2]}`;
	}
	return undefined;
}

/** A GMT value (epoch ms, or ISO string with or without a zone) as epoch ms; NaN if unparseable. */
export function parseGmt(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v !== "string" || !LOCAL_STRING.test(v)) return NaN;
	return Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(" ", "T")}Z`);
}

/** "YYYY-MM-DD HH:MM" local time from a GMT value plus the record's offset from UTC in ms. */
export function gmtToLocalStamp(v: unknown, offsetMs: number): string | undefined {
	const ms = parseGmt(v);
	return Number.isFinite(ms) ? localStamp(ms + offsetMs) : undefined;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();

/** An IANA zone's offset from UTC in ms at an instant; undefined for an unknown zone. */
export function zoneOffsetMs(timeZone: string, ms: number): number | undefined {
	let f = zoneFormats.get(timeZone);
	if (f === undefined) {
		try {
			f = new Intl.DateTimeFormat("en-US", {
				timeZone,
				hourCycle: "h23",
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			});
		} catch {
			f = null;
		}
		zoneFormats.set(timeZone, f);
	}
	if (!f) return undefined;
	const p: Record<string, number> = {};
	for (const part of f.formatToParts(ms)) if (part.type !== "literal") p[part.type] = Number(part.value);
	const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
	return wall - Math.floor(ms / 1000) * 1000;
}

const DAY_MS = 24 * 3600_000;

/**
 * The offset to add to a GMT instant to get the user's local time.
 *
 * Garmin stamps a whole night or day with a single offset, so around a DST
 * change its "local" times are an hour out (bedtime in the wake-up offset,
 * or the reverse). With the profile's IANA zone, the zone's own offset at
 * that instant is used instead, unless Garmin's offset isn't one the zone
 * has within a day either side: then the user was travelling, and Garmin's
 * offset (from the watch) is right.
 */
export function chooseOffsetMs(ms: number, garminOffsetMs: number | undefined, timeZone: string | undefined): number {
	const zone = timeZone ? zoneOffsetMs(timeZone, ms) : undefined;
	if (zone === undefined) return garminOffsetMs ?? 0;
	if (garminOffsetMs === undefined || garminOffsetMs === zone) return zone;
	const nearby = [ms - DAY_MS, ms - DAY_MS / 2, ms + DAY_MS / 2, ms + DAY_MS].map((t) => zoneOffsetMs(timeZone!, t));
	return nearby.includes(garminOffsetMs) ? zone : garminOffsetMs;
}

/** "YYYY-MM-DD HH:MM" for a GMT instant, given Garmin's offset for it (if any) and the profile zone (if known). */
export function localFromGmt(v: unknown, garminOffsetMs: number | undefined, timeZone: string | undefined): string | undefined {
	const ms = parseGmt(v);
	if (!Number.isFinite(ms)) return undefined;
	if (garminOffsetMs === undefined && !timeZone) return undefined;
	return localStamp(ms + chooseOffsetMs(ms, garminOffsetMs, timeZone));
}

/**
 * "YYYY-MM-DD HH:MM" for a Garmin GMT/Local pair describing the same instant
 * (e.g. sleepStartTimestampGMT / sleepStartTimestampLocal). The GMT instant
 * is the reliable part; the Local value supplies Garmin's offset. Falls back
 * to the Local value alone when there's no usable GMT.
 */
export function localFromPair(gmt: unknown, local: unknown, timeZone: string | undefined): string | undefined {
	const g = parseGmt(gmt);
	const l = parseGmt(local); // Local wall-clock parsed as if UTC
	if (!Number.isFinite(g)) return localStamp(local);
	return localStamp(g + chooseOffsetMs(g, Number.isFinite(l) ? l - g : undefined, timeZone));
}

/** Local-minus-GMT pairs Garmin records carry, in order of preference. */
const OFFSET_PAIRS: [string, string][] = [
	["startTimestampLocal", "startTimestampGMT"],
	["startTimestampLocal", "startTimestampGmt"],
	["sleepStartTimestampLocal", "sleepStartTimestampGMT"],
	["tomorrowSleepStartTimestampLocal", "tomorrowSleepStartTimestampGMT"],
	["latestSpO2TimestampLocal", "latestSpO2TimestampGMT"],
];

/** Offset from UTC in ms from a Local/GMT pair the record carries, or undefined. */
function pairOffsetMs(d: Raw): number | undefined {
	for (const [local, gmt] of OFFSET_PAIRS) {
		const l = parseGmt(d[local]); // a Local value parsed as if UTC is its wall-clock time
		const g = parseGmt(d[gmt]);
		if (Number.isFinite(l) && Number.isFinite(g)) return l - g;
	}
	return undefined;
}

/**
 * A record's offset from UTC in ms (to add to a GMT time), from a Local/GMT
 * pair it carries, else its `timezoneOffset` (ms), else undefined.
 */
export function recordOffsetMs(d: Raw): number | undefined {
	return pairOffsetMs(d) ?? (typeof d.timezoneOffset === "number" ? d.timezoneOffset : undefined);
}

const GMT_KEY = /(GMT|Gmt)$/;

/** The GMT field describing the same instant as a `*Local` key, if the record has one. */
function gmtTwin(v: Raw, localKey: string): string | undefined {
	const base = localKey.slice(0, -"Local".length);
	return [`${base}GMT`, `${base}Gmt`].find((k) => k in v && v[k] != null);
}

/**
 * Rewrites a raw Garmin payload's timestamps as local "YYYY-MM-DD HH:MM",
 * keeping field names. `timeZone` is the user's Garmin profile zone, used to
 * correct Garmin's offsets around DST changes (see chooseOffsetMs).
 * - `*Local` values: from their GMT twin when there is one, else reformatted.
 * - A `*GMT`/`*Gmt` field with a `*Local` twin is left for stripNoise to drop.
 *   One without a twin is converted (record offset and/or profile zone) and
 *   returned under the twin's `*Local` name, so a local time is never
 *   labelled GMT. A `timezoneOffset` used for that is dropped, so it isn't
 *   applied twice.
 * - Weight entries: `date` (local epoch) is formatted and `timestampGMT`, the
 *   same instant in UTC, is dropped. totalAverage's `from`/`until` range
 *   bounds (local-day epochs) are formatted too.
 * Positional arrays ([ts, value] rows) are left alone.
 */
export function localizeTimes(v: unknown, inheritedOffsetMs?: number, timeZone?: string): unknown {
	if (Array.isArray(v)) return v.map((x) => (isObj(x) ? localizeTimes(x, inheritedOffsetMs, timeZone) : x));
	if (!isObj(v)) return v;
	const offset = recordOffsetMs(v) ?? inheritedOffsetMs;
	const offsetIsTimezoneOffset = pairOffsetMs(v) === undefined && typeof v.timezoneOffset === "number";
	const out: Raw = {};
	let usedTimezoneOffset = false;
	for (const [k, raw] of Object.entries(v)) {
		if (k === "date" && isEpochMs(raw) && "timestampGMT" in v) {
			out[k] = localFromPair(v.timestampGMT, raw, timeZone);
		} else if (k === "timestampGMT" && isEpochMs(v.date)) {
			// Same instant as the weight entry's local `date`.
		} else if ((k === "from" || k === "until") && isEpochMs(raw)) {
			// Weight totalAverage: the requested range's bounds, as local-day epochs.
			out[k] = localStamp(raw);
		} else if (k.endsWith("Local") && (isEpochMs(raw) || typeof raw === "string")) {
			const twin = gmtTwin(v, k);
			out[k] = (twin ? localFromPair(v[twin], raw, timeZone) : localStamp(raw)) ?? raw;
		} else if (GMT_KEY.test(k) && !(k.replace(GMT_KEY, "Local") in v)) {
			const local = localFromGmt(raw, offset, timeZone);
			if (local === undefined) out[k] = raw;
			else {
				out[k.replace(GMT_KEY, "Local")] = local;
				if (offsetIsTimezoneOffset) usedTimezoneOffset = true;
			}
		} else {
			out[k] = isObj(raw) || Array.isArray(raw) ? localizeTimes(raw, offset, timeZone) : raw;
		}
	}
	if (usedTimezoneOffset) delete out.timezoneOffset;
	return out;
}
