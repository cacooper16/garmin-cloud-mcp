import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Analysis,
	type AnalysisSource,
	analyzeActivity,
	bestEffort,
	buildTimeline,
	clock,
	computeSplits,
	formatAnalysis,
	formatHrZones,
	loadAnalysis,
	MILE,
	SECTIONS,
	timeAtDistance,
	timerIntervals,
	zonesFromApi,
} from "../src/analysis.ts";
import { decodeFit, FitError, type FitRecord, isFit, unzip } from "../src/fit.ts";
import { GarminApiError } from "../src/garmin.ts";
import { buildFit, buildZip, steadyRun, T0 } from "./fit-fixture.ts";

/** Records in FIT form for the timeline functions, without going through a file. */
const recs = (rows: [ts: number, distance: number, hr?: number][]): FitRecord[] =>
	rows.map(([ts, distance, hr]) => ({ ts, distance, hr }));
const start = (ts: number) => ({ ts, event: 0, type: "start" });
const stop = (ts: number) => ({ ts, event: 0, type: "stop" });

describe("FIT decoding", () => {
	it("round-trips records, events, laps and sport, with scale/offset applied", () => {
		const fit = decodeFit(
			buildFit({
				sport: 1,
				records: [
					{ at: 0, distance: 0, hr: 120, cadence: 80, power: 200, altitude: 50.4 },
					{ at: 1, distance: 3.21, hr: 121, altitude: -12.2 },
				],
				timer: [
					[0, 0],
					[1, 4],
				],
				laps: [{ at: 0, timerTime: 1.5, distance: 3.21, avgHr: 120, intensity: 2, trigger: 2 }],
			}),
		);
		assert.equal(fit.sport, "running");
		assert.deepEqual(fit.records[0], { ts: T0, distance: 0, hr: 120, cadence: 80, power: 200, altitude: 50.4, speed: undefined });
		// Missing (invalid) fields decode as undefined; negative altitude survives the offset.
		assert.equal(fit.records[1]!.cadence, undefined);
		assert.equal(fit.records[1]!.power, undefined);
		assert.equal(fit.records[1]!.altitude, -12.2);
		assert.deepEqual(
			fit.events.map((e) => e.type),
			["start", "stopAll"],
		);
		assert.equal(fit.laps[0]!.timerTime, 1.5);
		assert.equal(fit.laps[0]!.intensity, "warmup");
		assert.equal(fit.laps[0]!.trigger, "distance");
	});

	it("resolves compressed timestamps, including the 5-bit rollover, and big-endian definitions", () => {
		const records = steadyRun(100, 3);
		const plain = decodeFit(buildFit({ records }));
		const packed = decodeFit(buildFit({ records, compressTimestamps: true, bigEndian: true }));
		assert.equal(packed.records.length, 101);
		assert.deepEqual(
			packed.records.map((r) => [r.ts, r.distance, r.hr]),
			plain.records.map((r) => [r.ts, r.distance, r.hr]),
		);
	});

	it("rejects non-FIT data and truncated files with FitError", () => {
		assert.equal(isFit(new TextEncoder().encode("<gpx></gpx>")), false);
		assert.throws(() => decodeFit(new Uint8Array(20)), FitError);
		const fit = buildFit({ records: steadyRun(10, 3) });
		assert.throws(() => decodeFit(fit.subarray(0, fit.length - 20)), FitError);
	});

	it("unzips deflated and stored entries", async () => {
		const fit = buildFit({ records: steadyRun(30, 3) });
		for (const store of [false, true]) {
			const entries = await unzip(buildZip([{ name: "1_ACTIVITY.fit", data: fit }], store));
			assert.equal(entries[0]!.name, "1_ACTIVITY.fit");
			assert.deepEqual(entries[0]!.data, fit);
		}
		await assert.rejects(unzip(new Uint8Array(100)), FitError);
	});
});

describe("split interpolation", () => {
	it("interpolates the exact time at each boundary between records", () => {
		// 3 m/s, recorded every 7 s (smart recording): 1000 m falls between records.
		const rows: [number, number][] = Array.from({ length: 200 }, (_, i) => [i * 7, i * 21]);
		const s = buildTimeline(recs(rows), []);
		assert.ok(Math.abs(timeAtDistance(s, 1000) - 1000 / 3) < 1e-9);
		const splits = computeSplits(s, 1000);
		assert.ok(Math.abs(splits[0]!.time - 333.333) < 0.001);
		assert.ok(Math.abs(splits[1]!.cumulative - 666.667) < 0.001);
	});

	it("excludes paused time, so splits use timer time", () => {
		// 0-400 s at 2.5 m/s (1000 m), paused 400-700 s, then 2.5 m/s again.
		const run1 = Array.from({ length: 401 }, (_, i): [number, number] => [i, i * 2.5]);
		const run2 = Array.from({ length: 401 }, (_, i): [number, number] => [700 + i, 1000 + i * 2.5]);
		const s = buildTimeline(recs([...run1, ...run2]), [start(0), stop(400), start(700), stop(1100)]);
		const splits = computeSplits(s, 1000);
		assert.deepEqual(
			splits.map((x) => Math.round(x.time)),
			[400, 400],
		);
		assert.equal(Math.round(splits[1]!.cumulative), 800);
	});

	it("ignores drift recorded during a pause and handles auto-pause records", () => {
		// The watch keeps a record while stopped, with 2 m of GPS drift: zero timer time.
		const rows: [number, number][] = [
			[0, 0],
			[200, 500],
			[260, 502], // paused at 200, a drift record at 260
			[300, 502],
			[500, 1002],
		];
		const s = buildTimeline(recs(rows), [start(0), stop(200), start(300)]);
		assert.deepEqual(
			s.map((x) => x.t),
			[0, 200, 200, 200, 400],
		);
		const [km] = computeSplits(s, 1000);
		assert.ok(Math.abs(km!.time - 399.2) < 0.01); // 1000 m reached just before the last record
	});

	it("labels the final partial split with its distance and drops sub-1% slivers", () => {
		const s = buildTimeline(recs(Array.from({ length: 1001 }, (_, i): [number, number] => [i, i * 2.27])), []);
		const a = { ...baseAnalysis, splits: { km: computeSplits(s, 1000), mile: computeSplits(s, MILE) } };
		const out = formatAnalysis(a, { unit: "km", include: ["splits"] }) as { splits: { split: string }[] };
		assert.deepEqual(
			out.splits.map((r) => r.split),
			["1", "2", "last 0.27 km"],
		);
		const sliver = buildTimeline(recs([[0, 0], [400, 1005]]), []);
		assert.equal(computeSplits(sliver, 1000).length, 1);
	});

	it("treats a file with no timer events as running from the first record", () => {
		assert.deepEqual(timerIntervals([], 50), [[50, Number.POSITIVE_INFINITY]]);
		assert.deepEqual(timerIntervals([stop(80), start(90)], 50), [
			[50, 80],
			[90, Number.POSITIVE_INFINITY],
		]);
	});

	it("weights HR averages by time, so irregular recording isn't biased", () => {
		// 100 s at HR 100, then ten 1-second records at HR 200: avg is time-weighted.
		const rows: [number, number, number][] = [
			[0, 0, 100],
			[100, 300, 100],
			...Array.from({ length: 10 }, (_, i): [number, number, number] => [101 + i, 303 + i * 3, 200]),
		];
		const [split] = computeSplits(buildTimeline(recs(rows), []), 1000);
		assert.equal(Math.round(split!.avgHr!), Math.round((100 * 100 + 10 * 200) / 110));
		assert.equal(split!.maxHr, 200);
	});
});

describe("best efforts", () => {
	// 3 km at 5:00/km, then 1 km at 4:00/km starting at 900 s, then 1 km at 5:00/km.
	const rows: [number, number][] = [];
	for (let t = 0; t <= 900; t++) rows.push([t, t * (1000 / 300)]);
	for (let t = 1; t <= 240; t++) rows.push([900 + t, 3000 + t * (1000 / 240)]);
	for (let t = 1; t <= 300; t++) rows.push([1140 + t, 4000 + t * (1000 / 300)]);
	const s = buildTimeline(recs(rows), []);

	it("finds the fastest continuous distance and where it started", () => {
		const e = bestEffort(s, 1000)!;
		assert.ok(Math.abs(e.time - 240) < 1e-6);
		assert.ok(Math.abs(e.startDistance - 3000) < 1e-6);
		assert.equal(e.startTime, 900);
	});

	it("finds the fastest window that straddles a pace change", () => {
		// Best 2 km must include the whole fast km: 240 s + 1 km at 300 s.
		assert.ok(Math.abs(bestEffort(s, 2000)!.time - 540) < 1e-6);
	});

	it("returns nothing for distances longer than the activity", () => {
		assert.equal(bestEffort(s, 10_000), undefined);
		const a = analyzeActivity(decodeFit(buildFit({ records: steadyRun(2000, 3) })));
		assert.deepEqual(
			a.bestEfforts!.map((e) => e.label),
			["1 km", "1 mile", "5 km"],
		);
	});
});

const baseAnalysis: Analysis = {
	v: 1,
	sport: "running",
	cadenceUnit: "spm",
	distance: 5000,
	time: 1500,
	hasHr: true,
	laps: [],
	hrHistogram: [
		[110, 60],
		[130, 600],
		[150, 300],
		[170, 240],
	],
	structured: false,
};

describe("HR zones", () => {
	const api = [
		{ sport: "DEFAULT", trainingMethod: "HR_MAX", zone1Floor: 100, zone2Floor: 120, zone3Floor: 140, zone4Floor: 160, zone5Floor: 180, maxHeartRateUsed: 195 },
		{ sport: "RUNNING", zone1Floor: 115, zone2Floor: 135, zone3Floor: 155, zone4Floor: 165, zone5Floor: 175, maxHeartRateUsed: 190 },
	];

	it("uses the sport's zones, falling back to DEFAULT", () => {
		assert.deepEqual(zonesFromApi(api, "running")!.floors, [115, 135, 155, 165, 175]);
		assert.deepEqual(zonesFromApi(api, "cycling")!.floors, [100, 120, 140, 160, 180]);
		assert.equal(zonesFromApi([{ sport: "DEFAULT" }], "running"), undefined);
		assert.equal(zonesFromApi(null, "running"), undefined);
	});

	it("buckets time into zones with bpm ranges", () => {
		const out = formatHrZones(baseAnalysis, zonesFromApi(api, "running")!) as {
			zones: { zone: unknown; bpm: string; minutes: number; pct: number }[];
		};
		assert.deepEqual(
			out.zones.map((z) => [z.zone, z.bpm, z.minutes]),
			[
				["below 1", "<115", 1],
				[1, "115-134", 10],
				[2, "135-154", 5],
				[3, "155-164", 0],
				[4, "165-174", 4],
				[5, "175-190", 0],
			],
		);
	});
});

describe("analysis output", () => {
	const fit = buildFit({
		records: [...steadyRun(1200, 3), ...steadyRun(1200, 2.5, 1201, 3603)],
		timer: [[0, 0]],
		laps: [
			{ at: 0, timerTime: 600, distance: 1800, avgHr: 140, intensity: 2, trigger: 0 },
			{ at: 600, timerTime: 1800, distance: 4800, avgHr: 150, intensity: 0, trigger: 7 },
		],
	});
	const a = analyzeActivity(decodeFit(fit));

	it("doubles running cadence to steps per minute and reports drift", () => {
		const out = formatAnalysis(a, { unit: "km", include: SECTIONS }) as Record<string, any>;
		assert.equal(out.splits[0].cadence_spm, 170);
		assert.equal(out.laps[0].intensity, "warmup");
		assert.equal(out.laps[1].trigger, "session_end");
		assert.ok(out.drift.pace_change_pct > 15); // 3 m/s then 2.5 m/s
		assert.match(out.drift.note, /warm-up/);
		assert.deepEqual(out.unavailable, ["hr_zones: no HR zones set in Garmin Connect"]);
	});

	it("reports miles with feet and per-mile pace", () => {
		const out = formatAnalysis(a, { unit: "mile", include: ["splits", "best_efforts"] }) as Record<string, any>;
		assert.equal(out.splits[0].split, "1");
		assert.match(out.splits[0].pace, / \/mi$/);
		assert.ok("elev_gain_ft" in out.splits[0]);
		assert.ok("starts_at_mi" in out.best_efforts[0]);
		assert.equal(out.laps, undefined);
	});

	it("shows speed instead of pace for cycling", () => {
		const ride = analyzeActivity(decodeFit(buildFit({ sport: 2, records: steadyRun(600, 10) })));
		const out = formatAnalysis(ride, { unit: "km", include: ["splits"] }) as Record<string, any>;
		assert.equal(out.splits[0].speed_kmh, 36);
		assert.equal(out.splits[0].pace, undefined);
		assert.ok("cadence_rpm" in out.splits[0]);
	});

	it("formats clock times", () => {
		assert.equal(clock(59.6), "1:00");
		assert.equal(clock(3725), "1:02:05");
	});
});

describe("loadAnalysis", () => {
	const source = (bytes: Uint8Array | Error) => {
		const cache = new Map<string, string>();
		let downloads = 0;
		const src: AnalysisSource & { downloads: () => number } = {
			async getBytes() {
				downloads++;
				if (bytes instanceof Error) throw bytes;
				return bytes;
			},
			async getCached<T>(name: string) {
				const v = cache.get(name);
				return v === undefined ? undefined : (JSON.parse(v) as T);
			},
			async putCached(name: string, value: unknown) {
				cache.set(name, JSON.stringify(value));
			},
			downloads: () => downloads,
		};
		return src;
	};

	it("analyses the FIT inside the zip and caches the derived result", async () => {
		const src = source(buildZip([{ name: "9_ACTIVITY.fit", data: buildFit({ records: steadyRun(400, 3) }) }]));
		const first = await loadAnalysis(src, "9");
		assert.ok("analysis" in first && first.analysis.splits!.km.length === 2);
		const second = await loadAnalysis(src, "9");
		assert.deepEqual(second, first);
		assert.equal(src.downloads(), 1);
	});

	it("accepts a bare (unzipped) FIT file", async () => {
		const loaded = await loadAnalysis(source(buildFit({ records: steadyRun(400, 3) })), "1");
		assert.ok("analysis" in loaded);
	});

	it("returns an unavailable note, not an error, for missing or non-FIT originals", async () => {
		const notFound = await loadAnalysis(source(new GarminApiError("404", 404)), "1");
		assert.match((notFound as { unavailable: string }).unavailable, /manual entry/);
		const gpx = buildZip([{ name: "1.gpx", data: new TextEncoder().encode("<gpx/>") }]);
		assert.match((await loadAnalysis(source(gpx), "1") as { unavailable: string }).unavailable, /GPX import/);
		assert.match((await loadAnalysis(source(new Uint8Array(0)), "1") as { unavailable: string }).unavailable, /no original file/);
	});

	it("still throws real errors (auth, rate limit)", async () => {
		await assert.rejects(loadAnalysis(source(new GarminApiError("429", 429)), "1"), GarminApiError);
	});
});
