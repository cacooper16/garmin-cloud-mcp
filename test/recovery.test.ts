import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays } from "../src/ranges.ts";
import { compareByMeasure, linearFit, MIN_GROUP, median, pairRuns, pearson, sourcesFor } from "../src/recovery.ts";
import type { DayRow } from "../src/wellness.ts";
import { callGarminTool } from "./tool-harness.ts";

/**
 * The runner's own speed-for-HR line in these tests, the realistic shape:
 * speed rises with HR above resting (m/s = 0.035 x (bpm - 60); HR 130 -> 6:48/km,
 * 165 -> 4:32/km), so metres per heartbeat rises with speed.
 */
const line = (hr: number) => 0.035 * (hr - 60);
/** Small deterministic scatter around the line, unrelated to sleep. */
const noise = (i: number) => ((i * 7) % 5 - 2) * 0.02;

/**
 * `n` days with one 40-minute run each. Sleep score is 60 + i. `hr(i)` and
 * `speed(i, hr)` shape the runs.
 */
function season(n: number, opts: { hr?: (i: number) => number; speed?: (i: number, hr: number) => number } = {}) {
	const activities: Record<string, unknown>[] = [];
	const rows: DayRow[] = [];
	for (let i = 0; i < n; i++) {
		const date = addDays("2026-03-01", i);
		const hr = opts.hr?.(i) ?? 130 + ((i * 11) % 36); // spread over 130-165, unrelated to sleep
		const speed = opts.speed?.(i, hr) ?? line(hr) + noise(i);
		activities.push({
			activityId: i + 1,
			startTimeLocal: `${date} 07:00:00`,
			distance: speed * 2400,
			movingDuration: 2400,
			averageHR: hr,
			activityType: { typeKey: "running" },
		});
		rows.push({
			date,
			sleep: { score: 60 + i, sleep_h: 6 + i / 20 },
			hrv: { lastNightAvg: 40 + (i % 7) },
			daily: { body_battery_max: 50 + i },
		});
	}
	return { activities, rows };
}

describe("pairRuns", () => {
	it("leaves out races, short runs, manual entries and runs without HR", () => {
		const { activities, rows } = season(3);
		activities.push(
			{ activityId: 90, startTimeLocal: "2026-03-01 09:00:00", distance: 10_000, movingDuration: 2400, averageHR: 180, eventType: { typeKey: "race" } },
			{ activityId: 91, startTimeLocal: "2026-03-01 18:00:00", distance: 3000, movingDuration: 900, averageHR: 150 },
			{ activityId: 92, startTimeLocal: "2026-03-02 18:00:00", distance: 8000, duration: 2400, manualActivity: true },
			{ activityId: 93, startTimeLocal: "2026-03-03 18:00:00", distance: 8000, movingDuration: 2400 },
		);
		const { runs, excluded } = pairRuns(activities, rows);
		assert.equal(runs.length, 3);
		assert.deepEqual(excluded, { races: 1, under_20_min: 1, manual: 1, no_hr_or_distance: 1 });
	});

	it("pairs a run with the night it followed", () => {
		const { activities, rows } = season(1, { hr: () => 150, speed: () => 10_000 / 3000 });
		const [run] = pairRuns(activities, rows).runs;
		assert.equal(run!.speed.toFixed(4), (10_000 / 3000).toFixed(4));
		assert.equal(run!.secPerMetre.toFixed(4), "0.3000");
		assert.equal(run!.hr, 150);
		assert.deepEqual(run!.wellness, { sleep_score: 60, sleep_hours: 6, overnight_hrv: 40, morning_body_battery: 50 });
	});
});

describe("compareByMeasure", () => {
	it("doesn't mistake easy runs after good nights for worse running (the confound)", () => {
		// Good-sleep days are all easy runs (low HR, slow); bad-sleep days are hard
		// ones. Every run sits on the same speed-for-HR line: sleep has no effect.
		const { activities, rows } = season(30, { hr: (i) => 165 - i * 1.2 });
		const { runs } = pairRuns(activities, rows);
		const r = compareByMeasure(runs, "sleep_score", "km") as any;
		assert.equal(r.best_third.n, 10);
		assert.equal(r.worst_third.n, 10);
		assert.ok(r.best_third.avg_hr < r.worst_third.avg_hr - 20, "easy runs after good nights");
		// Metres per heartbeat (the old measure) would call these runs ~6% less efficient.
		const mpb = (g: typeof runs) => median(g.map((x) => (x.speed * 60) / x.hr));
		assert.ok(mpb(runs.slice(-10)) < mpb(runs.slice(0, 10)) * 0.95, "the old measure is fooled");
		// At the same HR there's no difference, and no relationship is claimed.
		assert.ok(Math.abs(r.difference_s_per_km_at_same_hr) <= 3, String(r.difference_s_per_km_at_same_hr));
		assert.equal(r.meaningful, false);
		assert.doesNotMatch(r.result, /relationship \(/);
		assert.match(r.result, /too weak to call a relationship/);
		assert.match(r.result, /differs by \d+ bpm, so they hold different kinds of runs \(easier ones after better nights\)/);
	});

	it("finds a real effect: faster for the same HR after better nights", () => {
		// HR unrelated to sleep; the better the night, the further above the line.
		const { activities, rows } = season(30, { speed: (i, hr) => line(hr) + (i - 15) * 0.006 + noise(i) * 0.5 });
		const r = compareByMeasure(pairRuns(activities, rows).runs, "sleep_score", "km") as any;
		assert.ok(r.difference_s_per_km_at_same_hr < -5, String(r.difference_s_per_km_at_same_hr));
		assert.ok(r.best_third.vs_expected_s_per_km < 0 && r.worst_third.vs_expected_s_per_km > 0);
		assert.ok(r.correlation_r >= 0.3, String(r.correlation_r));
		assert.equal(r.meaningful, true);
		assert.match(r.result, /s\/km faster for the same heart rate than after the worst third\. r = 0\.\d+: a (moderate|strong) relationship \(better nights, faster runs for the effort\)/);
		assert.ok(Math.abs(r.avg_hr_difference) <= 8);
		assert.doesNotMatch(r.result, /different kinds of runs/);
	});

	it("says there isn't enough data, and draws no conclusion, when a third has under 8 runs", () => {
		const { activities, rows } = season(3 * MIN_GROUP - 1);
		const r = compareByMeasure(pairRuns(activities, rows).runs, "overnight_hrv", "km") as any;
		assert.equal(r.best_third_n, MIN_GROUP - 1);
		assert.match(r.result, /Not enough data: 23 comparable runs .* each third would have 7 \(need about 8\)\. No conclusion drawn/);
		assert.equal(r.difference_s_per_km_at_same_hr, undefined);
		assert.equal(r.correlation_r, undefined);
		assert.equal(r.meaningful, undefined);
	});

	it("only counts runs that have a value for the measure", () => {
		const { activities, rows } = season(30);
		for (const row of rows.slice(0, 10)) delete row.daily;
		const r = compareByMeasure(pairRuns(activities, rows).runs, "morning_body_battery", "mile") as any;
		assert.equal(r.runs_with_data, 20);
		assert.match(r.result, /Not enough data/);
	});

	it("reports pace and the same-HR difference in the user's unit", () => {
		const { activities, rows } = season(30, { speed: (i, hr) => line(hr) + (i - 15) * 0.006 });
		const r = compareByMeasure(pairRuns(activities, rows).runs, "sleep_hours", "mile") as any;
		assert.match(r.best_third.pace, /\/mi$/);
		assert.ok(r.difference_s_per_mi_at_same_hr < 0);
		assert.match(r.result, /s\/mi faster for the same heart rate/);
	});
});

describe("stats helpers", () => {
	it("median, Pearson's r and the least-squares line", () => {
		assert.equal(median([3, 1, 2]), 2);
		assert.equal(median([4, 1, 2, 3]), 2.5);
		assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
		assert.equal(Math.round(pearson([1, 2, 3, 4], [8, 6, 4, 2])! * 100), -100);
		assert.equal(pearson([1, 1, 1], [1, 2, 3]), undefined, "no spread");
		assert.equal(pearson([1, 2], [1, 2]), undefined, "too few");
		assert.deepEqual(linearFit([1, 2, 3], [3, 5, 7]), { a: 1, b: 2 });
		assert.deepEqual(linearFit([2, 2, 2], [1, 2, 3]), { a: 2, b: 0 }, "flat when x has no spread");
	});

	it("fetches only the wellness sources a measure needs", () => {
		assert.deepEqual([...sourcesFor(["sleep_score", "sleep_hours"])], ["sleep"]);
		assert.deepEqual([...sourcesFor(["overnight_hrv"])], ["hrv"]);
		assert.deepEqual([...sourcesFor(["morning_body_battery"])], ["daily"]);
	});
});

describe("analyze_recovery_impact tool", () => {
	it("pairs runs with that morning's sleep, fetching only what the measure needs", async () => {
		const { activities } = season(30, { speed: (i, hr) => line(hr) + (i - 15) * 0.006 });
		const paths: string[] = [];
		const out = await callGarminTool(
			"analyze_recovery_impact",
			(url) => {
				paths.push(url.pathname);
				if (url.pathname.endsWith("/search/activities")) {
					const from = url.searchParams.get("startDate")!;
					const to = url.searchParams.get("endDate")!;
					return Response.json(activities.filter((a) => String(a.startTimeLocal).slice(0, 10) >= from && String(a.startTimeLocal).slice(0, 10) <= to));
				}
				if (url.pathname === "/sleep-service/sleep/dailySleepSummariesByDate") {
					const out = [];
					for (let i = 0; i < 30; i++) {
						const d = addDays("2026-03-01", i);
						if (d >= url.searchParams.get("startDate")! && d <= url.searchParams.get("endDate")!) {
							out.push({ calendarDate: d, sleepTimeSeconds: 25_000, sleepScores: { overall: { value: 60 + i } } });
						}
					}
					return Response.json(out);
				}
				return new Response("unexpected", { status: 500 });
			},
			{ start_date: "2026-03-01", end_date: "2026-04-30", measure: "sleep_score" },
		);
		assert.equal(out.runs_compared, 30);
		assert.equal(out.results.length, 1);
		assert.equal(out.results[0].best_third.sleep_score, "80-89");
		assert.equal(out.results[0].meaningful, true);
		assert.match(out.caveat, /Correlation, not proof/);
		assert.ok(!paths.some((p) => p.includes("hrv") || p.includes("dailysummaries")), "only sleep was needed");
	});
});
