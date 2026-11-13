/**
 * Derived tables from a decoded FIT activity: per-km/mile splits, the watch's
 * laps, best efforts, an HR histogram (for zones) and first/second-half drift.
 *
 * Two stages so the expensive part can be cached forever (the original file
 * never changes): analyzeActivity() produces a small unit-agnostic summary in
 * SI units, and formatAnalysis() turns it into readable rows for one unit
 * system and the user's current HR zones.
 *
 * All times are timer time (pauses excluded), like Garmin's own splits.
 */

import { decodeFit, type FitActivity, FitError, type FitRecord, isFit, unzip } from "./fit.ts";
import { round } from "./util.ts";

/** Bump when analysis output changes, so cached results are recomputed. */
export const ANALYSIS_VERSION = 2;

export const KM = 1000;
export const MILE = 1609.344;
/** A final partial split shorter than this fraction of a unit is dropped as GPS noise. */
const MIN_PARTIAL = 0.01;
/**
 * Barometric altitude jitters; only count climbs/descents of at least this
 * many metres. 1.5 m matched Garmin's own lap ascent/descent within ~2 m on
 * real 10 km and half-marathon files.
 */
const ELEVATION_HYSTERESIS_M = 1.5;

export const BEST_EFFORTS: [label: string, metres: number][] = [
	["1 km", 1000],
	["1 mile", MILE],
	["5 km", 5000],
	["10 km", 10_000],
	["half marathon", 21_097.5],
	["marathon", 42_195],
];

/** Foot sports: FIT cadence is strides/min (one leg), doubled to steps/min, and speed reads as pace. */
const STEP_SPORTS = new Set(["running", "walking", "hiking", "training", "generic"]);
/** Drift needs a real distance to say anything. */
const MIN_DRIFT_METRES = 1000;

// ---- timeline ---------------------------------------------------------------

/** One record with its position on the timer clock. */
export interface Sample {
	/** Timer seconds since the start (pauses excluded). */
	t: number;
	/** Metres, made non-decreasing. Undefined when the activity has no distance. */
	d?: number;
	hr?: number;
	cad?: number;
	pwr?: number;
	/** Cumulative climb and descent in metres up to this sample. */
	gain: number;
	loss: number;
}

type TimerEvent = { ts: number; event: number; type: string };

const STOPS = new Set(["stop", "stopAll", "stopDisable", "stopDisableAll"]);

/**
 * Running intervals of the activity timer, as [startTs, stopTs] pairs. With
 * no timer events the timer is taken to run from the first record onward.
 */
export function timerIntervals(events: TimerEvent[], firstTs: number): [number, number][] {
	const timer = events.filter((e) => e.event === 0).sort((a, b) => a.ts - b.ts);
	const out: [number, number][] = [];
	let runningSince: number | undefined = timer[0]?.type === "start" ? undefined : firstTs;
	for (const e of timer) {
		if (e.type === "start") runningSince ??= e.ts;
		else if (STOPS.has(e.type) && runningSince !== undefined) {
			out.push([runningSince, e.ts]);
			runningSince = undefined;
		}
	}
	if (runningSince !== undefined) out.push([runningSince, Number.POSITIVE_INFINITY]);
	return out;
}

/** Converts records to samples on the timer clock, with cleaned distance and cumulative elevation. */
export function buildTimeline(records: FitRecord[], events: TimerEvent[]): Sample[] {
	const recs = [...records].sort((a, b) => a.ts - b.ts);
	if (!recs.length) return [];
	const intervals = timerIntervals(events, recs[0]!.ts);
	const hasDistance = recs.some((r) => r.distance !== undefined);

	const out: Sample[] = [];
	let k = 0; // current interval
	let before = 0; // timer seconds in intervals fully before k
	let d = 0;
	let gain = 0;
	let loss = 0;
	let ref: number | undefined; // elevation hysteresis reference
	for (const r of recs) {
		while (k < intervals.length && r.ts >= intervals[k]![1]) {
			before += intervals[k]![1] - intervals[k]![0];
			k++;
		}
		const iv = intervals[k];
		const t = before + (iv && r.ts > iv[0] ? r.ts - iv[0] : 0);

		if (r.distance !== undefined && r.distance > d) d = r.distance;
		if (r.altitude !== undefined) {
			if (ref === undefined) ref = r.altitude;
			else if (r.altitude - ref >= ELEVATION_HYSTERESIS_M) {
				gain += r.altitude - ref;
				ref = r.altitude;
			} else if (ref - r.altitude >= ELEVATION_HYSTERESIS_M) {
				loss += ref - r.altitude;
				ref = r.altitude;
			}
		}
		out.push({ t, d: hasDistance ? d : undefined, hr: r.hr, cad: r.cadence, pwr: r.power, gain, loss });
	}
	return out;
}

/** Index of the first sample with distance >= target (samples are non-decreasing). */
function firstAtDistance(s: Sample[], target: number, lo = 0): number {
	let hi = s.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((s[mid]!.d ?? 0) >= target) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/** Timer time at which the activity reached `target` metres, linearly interpolated between records. */
export function timeAtDistance(s: Sample[], target: number, lo = 0): number {
	const i = firstAtDistance(s, target, lo);
	const b = s[i]!;
	if (i === 0 || (b.d ?? 0) <= target) return b.t;
	const a = s[i - 1]!;
	const span = b.d! - a.d!;
	return span > 0 ? a.t + ((target - a.d!) / span) * (b.t - a.t) : b.t;
}

/** Distance covered at timer time `t`, linearly interpolated. */
export function distanceAtTime(s: Sample[], t: number): number {
	let lo = 0;
	let hi = s.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (s[mid]!.t >= t) hi = mid;
		else lo = mid + 1;
	}
	const b = s[lo]!;
	if (lo === 0 || b.t <= t) return b.d ?? 0;
	const a = s[lo - 1]!;
	return a.d! + ((t - a.t) / (b.t - a.t)) * (b.d! - a.d!);
}

/** Cumulative elevation at timer time `t`: the last sample at or before it. */
function elevationAt(s: Sample[], t: number): { gain: number; loss: number } {
	let lo = 0;
	let hi = s.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (s[mid]!.t <= t) lo = mid;
		else hi = mid - 1;
	}
	return s[lo]!;
}

export interface Averages {
	avgHr?: number;
	maxHr?: number;
	cadence?: number;
	power?: number;
}

/**
 * Time-weighted averages over timer interval (from, to]. Each sample stands
 * for the timer time since the previous one, so smart (irregular) recording
 * and pauses are weighted correctly.
 */
export function averagesBetween(s: Sample[], from: number, to: number): Averages {
	const acc = { hr: [0, 0], cad: [0, 0], pwr: [0, 0] };
	let maxHr: number | undefined;
	for (let i = 1; i < s.length; i++) {
		const b = s[i]!;
		const a = s[i - 1]!;
		if (a.t >= to) break;
		const w = Math.min(b.t, to) - Math.max(a.t, from);
		if (w <= 0) continue;
		if (b.hr !== undefined) {
			acc.hr[0]! += b.hr * w;
			acc.hr[1]! += w;
			maxHr = Math.max(maxHr ?? 0, b.hr);
		}
		if (b.cad !== undefined) {
			acc.cad[0]! += b.cad * w;
			acc.cad[1]! += w;
		}
		if (b.pwr !== undefined) {
			acc.pwr[0]! += b.pwr * w;
			acc.pwr[1]! += w;
		}
	}
	const avg = ([sum, w]: number[]) => (w! > 0 ? sum! / w! : undefined);
	return { avgHr: avg(acc.hr), maxHr, cadence: avg(acc.cad), power: avg(acc.pwr) };
}

// ---- analysis (SI, cacheable) -----------------------------------------------

export interface Segment extends Averages {
	/** Metres covered. */
	distance: number;
	/** Timer seconds. */
	time: number;
	/** Timer seconds from the start to the end of this segment. */
	cumulative: number;
	gain?: number;
	loss?: number;
}

export interface Lap extends Segment {
	intensity?: string;
	trigger?: string;
}

export interface Effort {
	label: string;
	distance: number;
	time: number;
	/** Metres from the start where the effort began. */
	startDistance: number;
	/** Timer seconds from the start where the effort began. */
	startTime: number;
	avgHr?: number;
}

export interface Half {
	distance: number;
	time: number;
	avgHr?: number;
}

export interface Analysis {
	v: number;
	sport?: string;
	/** spm: foot sport (cadence doubled to steps/min; pace shown). rpm: cycling. per_min: anything else. Pace only for spm. */
	cadenceUnit: "spm" | "rpm" | "per_min";
	distance?: number;
	time: number;
	hasHr: boolean;
	splits?: { km: Segment[]; mile: Segment[] };
	laps: Lap[];
	bestEfforts?: Effort[];
	/** [bpm, timer seconds] pairs, for time in zones under any zone scheme. */
	hrHistogram: [number, number][];
	/**
	 * The watch's own time in HR zones, with the zones in effect when it was
	 * recorded (FIT time_in_zone): seconds below zone 1, then zones 1-5, with
	 * time above max HR counted in zone 5 as Garmin Connect does.
	 */
	recordedZones?: HrZones & { seconds: [number, number, number, number, number, number] };
	drift?: { first: Half; second: Half };
	/** True when laps include warm-up, cool-down, rest or recovery. */
	structured: boolean;
}

/** Splits at every whole `unit` metres, plus a final partial split. */
export function computeSplits(s: Sample[], unit: number): Segment[] {
	const total = s.at(-1)?.d ?? 0;
	if (total <= 0) return [];
	const out: Segment[] = [];
	let fromT = s[0]!.t;
	let fromD = 0;
	let lo = 0;
	while (fromD < total) {
		const toD = Math.min(fromD + unit, total);
		if (toD < fromD + unit && toD - fromD < unit * MIN_PARTIAL) break;
		lo = firstAtDistance(s, toD, lo);
		const toT = toD === total ? s.at(-1)!.t : timeAtDistance(s, toD, Math.max(0, lo - 1));
		const e0 = elevationAt(s, fromT);
		const e1 = elevationAt(s, toT);
		out.push({
			distance: toD - fromD,
			time: toT - fromT,
			cumulative: toT - s[0]!.t,
			...averagesBetween(s, fromT, toT),
			gain: e1.gain - e0.gain,
			loss: e1.loss - e0.loss,
		});
		fromT = toT;
		fromD = toD;
	}
	return out;
}

/**
 * Fastest continuous `metres` within the activity. Tries every record as the
 * start (with an interpolated finish) and every record as the finish (with an
 * interpolated start), so the result is within a fraction of a second of the
 * true optimum at 1 s recording.
 */
export function bestEffort(s: Sample[], metres: number): Omit<Effort, "label" | "avgHr"> | undefined {
	const total = s.at(-1)?.d ?? 0;
	if (metres <= 0 || total < metres) return undefined;
	let best: { time: number; startT: number; startD: number } | undefined;
	let j = 0;
	for (const a of s) {
		const target = a.d! + metres;
		if (target > total) break;
		j = firstAtDistance(s, target, j);
		const time = timeAtDistance(s, target, Math.max(0, j - 1)) - a.t;
		if (!best || time < best.time) best = { time, startT: a.t, startD: a.d! };
	}
	let i = 0;
	for (const b of s) {
		const start = b.d! - metres;
		if (start < 0) continue;
		i = firstAtDistance(s, start, i);
		const startT = timeAtDistance(s, start, Math.max(0, i - 1));
		const time = b.t - startT;
		if (!best || time < best.time) best = { time, startT, startD: start };
	}
	if (!best) return undefined;
	return {
		distance: metres,
		time: best.time,
		startDistance: best.startD,
		startTime: best.startT - s[0]!.t,
	};
}

/** Timer seconds spent at each heart rate (bpm). */
export function hrHistogram(s: Sample[]): [number, number][] {
	const secs = new Map<number, number>();
	for (let i = 1; i < s.length; i++) {
		const hr = s[i]!.hr;
		const w = s[i]!.t - s[i - 1]!.t;
		if (hr !== undefined && w > 0) secs.set(hr, (secs.get(hr) ?? 0) + w);
	}
	return [...secs].sort((a, b) => a[0] - b[0]).map(([bpm, t]) => [bpm, round(t, 1)]);
}

/** Splits the activity into two halves by timer time. */
export function halves(s: Sample[]): { first: Half; second: Half } | undefined {
	const start = s[0]?.t ?? 0;
	const end = s.at(-1)?.t ?? 0;
	if (end - start < 120 || (s.at(-1)?.d ?? 0) < MIN_DRIFT_METRES) return undefined;
	const mid = start + (end - start) / 2;
	const dMid = distanceAtTime(s, mid);
	const half = (from: number, to: number, distance: number): Half => ({
		distance,
		time: to - from,
		avgHr: averagesBetween(s, from, to).avgHr,
	});
	return { first: half(start, mid, dMid), second: half(mid, end, s.at(-1)!.d! - dMid) };
}

export function analyzeActivity(fit: FitActivity): Analysis {
	const s = buildTimeline(fit.records, fit.events);
	const steps = STEP_SPORTS.has(fit.sport ?? "generic");
	if (steps) for (const x of s) if (x.cad !== undefined) x.cad *= 2;
	const hasDistance = (s.at(-1)?.d ?? 0) > 0;
	const time = s.length ? s.at(-1)!.t - s[0]!.t : 0;

	let cumulative = 0;
	const laps: Lap[] = fit.laps.map((l) => {
		cumulative += l.timerTime ?? 0;
		return {
			distance: l.distance ?? 0,
			time: l.timerTime ?? 0,
			cumulative,
			avgHr: l.avgHr,
			maxHr: l.maxHr,
			cadence: l.avgCadence === undefined ? undefined : steps ? l.avgCadence * 2 : l.avgCadence,
			power: l.avgPower,
			gain: l.ascent,
			loss: l.descent,
			intensity: l.intensity,
			trigger: l.trigger,
		};
	});

	const bestEfforts = hasDistance
		? BEST_EFFORTS.flatMap(([label, metres]) => {
				const e = bestEffort(s, metres);
				if (!e) return [];
				const t0 = s[0]!.t + e.startTime;
				return [{ label, ...e, avgHr: averagesBetween(s, t0, t0 + e.time).avgHr }];
			})
		: undefined;

	const zones = recordedZones(fit);
	return {
		v: ANALYSIS_VERSION,
		sport: fit.sport,
		cadenceUnit: steps ? "spm" : fit.sport === "cycling" ? "rpm" : "per_min",
		distance: hasDistance ? s.at(-1)!.d : undefined,
		time,
		hasHr: s.some((x) => x.hr !== undefined),
		splits: hasDistance ? { km: computeSplits(s, KM), mile: computeSplits(s, MILE) } : undefined,
		laps,
		bestEfforts,
		hrHistogram: hrHistogram(s),
		...(zones ? { recordedZones: zones } : {}), // omitted, not undefined: the analysis is cached as JSON
		drift: halves(s),
		structured: laps.some((l) => ["warmup", "cooldown", "rest", "recovery"].includes(l.intensity ?? "")),
	};
}

/** Zones and time in them as the watch recorded them, when the FIT file has the standard 5 zones. */
function recordedZones(fit: FitActivity): Analysis["recordedZones"] {
	const tiz = fit.hrTimeInZone;
	if (!tiz || tiz.hrHighBoundaries.length !== 6) return undefined;
	const [b0, b1, b2, b3, b4, max] = tiz.hrHighBoundaries as [number, number, number, number, number, number];
	const [s0, s1, s2, s3, s4, s5, above] = tiz.hrSeconds as [number, number, number, number, number, number, number];
	return {
		floors: [b0 + 1, b1 + 1, b2 + 1, b3 + 1, b4 + 1],
		max,
		source: "the watch's zones when this activity was recorded (from the FIT file); matches Garmin Connect",
		seconds: [s0, s1, s2, s3, s4, s5 + above],
	};
}

// ---- loading ------------------------------------------------------------------

/** The parts of GarminClient the loader needs, so tests can pass a fake. */
export interface AnalysisSource {
	getBytes(path: string): Promise<Uint8Array>;
	getCached<T>(name: string): Promise<T | undefined>;
	putCached(name: string, value: unknown): Promise<void>;
}

/** Name an activity's analysis is cached under (see GarminClient.getCached). */
export const analysisCacheName = (activityId: string) => `analysis:v${ANALYSIS_VERSION}:${activityId}`;

/** Either the analysis, or a short reason it can't be produced (not an error). */
export type Loaded = { analysis: Analysis } | { unavailable: string };

const NO_FILE =
	"Garmin has no original file for this activity (usually a manual entry), so splits, laps and best efforts aren't available. get_activity still has its totals.";

/**
 * Downloads the activity's original file, decodes the FIT inside and analyses
 * it. The result is cached indefinitely (the file never changes); the file
 * itself never is. 404s and non-FIT originals (GPX/TCX imports) come back as
 * `unavailable` rather than throwing.
 */
export async function loadAnalysis(src: AnalysisSource, activityId: string): Promise<Loaded> {
	const cacheName = analysisCacheName(activityId);
	const cached = await src.getCached<Analysis>(cacheName);
	if (cached?.v === ANALYSIS_VERSION) return { analysis: cached };

	let bytes: Uint8Array;
	try {
		bytes = await src.getBytes(`/download-service/files/activity/${activityId}`);
	} catch (err) {
		if ((err as { status?: number }).status === 404) return { unavailable: NO_FILE };
		throw err;
	}
	if (!bytes.length) return { unavailable: NO_FILE };

	let fit: Uint8Array | undefined;
	let names: string[] = [];
	try {
		if (isFit(bytes)) fit = bytes;
		else {
			const entries = await unzip(bytes);
			names = entries.map((e) => e.name);
			fit = entries.find((e) => /\.fit$/i.test(e.name) && isFit(e.data))?.data;
		}
	} catch (err) {
		if (err instanceof FitError) return { unavailable: `Garmin's original file for this activity couldn't be read (${err.message}).` };
		throw err;
	}
	if (!fit) {
		const ext = names.map((n) => n.split(".").pop()?.toUpperCase()).find((x) => x && x !== "FIT");
		return {
			unavailable: `The original file for this activity is ${ext ? `a ${ext} import` : "not a FIT file"}, which has no per-second data to analyse. get_activity still has its totals.`,
		};
	}

	let decoded: FitActivity;
	try {
		decoded = decodeFit(fit);
	} catch (err) {
		if (err instanceof FitError) return { unavailable: `Garmin's FIT file for this activity is malformed (${err.message}).` };
		throw err;
	}
	if (!decoded.records.length) {
		return { unavailable: "The FIT file has no recorded samples, so there is nothing to analyse beyond get_activity's totals." };
	}
	const analysis = analyzeActivity(decoded);
	await src.putCached(cacheName, analysis);
	return { analysis };
}

// ---- formatting ---------------------------------------------------------------

export type Unit = "km" | "mile";
export const SECTIONS = ["splits", "laps", "best_efforts", "hr_zones", "drift"] as const;
export type Section = (typeof SECTIONS)[number];

/** HR zone floors (zone 1-5) and the max HR that caps zone 5. */
export interface HrZones {
	floors: [number, number, number, number, number];
	max?: number;
	source: string;
}

const ZONE_SPORTS: Record<string, string> = { running: "RUNNING", cycling: "CYCLING", swimming: "SWIMMING" };

/**
 * Picks the user's zones for this sport from /biometric-service/heartRateZones/v2
 * (an array of {sport, zone1Floor..zone5Floor, maxHeartRateUsed}), falling
 * back to the DEFAULT set.
 */
export function zonesFromApi(payload: unknown, sport: string | undefined): HrZones | undefined {
	if (!Array.isArray(payload)) return undefined;
	const sets = payload.filter((z): z is Record<string, unknown> => typeof z === "object" && z !== null);
	const want = ZONE_SPORTS[sport ?? ""];
	const z = sets.find((x) => want && x.sport === want) ?? sets.find((x) => x.sport === "DEFAULT") ?? sets[0];
	if (!z) return undefined;
	const floors = [1, 2, 3, 4, 5].map((n) => z[`zone${n}Floor`]);
	if (!floors.every((f): f is number => typeof f === "number" && f > 0)) return undefined;
	const max = typeof z.maxHeartRateUsed === "number" ? z.maxHeartRateUsed : undefined;
	const method = typeof z.trainingMethod === "string" ? z.trainingMethod.toLowerCase().replace(/_/g, " ") : undefined;
	return {
		floors: floors as HrZones["floors"],
		max,
		source: `current Garmin ${String(z.sport ?? "default").toLowerCase()} zones${method ? ` (${method})` : ""}`,
	};
}

/** h:mm:ss or m:ss. */
export function clock(seconds: number): string {
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function pace(metres: number, seconds: number, unit: Unit): string | undefined {
	if (metres <= 0 || seconds <= 0) return undefined;
	return `${clock((seconds / metres) * (unit === "km" ? KM : MILE))} /${unit === "km" ? "km" : "mi"}`;
}

/** Pace for foot sports, speed (km/h or mph) for everything else. */
function paceOrSpeed(a: Analysis, metres: number, seconds: number, unit: Unit): Record<string, unknown> {
	if (a.cadenceUnit === "spm") return { pace: pace(metres, seconds, unit) };
	const perHour = seconds > 0 ? (metres / seconds) * 3.6 * (unit === "km" ? 1 : KM / MILE) : undefined;
	return { [unit === "km" ? "speed_kmh" : "speed_mph"]: perHour === undefined ? undefined : round(perHour, 1) };
}

const r0 = (n: number | undefined) => (n === undefined ? undefined : Math.round(n));

function segmentRow(seg: Segment, unit: Unit, a: Analysis): Record<string, unknown> {
	const elev = unit === "km" ? 1 : 3.28084;
	const eu = unit === "km" ? "m" : "ft";
	return {
		time: clock(seg.time),
		...paceOrSpeed(a, seg.distance, seg.time, unit),
		cumulative: clock(seg.cumulative),
		avg_hr: r0(seg.avgHr),
		max_hr: r0(seg.maxHr),
		[`cadence_${a.cadenceUnit}`]: r0(seg.cadence),
		power_w: r0(seg.power),
		[`elev_gain_${eu}`]: seg.gain === undefined ? undefined : r0(seg.gain * elev),
		[`elev_loss_${eu}`]: seg.loss === undefined ? undefined : r0(seg.loss * elev),
	};
}

const toUnit = (metres: number, unit: Unit) => round(metres / (unit === "km" ? KM : MILE), 2);

export function formatSplits(a: Analysis, unit: Unit): Record<string, unknown>[] | string {
	const rows = a.splits?.[unit];
	if (!rows?.length) return "no distance data in this activity";
	const full = unit === "km" ? KM : MILE;
	return rows.map((seg, i) => ({
		split: seg.distance >= full - 0.5 ? String(i + 1) : `last ${toUnit(seg.distance, unit)} ${unit === "km" ? "km" : "mi"}`,
		...segmentRow(seg, unit, a),
	}));
}

export function formatLaps(a: Analysis, unit: Unit): Record<string, unknown>[] | string {
	if (!a.laps.length) return "no laps recorded";
	return a.laps.map((lap, i) => ({
		lap: i + 1,
		[`distance_${unit === "km" ? "km" : "mi"}`]: toUnit(lap.distance, unit),
		...segmentRow(lap, unit, a),
		intensity: lap.intensity,
		trigger: lap.trigger,
	}));
}

export function formatBestEfforts(a: Analysis, unit: Unit): Record<string, unknown>[] | string {
	if (!a.bestEfforts?.length) return "activity too short (under 1 km) or has no distance data";
	return a.bestEfforts.map((e) => ({
		distance: e.label,
		time: clock(e.time),
		...paceOrSpeed(a, e.distance, e.time, unit),
		avg_hr: r0(e.avgHr),
		[`starts_at_${unit === "km" ? "km" : "mi"}`]: toUnit(e.startDistance, unit),
		starts_at_time: clock(e.startTime),
	}));
}

/**
 * Time in HR zones: the watch's own figures when the FIT file has them (they
 * match Garmin Connect and summarize_activities), else a recount of the HR
 * samples against `zones` (the user's current zones).
 */
export function formatHrZones(a: Analysis, current?: HrZones): Record<string, unknown> | string {
	if (!a.hasHr) return "no heart rate recorded";
	const zones = a.recordedZones ?? current;
	if (!zones) return "no HR zones set in Garmin Connect";
	let secs: number[];
	if (a.recordedZones) secs = [...a.recordedZones.seconds];
	else {
		secs = [0, 0, 0, 0, 0, 0]; // below zone 1, zones 1-5
		for (const [bpm, t] of a.hrHistogram) {
			let z = 0;
			while (z < 5 && bpm >= zones.floors[z]!) z++;
			secs[z]! += t;
		}
	}
	const total = secs.reduce((n, t) => n + t, 0);
	if (total <= 0) return "no heart rate recorded";
	const rows = secs.map((t, z) => ({
		zone: z === 0 ? "below 1" : z,
		bpm:
			z === 0
				? `<${zones.floors[0]}`
				: z === 5
					? `${zones.floors[4]}${zones.max ? `-${zones.max}` : "+"}`
					: `${zones.floors[z - 1]}-${zones.floors[z]! - 1}`,
		minutes: round(t / 60, 1),
		pct: Math.round((t / total) * 100),
	}));
	return { zones_source: zones.source, zones: rows.filter((r) => r.zone !== "below 1" || r.minutes > 0) };
}

export function formatDrift(a: Analysis, unit: Unit): Record<string, unknown> | string {
	const d = a.drift;
	if (!d) return "activity too short (under 1 km or 2 minutes) or has no distance data";
	const half = (h: Half) => ({
		[`distance_${unit === "km" ? "km" : "mi"}`]: toUnit(h.distance, unit),
		time: clock(h.time),
		...paceOrSpeed(a, h.distance, h.time, unit),
		avg_hr: r0(h.avgHr),
	});
	const speed = (h: Half) => h.distance / h.time;
	const out: Record<string, unknown> = {
		first_half: half(d.first),
		second_half: half(d.second),
		// Positive = second half slower (speed dropped), for pace and speed sports alike.
		pace_change_pct: round((speed(d.first) / speed(d.second) - 1) * 100, 1),
	};
	if (d.first.avgHr && d.second.avgHr) {
		const ef1 = speed(d.first) / d.first.avgHr;
		const ef2 = speed(d.second) / d.second.avgHr;
		out.hr_change_pct = round((d.second.avgHr / d.first.avgHr - 1) * 100, 1);
		out.decoupling_pct = round(((ef1 - ef2) / ef1) * 100, 1);
	}
	out.note =
		"Halves split by timer time. pace_change_pct > 0 means the second half was slower. " +
		"decoupling_pct is pace:HR (aerobic) decoupling; under ~5% on a steady effort usually means good aerobic endurance." +
		(a.structured ? " This activity has warm-up/cool-down or rest laps, so the halves mix different efforts; read decoupling with care." : "");
	return out;
}

/** Builds the tool response for the requested sections. */
export function formatAnalysis(
	a: Analysis,
	opts: { unit: Unit; include: readonly Section[]; zones?: HrZones; zonesUnavailable?: string },
): Record<string, unknown> {
	const { unit, include } = opts;
	const out: Record<string, unknown> = {
		sport: a.sport,
		unit,
		[`distance_${unit === "km" ? "km" : "mi"}`]: a.distance === undefined ? undefined : toUnit(a.distance, unit),
		timer_time: clock(a.time),
	};
	const unavailable: string[] = [];
	for (const section of include) {
		switch (section) {
			case "splits":
				out.splits = formatSplits(a, unit);
				break;
			case "laps":
				out.laps = formatLaps(a, unit);
				break;
			case "best_efforts":
				out.best_efforts = formatBestEfforts(a, unit);
				break;
			case "hr_zones":
				if (a.recordedZones || opts.zones) out.hr_zones = formatHrZones(a, opts.zones);
				else unavailable.push(`hr_zones: ${opts.zonesUnavailable ?? "no HR zones set in Garmin Connect"}`);
				break;
			case "drift":
				out.drift = formatDrift(a, unit);
				break;
		}
	}
	if (unavailable.length) out.unavailable = unavailable;
	return out;
}
