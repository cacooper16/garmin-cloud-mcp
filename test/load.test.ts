import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadTimeline } from "../src/activities.ts";
import { addDays } from "../src/ranges.ts";

/** One activity per day from `from`, with the week's load spread evenly; `weekly` lists each week's load. */
function days(from: string, weekly: number[]) {
	return weekly.flatMap((load, w) =>
		Array.from({ length: 7 }, (_, d) => ({
			startTimeLocal: `${addDays(from, w * 7 + d)} 07:00:00`,
			activityTrainingLoad: load / 7,
		})),
	);
}

// 2026-06-01 is a Monday. The lead-in is the four weeks before it.
const START = "2026-06-01";
const LEAD_IN = "2026-05-04";

const rows = (t: ReturnType<typeof loadTimeline>) => t!.periods as Record<string, any>[];

describe("loadTimeline", () => {
	it("gives each week's load, change and acute:chronic ratio", () => {
		const t = loadTimeline(days(LEAD_IN, [700, 700, 700, 700, 700, 700, 700, 700]), START, "2026-06-28", "week", "ok");
		assert.equal(t!.method, "garmin_training_load");
		assert.deepEqual(
			rows(t).map((r) => [r.period, r.load, r.change_pct, r.ratio]),
			[
				["2026-06-01", 700, 0, 1],
				["2026-06-08", 700, 0, 1],
				["2026-06-15", 700, 0, 1],
				["2026-06-22", 700, 0, 1],
			],
		);
		assert.ok(rows(t).every((r) => r.flag === undefined && r.band === undefined && r.partial === undefined));
		assert.equal(t!.notes, undefined);
	});

	it("uses the 28-day lead-in for the first weeks, and says when it's missing", () => {
		// Same steady training, but the lead-in fetch failed: the first three weeks
		// can't have a full 28-day chronic window.
		const range = days(START, [700, 700, 700, 700]);
		const failed = loadTimeline(range, START, "2026-06-28", "week", "unavailable");
		assert.deepEqual(rows(failed).map((r) => r.ratio), [undefined, undefined, undefined, 1]);
		assert.equal(rows(failed)[0]!.change_pct, undefined, "no previous week to compare");
		assert.match(failed!.notes![0]!, /Couldn't fetch the 28 days before 2026-06-01.*3 of them/);

		// The lead-in came back empty: ratios are computed (it may be genuine
		// rest) but read high, and the output says why.
		const empty = loadTimeline(range, START, "2026-06-28", "week", "empty");
		assert.equal(rows(empty)[0]!.ratio, 4);
		assert.match(rows(empty)[0]!.flag, /ratio 4 above 1.3/);
		assert.match(empty!.notes![0]!, /No matching activities in the 28 days before/);
	});

	it("flags a ratio above 1.3 and a rise over 30%", () => {
		const t = loadTimeline(days(LEAD_IN, [700, 700, 700, 700, 700, 700, 1000, 1400]), START, "2026-06-28", "week", "ok");
		const [, , w3, w4] = rows(t);
		assert.equal(w3!.change_pct, 43);
		assert.equal(w3!.ratio, 1.29, "(700+700+1000+700)/4 = 775 chronic");
		assert.equal(w3!.flag, "load up 43% on the previous week", "ratio 1.29 is not flagged");
		assert.equal(w4!.change_pct, 40);
		assert.equal(w4!.ratio, 1.47);
		assert.equal(w4!.band, "elevated");
		assert.equal(w4!.flag, "ratio 1.47 above 1.3; load up 40% on the previous week");
	});

	it("marks partial weeks and gives them no change figure", () => {
		// Wednesday to Wednesday: both ends are partial weeks.
		const t = loadTimeline(days(LEAD_IN, [700, 700, 700, 700, 700, 700, 700]), "2026-06-03", "2026-06-17", "week", "ok");
		const r = rows(t);
		assert.deepEqual(r.map((x) => [x.period, x.partial, x.change_pct]), [
			["2026-06-01", true, undefined],
			["2026-06-08", undefined, undefined], // previous week was partial
			["2026-06-15", true, undefined],
		]);
		assert.equal(r[0]!.load, 500, "only the five days inside the range");
		assert.equal(r[2]!.ratio, 1, "the ratio still uses the full 7 and 28 days up to the period's end");
	});

	it("works by month, comparing full months", () => {
		const acts = days("2026-03-02", Array.from({ length: 14 }, (_, i) => (i < 9 ? 700 : 1400)));
		const t = loadTimeline(acts, "2026-04-01", "2026-05-31", "month", "ok");
		const [apr, may] = rows(t);
		assert.equal(apr!.period, "2026-04");
		assert.equal(apr!.change_pct, undefined, "the lead-in is 28 days, not a whole month");
		assert.ok(may!.change_pct > 30, String(may!.change_pct));
		assert.match(may!.flag, /on the previous month/);
	});

	it("returns nothing when the range has no activities", () => {
		assert.equal(loadTimeline(days(LEAD_IN, [700]), START, "2026-06-28", "week", "ok"), undefined);
	});
});
