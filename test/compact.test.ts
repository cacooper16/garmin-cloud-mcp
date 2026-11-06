import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeActivities, trainingLoadRatio } from "../src/activities.ts";
import {
	compactActivityDetail,
	compactBodyBattery,
	compactDailySummary,
	compactHeartRate,
	compactSleep,
	compactSpo2,
	stripNoise,
} from "../src/compact.ts";
import { resolvePeriod, todayIn, weekday, weekStart } from "../src/periods.ts";
import { daysBetween, mergeChunks, mapLimit, splitRange } from "../src/ranges.ts";
import { num, paceFrom, typeKeyOf } from "../src/util.ts";
import { buildReadiness, joinByDate, summarizeWellness } from "../src/wellness.ts";

// Shapes follow Garmin's Personal API Swagger spec.
const dailyV2 = (date: string, rhr: number, steps: number) => ({
	uuid: "x",
	userProfilePk: 1,
	calendarDate: date,
	source: "WATCH",
	wellnessChronology: { startTimestampGmt: "a", startTimestampLocal: "b" },
	movement: { steps: { goal: 8000, value: steps, distanceInMeters: 7123 }, floorsAscended: { value: 9 } },
	calories: { burnedTotal: 2400, burnedActive: 600, consumedGoal: null },
	heartRate: { minValue: 45, maxValue: 160, restingValue: rhr, alertCount: 0 },
	intensityMinutes: { goal: 150, moderate: 20, vigorous: 10 },
	stress: { avgLevel: 30, maxLevel: 90, qualifier: "BALANCED", restDurationInMillis: 1 },
	bodyBattery: { minValue: 20, maxValue: 85, chargedValue: 60, drainedValue: 65, endOfDayValue: 25 },
	respiration: { avgValue: 14 },
	pulseOx: { avgValue: 96 },
});

const sleepDto = (date: string, hours: number, score: number) => ({
	id: 1,
	userProfilePK: 1,
	calendarDate: date,
	sleepTimeSeconds: hours * 3600,
	deepSleepSeconds: 5400,
	lightSleepSeconds: 14400,
	remSleepSeconds: 5400,
	awakeSleepSeconds: 600,
	napTimeSeconds: 0,
	sleepStartTimestampGMT: "2026-11-04T22:00:00.0",
	sleepStartTimestampLocal: "2026-11-04T23:00:00.0",
	sleepScores: {
		overall: { value: score, qualifierKey: "GOOD" },
		deepPercentage: { value: 20, qualifierKey: "EXCELLENT", optimalStart: 16, optimalEnd: 33 },
	},
	sleepNeed: { actual: 480, feedback: "NO_CHANGE", userProfilePk: 1, recommendedBedtimeStartMins: 1 },
	avgHeartRate: 52,
	averageRespirationValue: 14,
	spo2Threshold: null,
});

describe("stripNoise", () => {
	it("drops nulls, empties, ids and GMT twins but keeps tuple positions", () => {
		const out = stripNoise({
			userProfilePk: 1,
			a: null,
			b: [],
			c: {},
			d: "",
			startTimestampGMT: "g",
			startTimestampLocal: "l",
			latestTimestampGmt: "only-gmt",
			series: [
				[1, null],
				[2, 60],
			],
			nested: { uuid: "x", keep: 0, gone: null },
		});
		assert.deepEqual(out, {
			startTimestampLocal: "l",
			latestTimestampGmt: "only-gmt",
			series: [
				[1, null],
				[2, 60],
			],
			nested: { keep: 0 },
		});
	});
});

describe("compactors", () => {
	it("flattens a V2 daily summary", () => {
		const r = compactDailySummary(dailyV2("2026-11-05", 50, 9876));
		assert.equal(r.steps, 9876);
		assert.equal(r.distance_km, 7.12);
		assert.equal(r.resting_hr, 50);
		assert.equal(r.body_battery_max, 85);
		assert.equal(r.stress_qualifier, "BALANCED");
		assert.ok(!("uuid" in r) && !("wellnessChronology" in r));
	});

	it("turns sleep into hours with score factors", () => {
		const r = compactSleep(sleepDto("2026-11-05", 7.5, 82));
		assert.equal(r.sleep_h, 7.5);
		assert.equal(r.deep_h, 1.5);
		assert.equal(r.score, 82);
		assert.deepEqual(r.score_factors, { deepPercentage: "EXCELLENT" });
		assert.equal(r.sleep_need_min, 480);
		assert.ok(!("nap_h" in r), "zero naps omitted");
	});

	it("reduces Body Battery readings to highest/lowest", () => {
		const r = compactBodyBattery({
			date: "2026-11-05",
			charged: 60,
			drained: 55,
			bodyBatteryValueDescriptorDTOList: [
				{ index: 0, key: "timestamp" },
				{ index: 1, key: "bodyBatteryStatus" },
				{ index: 2, key: "bodyBatteryLevel" },
			],
			bodyBatteryValuesArray: [
				[1, "MEASURED", 30],
				[2, "MEASURED", 88],
				[3, "MEASURED", 12],
			],
			bodyBatteryActivityEvent: [{ eventType: "SLEEP", bodyBatteryImpact: 55, userProfilePk: 1 }],
		});
		assert.deepEqual(r, {
			date: "2026-11-05",
			charged: 60,
			drained: 55,
			highest: 88,
			lowest: 12,
			events: [{ eventType: "SLEEP", bodyBatteryImpact: 55 }],
		});
	});

	it("buckets intraday HR into local hours", () => {
		const start = Date.parse("2026-11-05T05:00:00Z"); // local midnight at UTC-5
		const values = Array.from({ length: 60 }, (_, i) => [start + i * 120_000, 50 + (i % 30)]);
		values.push([start + 1000, null as unknown as number]);
		const r = compactHeartRate({
			calendarDate: "2026-11-05",
			startTimestampGMT: "2026-11-05T05:00:00.0",
			startTimestampLocal: "2026-11-05T00:00:00.0",
			restingHeartRate: 48,
			heartRateValueDescriptors: [
				{ index: 0, key: "timestamp" },
				{ index: 1, key: "heartrate" },
			],
			heartRateValues: values,
		});
		const hourly = r.hourly_local as { hour: string; min: number; max: number }[];
		assert.deepEqual(
			hourly.map((h) => h.hour),
			["00:00", "01:00"],
		);
		assert.equal(hourly[0]!.min, 50);
		assert.equal(hourly[0]!.max, 79);
		assert.equal(r.resting_hr, 48);
	});

	it("drops per-reading SpO2 series", () => {
		const r = compactSpo2({ averageSpO2: 95, spO2SingleValues: [[1, 95]], spO2HourlyAverages: [[1, 95]] });
		assert.deepEqual(r, { averageSpO2: 95, spO2HourlyAverages: [[1, 95]] });
	});
});

describe("ranges", () => {
	it("splits to Garmin's limits", () => {
		assert.deepEqual(splitRange("2026-01-01", "2026-03-01", 31), [
			["2026-01-01", "2026-01-31"],
			["2026-02-01", "2026-03-01"],
		]);
		assert.deepEqual(splitRange("2026-01-01", "2026-01-01", 28), [["2026-01-01", "2026-01-01"]]);
		assert.equal(splitRange("2026-01-01", "2026-12-31", 31).length, 12);
	});

	it("merges arrays and single-array wrappers", () => {
		assert.deepEqual(mergeChunks([[1], [2, 3]]), [1, 2, 3]);
		assert.deepEqual(mergeChunks([{ data: [1] }, { data: [2] }]), { data: [1, 2] });
		assert.deepEqual(mergeChunks([{ hrvSummaries: [1], userProfilePk: 9 }, { hrvSummaries: [2] }]), {
			hrvSummaries: [1, 2],
			userProfilePk: 9,
		});
	});

	it("limits concurrency and keeps order", async () => {
		let inFlight = 0;
		let peak = 0;
		const out = await mapLimit([5, 1, 3, 2, 4, 0], 2, async (n) => {
			peak = Math.max(peak, ++inFlight);
			await new Promise((r) => setTimeout(r, n));
			inFlight--;
			return n * 10;
		});
		assert.deepEqual(out, [50, 10, 30, 20, 40, 0]);
		assert.equal(peak, 2);
	});
});

describe("wellness", () => {
	const dates = Array.from({ length: 8 }, (_, i) => `2026-11-0${i + 1}`.replace("-010", "-10"));
	const rows = joinByDate(
		dates.map((d, i) => dailyV2(d, 50 + i, 10000)),
		dates.map((d, i) => sleepDto(d, 7 + i * 0.1, 70 + i)),
		dates.map((d, i) => ({ calendarDate: d, lastNightAvg: 40 + i, weeklyAvg: 44, status: "BALANCED" })),
	);

	it("summarizes per month with ranges and totals", () => {
		const [g] = summarizeWellness(rows, "month");
		assert.equal(g!.period, "2026-11");
		assert.equal(g!.days, 8);
		assert.equal(g!.resting_hr, 53.5);
		assert.deepEqual(g!.resting_hr_range, [50, 57]);
		assert.equal(g!.intensity_vigorous_min_total, 80);
		assert.equal(g!.hrv_overnight, 43.5);
		assert.ok(JSON.stringify(g).length < 700);
	});

	it("reports partial coverage instead of hiding gaps", () => {
		const gappy = joinByDate([dailyV2("2026-11-01", 50, 1)], [sleepDto("2026-11-02", 7, 80)], []);
		const [g] = summarizeWellness(gappy, "total");
		assert.equal(g!.days, 2);
		assert.equal(g!.resting_hr_days, 1);
		assert.equal(g!.sleep_h_days, 1);
	});

	it("compares the target day with the prior days", () => {
		const r = buildReadiness("2026-11-08", rows, []);
		assert.equal(r.resting_hr, 57);
		assert.equal(r.resting_hr_prior_avg, 53);
		assert.equal(r.prior_days_compared, 7);
		assert.equal((r.hrv as { last_night: number }).last_night, 47);
		assert.equal((r.sleep as { score: number }).score, 77);
	});
});

// ---- periods, weekday, training load, activity detail ----------------------


describe("shared helpers", () => {
	it("weekStart is the Monday on or before the date", () => {
		assert.equal(weekStart("2026-11-02"), "2026-11-02"); // Monday
		assert.equal(weekStart("2026-11-08"), "2026-11-02"); // Sunday
		assert.equal(weekStart("2026-01-01"), "2025-12-29"); // across a year boundary
	});

	it("daysBetween counts whole days, across DST and leap years", () => {
		assert.equal(daysBetween("2026-03-28", "2026-03-30"), 2);
		assert.equal(daysBetween("2028-02-28", "2028-03-01"), 2);
		assert.equal(daysBetween("2026-11-06", "2026-11-06"), 0);
	});

	it("paceFrom formats m:ss per unit and rounds 59.5s up to the next minute", () => {
		assert.equal(paceFrom(1000 / 300, 1000), "5:00");
		assert.equal(paceFrom(1000 / 299.6, 1000), "5:00");
		assert.equal(paceFrom(1000 / 359.6, 1000), "6:00");
		assert.equal(paceFrom(1, 100), "1:40");
		assert.equal(paceFrom(0, 1000), undefined);
		assert.equal(paceFrom(undefined, 1000), undefined);
	});

	it("num unwraps {value} and typeKeyOf reads nested type keys", () => {
		assert.equal(num({ value: 7 }), 7);
		assert.equal(num(Number.NaN), undefined);
		assert.equal(typeKeyOf({ activityType: { typeKey: "running" } }, "activityType"), "running");
		assert.equal(typeKeyOf({ activityType: null }, "activityType"), undefined);
		assert.equal(typeKeyOf({}, "eventType"), undefined);
	});
});

describe("periods", () => {
	const today = "2026-11-06"; // a Friday
	it("resolves named periods", () => {
		assert.deepEqual(resolvePeriod("yesterday", today), ["2026-11-05", "2026-11-05"]);
		assert.deepEqual(resolvePeriod("last_7_days", today), ["2026-10-31", "2026-11-06"]);
		assert.deepEqual(resolvePeriod("this_week", today), ["2026-11-02", "2026-11-06"]);
		assert.deepEqual(resolvePeriod("last_week", today), ["2026-10-26", "2026-11-01"]);
		assert.deepEqual(resolvePeriod("this_month", today), ["2026-11-01", "2026-11-06"]);
		assert.deepEqual(resolvePeriod("last_month", "2026-03-15"), ["2026-02-01", "2026-02-28"]);
		assert.deepEqual(resolvePeriod("last_month", "2026-01-10"), ["2025-12-01", "2025-12-31"]);
		assert.deepEqual(resolvePeriod("this_year", today), ["2026-01-01", "2026-11-06"]);
		assert.deepEqual(resolvePeriod("last_year", today), ["2025-01-01", "2025-12-31"]);
	});

	it("knows the user's today across time zones", () => {
		const now = new Date("2026-11-06T03:00:00Z");
		assert.equal(todayIn("Europe/London", now), "2026-11-06");
		assert.equal(todayIn("America/Los_Angeles", now), "2026-11-05");
		assert.equal(todayIn("Not/AZone", now), "2026-11-06");
		// Formats given as examples in Garmin's spec for UserSettingsDTO.timeZone.
		assert.equal(todayIn("gmt", now), "2026-11-06");
		assert.equal(todayIn("America/Chicago", now), "2026-11-05");
		assert.equal(todayIn("Atlantic/South_Georgia", now), "2026-11-06");
		assert.equal(weekday("2026-11-06"), "fri");
	});
});

describe("activity extras", () => {
	const act = (date: string, load: number, zones = [600, 1800, 300, 60, 0]) => ({
		startTimeLocal: `${date} 07:00:00`,
		activityType: { typeKey: "running" },
		distance: 8000,
		movingDuration: 2400,
		activityTrainingLoad: load,
		...Object.fromEntries(zones.map((z, i) => [`hrTimeInZone_${i + 1}`, z])),
	});

	it("totals training load and HR-zone time, and groups by weekday", () => {
		const rows = summarizeActivities([act("2026-11-02", 100), act("2026-11-04", 50), act("2026-11-09", 80)], "weekday");
		assert.deepEqual(
			rows.map((r) => [r.period, r.count, r.training_load]),
			[
				["mon", 2, 180],
				["wed", 1, 50],
			],
		);
		assert.deepEqual(rows[0]!.hr_zone_minutes, [20, 60, 10, 2, 0]);
		assert.deepEqual(rows[0]!.hr_zone_pct, [planPct(600), planPct(1800), planPct(300), planPct(60), 0]);
	});

	it("computes acute:chronic load from the last 7 vs 28 days", () => {
		// Four steady weeks of 300, then the current week at 600.
		const acts = [
			...[-27, -20, -13].map((d) => act(shiftDate("2026-11-06", d), 300)),
			act("2026-11-05", 600),
			act("2026-09-01", 9999), // outside the window
		];
		const r = trainingLoadRatio(acts, "2026-11-06") as Record<string, unknown>;
		assert.equal(r.acute_7d, 600);
		assert.equal(r.chronic_weekly_avg_28d, 375);
		assert.equal(r.ratio, 1.6);
		assert.match(String(r.band), /spike/);
		assert.equal(r.method, "garmin_training_load");
		assert.match(String((trainingLoadRatio([], "2026-11-06") as { note: string }).note), /no activities/);
	});

	it("falls back to HR-zone load, then moving minutes, without mixing measures", () => {
		const noLoad = (date: string, zones?: number[]) => {
			const a: Record<string, unknown> = { ...act(date, 0, zones) };
			delete a.activityTrainingLoad;
			if (!zones) for (let z = 1; z <= 5; z++) delete a[`hrTimeInZone_${z}`];
			return a;
		};
		// HR strap but no Garmin load: zone minutes x zone number. 10*1 + 30*2 + 5*3 + 1*4 = 89 per run.
		const hr = trainingLoadRatio([noLoad("2026-11-05", [600, 1800, 300, 60, 0]), noLoad("2026-10-20", [600, 1800, 300, 60, 0])], "2026-11-06") as Record<string, unknown>;
		assert.equal(hr.method, "hr_zone_trimp");
		assert.equal(hr.acute_7d, 89);
		assert.equal(hr.chronic_weekly_avg_28d, Math.round(178 / 4));

		// No HR at all: moving minutes (2400 s = 40 min).
		const mins = trainingLoadRatio([noLoad("2026-11-05"), noLoad("2026-10-20")], "2026-11-06") as Record<string, unknown>;
		assert.equal(mins.method, "moving_minutes");
		assert.equal(mins.acute_7d, 40);

		// Mostly Garmin load: one manual entry without load doesn't drag everyone down to minutes.
		const mostly = [...Array.from({ length: 9 }, (_, i) => act(shiftDate("2026-11-06", -i * 3), 100)), noLoad("2026-11-06")];
		const m = trainingLoadRatio(mostly, "2026-11-06") as Record<string, unknown>;
		assert.equal(m.method, "garmin_training_load");
		assert.equal(m.activities_without_value, 1);
	});

	it("compacts activity detail with pace", () => {
		const r = compactActivityDetail({
			activityId: 1,
			activityName: "Long run",
			activityTypeDTO: { typeKey: "running" },
			eventTypeDTO: { typeKey: "uncategorized" },
			accessControlRuleDTO: { typeKey: "private" },
			metadataDTO: { lots: "of stuff" },
			summaryDTO: {
				distance: 21097,
				movingDuration: 6329.1,
				averageMovingSpeed: 3.3333,
				averageHR: 150,
				leftPowerPhaseStart: 12,
			},
			splitSummaries: [{ splitType: "RWD_RUN", distance: 21000, duration: 6300, numClimbSends: 0, maxGradeValue: null }],
		});
		assert.equal(r.type, "running");
		assert.equal(r.pace_per_km, "5:00");
		assert.equal(r.pace_per_mi, "8:03");
		assert.ok(!("event" in r) && !("metadataDTO" in r) && !("leftPowerPhaseStart" in r));
		assert.deepEqual(r.splitSummaries, [{ splitType: "RWD_RUN", distance: 21000, duration: 6300 }]);
	});

	it("groups wellness by weekday in Monday-first order", () => {
		const rows = joinByDate(
			["2026-11-01", "2026-11-02", "2026-11-08"].map((d) => dailyV2(d, 50, 1000)),
			[],
			[],
		);
		const g = summarizeWellness(rows, "weekday");
		assert.deepEqual(
			g.map((r) => [r.period, r.days]),
			[
				["mon", 1],
				["sun", 2],
			],
		);
	});
});

function planPct(sec: number) {
	return Math.round((sec / 2760) * 100);
}
function shiftDate(date: string, n: number) {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}
