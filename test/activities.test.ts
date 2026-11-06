import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactActivity, summarizeActivities } from "../src/activities.ts";

// Shaped like Garmin's activity list items, with the kind of bulk that made
// month-long searches overflow the output cap.
function run(date: string, km: number, minutes: number, hr: number) {
	const bulk: Record<string, unknown> = {};
	for (let i = 0; i < 120; i++) bulk[`someGarminField${i}`] = i;
	return {
		...bulk,
		activityId: Number(date.replace(/-/g, "")),
		activityName: "Morning Run",
		startTimeLocal: `${date} 07:00:00`,
		activityType: { typeId: 1, typeKey: "running", parentTypeId: 17 },
		eventType: { typeId: 9, typeKey: "uncategorized" },
		distance: km * 1000,
		duration: minutes * 60 + 30,
		movingDuration: minutes * 60,
		averageSpeed: (km * 1000) / (minutes * 60),
		averageHR: hr,
		elevationGain: 20,
		vO2MaxValue: null,
	};
}

describe("compactActivity", () => {
	it("keeps key stats, flattens type, drops nulls and bulk", () => {
		const c = compactActivity(run("2026-07-01", 5, 25, 150));
		assert.equal(c.type, "running");
		assert.equal(c.distance, 5000);
		assert.equal(c.movingDuration, 1500);
		assert.ok(!("vO2MaxValue" in c));
		assert.ok(!("event" in c), "uncategorized event omitted");
		assert.ok(!("someGarminField0" in c));
		assert.ok(JSON.stringify(c).length < JSON.stringify(run("2026-07-01", 5, 25, 150)).length / 5);
	});
});

describe("summarizeActivities", () => {
	const runs = [
		run("2026-06-29", 10, 50, 150), // Monday
		run("2026-07-01", 5, 30, 160), // same ISO week
		run("2026-07-08", 8, 40, 140),
	];

	it("groups by month with distance-weighted pace", () => {
		const rows = summarizeActivities(runs, "month");
		assert.deepEqual(
			rows.map((r) => [r.period, r.count, r.distance_km]),
			[
				["2026-06", 1, 10],
				["2026-07", 2, 13],
			],
		);
		const july = rows[1]!;
		// 13 km in 70 min => 5:23/km
		assert.equal(july.avg_pace_per_km, "5:23");
		assert.equal(july.fastest_avg_pace_per_km, "5:00");
		assert.equal(july.longest_km, 8);
		// HR weighted by time: (160*30 + 140*40) / 70
		assert.equal(july.avg_hr, 149);
	});

	it("groups by ISO week starting Monday", () => {
		const rows = summarizeActivities(runs, "week");
		assert.deepEqual(
			rows.map((r) => [r.period, r.count]),
			[
				["2026-06-29", 2],
				["2026-07-06", 1],
			],
		);
	});

	it("totals everything and stays tiny", () => {
		const many = Array.from({ length: 300 }, (_, i) => run("2026-05-01", 5 + (i % 5), 30, 150));
		const rows = summarizeActivities(many, "total");
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.count, 300);
		assert.ok(JSON.stringify(rows).length < 500);
	});

	it("tolerates missing fields", () => {
		const rows = summarizeActivities([{ activityType: { typeKey: "strength_training" } }], "month");
		assert.equal(rows[0]!.count, 1);
		assert.equal(rows[0]!.distance_km, 0);
		assert.ok(!("avg_pace_per_km" in rows[0]!));
	});
});
