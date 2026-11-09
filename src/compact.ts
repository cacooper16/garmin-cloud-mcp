/**
 * Shrinks Garmin payloads before they reach the model. Field names come from
 * Garmin's Personal API Swagger spec. Every compactor tolerates missing fields
 * and only ever drops data that's noise (nulls, ids, duplicate timestamps) or
 * replaces a high-frequency series with a summary of the same series.
 */

import { weekday } from "./periods.ts";
import { chooseOffsetMs, localFromPair, localStamp, localizeTimes, recordOffsetMs } from "./times.ts";
import { isObj, num, paceFrom, type Raw, round, typeKeyOf } from "./util.ts";

// createTimeStamp: when Garmin created a record (e.g. the HRV summary), zone
// unstated; not a time anything happened to the user, so it's only confusing.
const NOISE_KEYS = /^(userProfilePk|userProfilePK|userProfileId|userId|ownerId|uuid|activityUuid|activityUUID|deviceId|ownerProfileImageUrl\w*|ownerDisplayName|ownerFullName|createTimeStamp)$/;

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

/**
 * One night from DailySleepDTO, durations in hours. `timeZone` is the user's
 * Garmin profile zone, used for start/end (see chooseOffsetMs).
 */
export function compactSleep(s: Raw, timeZone?: string): Raw {
	const scores = isObj(s.sleepScores) ? s.sleepScores : {};
	const overall = isObj(scores.overall) ? scores.overall : {};
	const factors: Raw = {};
	for (const [k, v] of Object.entries(scores)) {
		if (k === "overall" || !isObj(v)) continue;
		factors[k] = v.qualifierKey ?? v.value;
	}
	const need = isObj(s.sleepNeed) ? s.sleepNeed : {};
	const next = isObj(s.nextSleepNeed) ? s.nextSleepNeed : {};
	// What moved tonight's sleep need off baseline. trainingFeedback is the
	// closest the Personal API gets to Garmin's training status (e.g. HIGH_ACWR_AND_CHRONIC).
	const drivers = defined({
		training: need.trainingFeedback ?? undefined,
		hrv: need.hrvAdjustment ?? undefined,
		sleep_history: need.sleepHistoryAdjustment ?? undefined,
		nap: need.napAdjustment ?? undefined,
	});
	return defined({
		date: s.calendarDate,
		dow: typeof s.calendarDate === "string" ? weekday(s.calendarDate) : undefined,
		start_local: localFromPair(s.sleepStartTimestampGMT, s.sleepStartTimestampLocal, timeZone),
		end_local: localFromPair(s.sleepEndTimestampGMT, s.sleepEndTimestampLocal, timeZone),
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
		lowest_respiration: num(s.lowestRespirationValue),
		highest_respiration: num(s.highestRespirationValue),
		avg_spo2: num(s.averageSpO2Value),
		lowest_spo2: num(s.lowestSpO2Value),
		sleep_need_min: num(need.actual),
		sleep_need_baseline_min: num(need.baseline),
		sleep_need_feedback: need.feedback ?? undefined,
		sleep_need_drivers: Object.keys(drivers).length ? drivers : undefined,
		next_sleep_need_min: num(next.actual),
		next_sleep_need_feedback: next.feedback ?? undefined,
		insight: s.sleepScoreInsight && s.sleepScoreInsight !== "NONE" ? s.sleepScoreInsight : undefined,
		personalized_insight: s.sleepScorePersonalizedInsight ?? undefined,
	});
}

// ---- body battery -------------------------------------------------------

/**
 * Finds a column index in Garmin's [descriptor list] + [[row]] layout.
 * Descriptors are {index, key}, or for Body Battery
 * {bodyBatteryValueDescriptorIndex, bodyBatteryValueDescriptorKey}.
 */
function column(descriptors: unknown, match: RegExp, fallback: number): number {
	if (Array.isArray(descriptors)) {
		for (const d of descriptors) {
			if (!isObj(d)) continue;
			const key = d.key ?? d.bodyBatteryValueDescriptorKey ?? d.spo2ValueDescKey;
			const index = d.index ?? d.bodyBatteryValueDescriptorIndex ?? d.spo2ValueDescIndex;
			if (typeof key === "string" && match.test(key) && typeof index === "number") return index;
		}
	}
	return fallback;
}

/** "HH:MM" local time for a GMT epoch in ms, given the record's offset and the profile zone. */
const hhmm = (ms: number, offsetMs: number | undefined, timeZone: string | undefined) =>
	new Date(ms + chooseOffsetMs(ms, offsetMs, timeZone)).toISOString().slice(11, 16);

/**
 * One day's Body Battery report. The Personal API only carries a handful of
 * key readings per day (midnight, the overnight peak, a few daytime points,
 * the last reading), so they're returned as-is in local time with min/max.
 */
export function compactBodyBattery(r: Raw, timeZone?: string): Raw {
	const rows = (Array.isArray(r.bodyBatteryValuesArray) ? (r.bodyBatteryValuesArray as unknown[]) : []).filter(Array.isArray);
	const lvl = column(r.bodyBatteryValueDescriptorDTOList, /level/i, rows[0]?.length === 2 ? 1 : 2);
	const ts = column(r.bodyBatteryValueDescriptorDTOList, /timestamp/i, 0);
	const off = recordOffsetMs(r);
	const readings = rows.flatMap((row) => {
		const t = num(row[ts]);
		const v = num(row[lvl]);
		return v === undefined ? [] : [{ time: t !== undefined && t > 1e11 ? hhmm(t, off, timeZone) : undefined, level: v }];
	});
	const levels = readings.map((x) => x.level);
	// Event and feedback times come as GMT only; each event carries its own offset.
	const events = Array.isArray(r.bodyBatteryActivityEvent)
		? (r.bodyBatteryActivityEvent as unknown[]).filter(isObj).map((e) => stripNoise(localizeTimes(e, off, timeZone)))
		: undefined;
	return defined({
		date: r.date,
		charged: num(r.charged),
		drained: num(r.drained),
		highest: levels.length ? Math.max(...levels) : undefined,
		lowest: levels.length ? Math.min(...levels) : undefined,
		readings_local: readings.length ? readings.map((x) => defined({ ...x })) : undefined,
		events: events?.length ? events : undefined,
		feedback: stripNoise(localizeTimes(r.endOfDayBodyBatteryDynamicFeedbackEvent ?? r.bodyBatteryDynamicFeedbackEvent, off, timeZone)) ?? undefined,
	});
}

// ---- intraday heart rate and SpO2 --------------------------------------

/** A local time-of-day window, "HH:MM" inclusive at both ends. */
export type TimeWindow = { from?: string; to?: string };

/**
 * Intraday HR (a reading every ~2 minutes) reduced to hourly min/avg/max in
 * local time, keeping the day's resting/min/max and 7-day resting average.
 * With a window, every reading inside it is returned too.
 */
export function compactHeartRate(d: Raw, window?: TimeWindow, timeZone?: string): Raw {
	const rows = Array.isArray(d.heartRateValues) ? (d.heartRateValues as unknown[][]) : [];
	const ts = column(d.heartRateValueDescriptors, /time/i, 0);
	const hr = column(d.heartRateValueDescriptors, /heart|rate|value/i, 1);
	const off = recordOffsetMs(d);
	const buckets = new Map<string, number[]>();
	const inWindow: [string, number][] = [];
	const from = window?.from ?? "00:00";
	const to = window?.to ?? "23:59";
	for (const row of rows) {
		if (!Array.isArray(row)) continue;
		const t = num(row[ts]);
		const v = num(row[hr]);
		if (t === undefined || v === undefined || v <= 0) continue;
		const time = hhmm(t, off, timeZone);
		if (window && time >= from && time <= to) inWindow.push([time, v]);
		const hour = time.slice(0, 2);
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
		readings_local: window ? (inWindow.length ? inWindow : `no readings between ${from} and ${to}`) : undefined,
	});
}

/**
 * SpO2 day: keeps averages and the hourly series, drops per-reading and
 * altitude series. Hourly rows lead with a GMT epoch, returned as local time.
 */
export function compactSpo2(d: Raw, timeZone?: string): Raw {
	const {
		spO2SingleValues: _a,
		spO2SingleValuesDescriptorList: _b,
		monitoringEnvironmentValues: _c,
		monitoringEnvironmentValuesDescriptorList: _d,
		...rest
	} = d;
	const off = recordOffsetMs(d);
	const ts = column(d.spO2HourlyAveragesDescriptorList, /timestamp/i, 0);
	if (Array.isArray(rest.spO2HourlyAverages)) {
		rest.spO2HourlyAverages = (rest.spO2HourlyAverages as unknown[]).map((row) => {
			const t = Array.isArray(row) ? row[ts] : undefined;
			return typeof t === "number" ? (row as unknown[]).map((x, i) => (i === ts ? (localStamp(t + chooseOffsetMs(t, off, timeZone)) ?? x) : x)) : row;
		});
	}
	return stripNoise(localizeTimes(rest, off, timeZone)) as Raw;
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

const SPLIT_FIELDS = [
	"splitType",
	"noOfSplits",
	"distance",
	"duration",
	"averageSpeed",
	"avgGradeAdjustedSpeed",
	"averageHR",
	"elevationGain",
	"averageRunCadence",
	"averagePower",
	"groundContactTime",
] as const;

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
	out.startTimeLocal = localStamp(sum.startTimeLocal) ?? sum.startTimeLocal;
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
