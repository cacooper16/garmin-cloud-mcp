/**
 * Shrinks Garmin payloads before they reach the model. Field names come from
 * Garmin's Personal API Swagger spec. Every compactor tolerates missing fields
 * and only ever drops data that's noise (nulls, ids, duplicate timestamps) or
 * replaces a high-frequency series with a summary of the same series.
 */

import { weekday } from "./periods.ts";
import { isObj, num, paceFrom, type Raw, round, typeKeyOf } from "./util.ts";

const NOISE_KEYS = /^(userProfilePk|userProfilePK|userProfileId|userId|ownerId|uuid|activityUuid|activityUUID|deviceId|ownerProfileImageUrl\w*|ownerDisplayName|ownerFullName)$/;

/**
 * Generic cleanup applied to every tool result: drops null/empty object
 * properties, internal ids, and GMT timestamps that duplicate a Local one.
 * Array elements are never removed, so positional tuples ([ts, value]) keep
 * their shape.
 */
export function stripNoise(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(stripNoise);
	if (!isObj(v)) return v;
	const out: Raw = {};
	for (const [k, raw] of Object.entries(v)) {
		if (NOISE_KEYS.test(k)) continue;
		const gmtTwin = k.replace(/(GMT|Gmt)$/, "Local");
		if (gmtTwin !== k && gmtTwin in v && v[gmtTwin] != null) continue;
		const val = stripNoise(raw);
		if (val === null || val === undefined || val === "") continue;
		if (Array.isArray(val) && val.length === 0) continue;
		if (isObj(val) && Object.keys(val).length === 0) continue;
		out[k] = val;
	}
	return out;
}

const hours = (s: unknown) => {
	const n = num(s);
	return n === undefined ? undefined : round(n / 3600, 2);
};

function defined(o: Raw): Raw {
	for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
	return o;
}

// ---- daily summaries ----------------------------------------------------

/** One flat row per day from /usersummary-service/v2/dailysummaries. */
export function compactDailySummary(d: Raw): Raw {
	const g = (o: unknown, k: string) => (isObj(o) ? o[k] : undefined);
	const steps = g(d.movement, "steps");
	const distance = num(g(steps, "distanceInMeters"));
	return defined({
		date: d.calendarDate,
		dow: typeof d.calendarDate === "string" ? weekday(d.calendarDate) : undefined,
		steps: num(g(steps, "value")),
		step_goal: num(g(steps, "goal")),
		distance_km: distance === undefined ? undefined : Math.round(distance / 10) / 100,
		floors: num(g(g(d.movement, "floorsAscended"), "value")),
		calories_total: num(g(d.calories, "burnedTotal")),
		calories_active: num(g(d.calories, "burnedActive")),
		resting_hr: num(g(d.heartRate, "restingValue")),
		hr_min: num(g(d.heartRate, "minValue")),
		hr_max: num(g(d.heartRate, "maxValue")),
		intensity_moderate_min: num(g(d.intensityMinutes, "moderate")),
		intensity_vigorous_min: num(g(d.intensityMinutes, "vigorous")),
		intensity_goal_min: num(g(d.intensityMinutes, "goal")),
		stress_avg: num(g(d.stress, "avgLevel")),
		stress_max: num(g(d.stress, "maxLevel")),
		stress_qualifier: g(d.stress, "qualifier") ?? undefined,
		body_battery_min: num(g(d.bodyBattery, "minValue")),
		body_battery_max: num(g(d.bodyBattery, "maxValue")),
		body_battery_charged: num(g(d.bodyBattery, "chargedValue")),
		body_battery_drained: num(g(d.bodyBattery, "drainedValue")),
		body_battery_end: num(g(d.bodyBattery, "endOfDayValue")),
		respiration_avg: num(g(d.respiration, "avgValue")),
		spo2_avg: num(g(d.pulseOx, "avgValue")),
		hydration_ml: num(g(d.hydration, "consumedInFractionalMl")),
	});
}

/** The daily summaries endpoint wraps rows in {data: [...]}. */
export function dailySummaryRows(payload: unknown): Raw[] {
	const rows = isObj(payload) ? payload.data : payload;
	return Array.isArray(rows) ? rows.filter(isObj) : [];
}

// ---- sleep --------------------------------------------------------------

/** One night from DailySleepDTO, durations in hours. */
export function compactSleep(s: Raw): Raw {
	const scores = isObj(s.sleepScores) ? s.sleepScores : {};
	const overall = isObj(scores.overall) ? scores.overall : {};
	const factors: Raw = {};
	for (const [k, v] of Object.entries(scores)) {
		if (k === "overall" || !isObj(v)) continue;
		factors[k] = v.qualifierKey ?? v.value;
	}
	const need = isObj(s.sleepNeed) ? s.sleepNeed : {};
	return defined({
		date: s.calendarDate,
		dow: typeof s.calendarDate === "string" ? weekday(s.calendarDate) : undefined,
		start_local: s.sleepStartTimestampLocal ?? undefined,
		end_local: s.sleepEndTimestampLocal ?? undefined,
		sleep_h: hours(s.sleepTimeSeconds),
		deep_h: hours(s.deepSleepSeconds),
		light_h: hours(s.lightSleepSeconds),
		rem_h: hours(s.remSleepSeconds),
		awake_h: hours(s.awakeSleepSeconds),
		nap_h: num(s.napTimeSeconds) ? hours(s.napTimeSeconds) : undefined,
		score: num(overall.value),
		score_quality: overall.qualifierKey ?? undefined,
		score_factors: Object.keys(factors).length ? factors : undefined,
		feedback: s.sleepScoreFeedback ?? undefined,
		awake_count: num(s.awakeCount),
		avg_hr: num(s.avgHeartRate),
		avg_stress: num(s.avgSleepStress),
		avg_respiration: num(s.averageRespirationValue),
		avg_spo2: num(s.averageSpO2Value),
		lowest_spo2: num(s.lowestSpO2Value),
		sleep_need_min: num(need.actual),
		sleep_need_feedback: need.feedback ?? undefined,
	});
}

// ---- body battery -------------------------------------------------------

type Descriptor = { index?: unknown; key?: unknown };

/** Finds a column index in Garmin's [descriptor list] + [[row]] layout. */
function column(descriptors: unknown, match: RegExp, fallback: number): number {
	if (Array.isArray(descriptors)) {
		for (const d of descriptors as Descriptor[]) {
			if (typeof d?.key === "string" && match.test(d.key) && typeof d.index === "number") return d.index;
		}
	}
	return fallback;
}

/** One day's Body Battery report, with the intraday readings reduced to min/max. */
export function compactBodyBattery(r: Raw): Raw {
	const rows = Array.isArray(r.bodyBatteryValuesArray) ? (r.bodyBatteryValuesArray as unknown[][]) : [];
	const lvl = column(r.bodyBatteryValueDescriptorDTOList, /level|value/i, 2);
	const levels = rows.map((row) => num(Array.isArray(row) ? row[lvl] : undefined)).filter((n) => n !== undefined);
	const events = Array.isArray(r.bodyBatteryActivityEvent)
		? (r.bodyBatteryActivityEvent as unknown[]).filter(isObj).map((e) => stripNoise(e))
		: undefined;
	return defined({
		date: r.date,
		charged: num(r.charged),
		drained: num(r.drained),
		highest: levels.length ? Math.max(...levels) : undefined,
		lowest: levels.length ? Math.min(...levels) : undefined,
		events: events?.length ? events : undefined,
		feedback: stripNoise(r.endOfDayBodyBatteryDynamicFeedbackEvent ?? r.bodyBatteryDynamicFeedbackEvent) ?? undefined,
	});
}

// ---- intraday heart rate and SpO2 --------------------------------------

/** Offset to add to a GMT epoch (ms) to get local wall-clock time. */
function localOffsetMs(d: Raw): number {
	const parse = (v: unknown) =>
		typeof v === "number" ? v : typeof v === "string" ? Date.parse(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`) : NaN;
	const off = parse(d.startTimestampLocal) - parse(d.startTimestampGMT);
	return Number.isFinite(off) ? off : 0;
}

/**
 * Intraday HR (a reading every ~2 minutes) reduced to hourly min/avg/max in
 * local time, keeping the day's resting/min/max and 7-day resting average.
 */
export function compactHeartRate(d: Raw): Raw {
	const rows = Array.isArray(d.heartRateValues) ? (d.heartRateValues as unknown[][]) : [];
	const ts = column(d.heartRateValueDescriptors, /time/i, 0);
	const hr = column(d.heartRateValueDescriptors, /heart|rate|value/i, 1);
	const off = localOffsetMs(d);
	const buckets = new Map<string, number[]>();
	for (const row of rows) {
		if (!Array.isArray(row)) continue;
		const t = num(row[ts]);
		const v = num(row[hr]);
		if (t === undefined || v === undefined || v <= 0) continue;
		const hour = new Date(t + off).toISOString().slice(11, 13);
		let b = buckets.get(hour);
		if (!b) buckets.set(hour, (b = []));
		b.push(v);
	}
	const hourly = [...buckets.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([hour, v]) => ({
			hour: `${hour}:00`,
			min: Math.min(...v),
			avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
			max: Math.max(...v),
		}));
	return defined({
		date: typeof d.calendarDate === "string" ? d.calendarDate : (num(d.calendarDate) ?? d.calendarDate),
		resting_hr: num(d.restingHeartRate),
		resting_hr_7d_avg: num(d.lastSevenDaysAvgRestingHeartRate),
		min_hr: num(d.minHeartRate),
		max_hr: num(d.maxHeartRate),
		readings: rows.length,
		hourly_local: hourly,
	});
}

/** SpO2 day: keeps averages and the hourly series, drops per-reading and altitude series. */
export function compactSpo2(d: Raw): Raw {
	const {
		spO2SingleValues: _a,
		spO2SingleValuesDescriptorList: _b,
		monitoringEnvironmentValues: _c,
		monitoringEnvironmentValuesDescriptorList: _d,
		...rest
	} = d;
	return stripNoise(rest) as Raw;
}

// ---- activity detail ----------------------------------------------------

const DETAIL_FIELDS = [
	"startTimeLocal",
	"distance",
	"duration",
	"movingDuration",
	"elapsedDuration",
	"elevationGain",
	"elevationLoss",
	"averageSpeed",
	"averageMovingSpeed",
	"maxSpeed",
	"avgGradeAdjustedSpeed",
	"averageHR",
	"maxHR",
	"minHR",
	"calories",
	"averageRunCadence",
	"averageBikeCadence",
	"averageSwimCadence",
	"strideLength",
	"groundContactTime",
	"verticalOscillation",
	"verticalRatio",
	"averagePower",
	"normalizedPower",
	"maxPower",
	"trainingEffect",
	"anaerobicTrainingEffect",
	"trainingEffectLabel",
	"activityTrainingLoad",
	"trainingStressScore",
	"intensityFactor",
	"averageTemperature",
	"avgRespirationRate",
	"recoveryHeartRate",
	"steps",
	"moderateIntensityMinutes",
	"vigorousIntensityMinutes",
	"differenceBodyBattery",
	"directWorkoutFeel",
	"directWorkoutRpe",
	"averageSWOLF",
	"poolLength",
	"totalNumberOfStrokes",
	"totalSets",
	"totalReps",
] as const;

const SPLIT_FIELDS = ["splitType", "noOfSplits", "distance", "duration", "averageSpeed", "averageHR", "elevationGain"] as const;

/**
 * One activity from /activity-service/activity/{id}, reduced from 200+ summary
 * fields to the ones that describe the effort, with pace precomputed.
 * Units: metres, seconds, m/s, bpm, watts, Celsius.
 */
export function compactActivityDetail(a: Raw): Raw {
	const sum = isObj(a.summaryDTO) ? a.summaryDTO : {};
	const type = typeKeyOf(a, "activityTypeDTO");
	const event = typeKeyOf(a, "eventTypeDTO");
	const out: Raw = {
		activityId: a.activityId,
		activityName: a.activityName,
		type,
		event: event === "uncategorized" ? undefined : event,
		location: a.locationName,
		description: a.description,
	};
	for (const f of DETAIL_FIELDS) out[f] = sum[f];
	const speed = num(sum.averageMovingSpeed) ?? num(sum.averageSpeed);
	if (type !== "swimming" && type !== "lap_swimming" && type !== "open_water_swimming") {
		out.pace_per_km = paceFrom(speed, 1000);
		out.pace_per_mi = paceFrom(speed, 1609.344);
	} else {
		out.pace_per_100m = paceFrom(speed, 100);
	}
	if (Array.isArray(a.splitSummaries)) {
		out.splitSummaries = (a.splitSummaries as unknown[]).filter(isObj).map((sp) => {
			const row: Raw = {};
			for (const f of SPLIT_FIELDS) row[f] = sp[f];
			return row;
		});
	}
	return stripNoise(out) as Raw;
}
