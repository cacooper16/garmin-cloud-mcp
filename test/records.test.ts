import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Analysis, ANALYSIS_VERSION, analysisCacheName, type Effort } from "../src/analysis.ts";
import { GarminApiError } from "../src/garmin.ts";
import { loadMany, personalBests, racePredictions, riegel, type RunEntry } from "../src/records.ts";
import { buildFit, buildZip, steadyRun } from "./fit-fixture.ts";
import { MemoryKV } from "../src/memory-kv.ts";
import { callGarminTool } from "./tool-harness.ts";

const LABELS: Record<number, string> = { 1000: "1 km", 5000: "5 km", 10000: "10 km", 21097.5: "half marathon", 42195: "marathon" };

/** A synthetic analysis with the given best efforts ([metres, seconds, avgHr?]). */
function analysis(efforts: [number, number, number?][], whole?: [number, number]): Analysis {
	return {
		v: ANALYSIS_VERSION,
		sport: "running",
		cadenceUnit: "spm",
		distance: whole?.[0] ?? Math.max(...efforts.map(([m]) => m)),
		time: whole?.[1] ?? Math.max(...efforts.map(([, t]) => t)),
		hasHr: true,
		laps: [],
		hrHistogram: [],
		structured: false,
		bestEfforts: efforts.map(
			([m, t, hr]): Effort => ({ label: LABELS[m]!, distance: m, time: t, startDistance: 0, startTime: 0, avgHr: hr }),
		),
	};
}
const run = (id: string, date: string, efforts: [number, number, number?][], whole?: [number, number]): RunEntry => ({
	id,
	name: `Run ${id}`,
	date,
	analysis: analysis(efforts, whole),
});

describe("personalBests", () => {
	it("picks the fastest effort per distance, with the next two", () => {
		const runs = [
			run("1", "2026-01-01", [[1000, 240], [5000, 1300, 160]]),
			run("2", "2026-02-01", [[1000, 230], [5000, 1250, 168.4]]),
			run("3", "2026-03-01", [[1000, 250], [5000, 1280]]),
			run("4", "2026-04-01", [[1000, 260], [5000, 1400]]),
		];
		const [km, five] = personalBests(runs, ["1 km", "5 km"], "km") as any[];
		assert.equal(km.time, "3:50");
		assert.equal(km.activity_id, "2");
		assert.equal(five.time, "20:50");
		assert.equal(five.pace, "4:10 /km");
		assert.equal(five.date, "2026-02-01");
		assert.equal(five.activity, "Run 2");
		assert.equal(five.avg_hr, 168);
		assert.deepEqual(five.next, [
			{ time: "21:20", date: "2026-03-01", activity_id: "3" },
			{ time: "21:40", date: "2026-01-01", activity_id: "1" },
		]);
		assert.equal(five.tied_by, undefined);
	});

	it("gives a tie (same second) to the earlier date and says it was tied", () => {
		const runs = [run("late", "2026-05-01", [[5000, 1200.2]]), run("early", "2026-03-01", [[5000, 1199.8]])];
		const [five] = personalBests(runs, ["5 km"], "km") as any[];
		assert.equal(five.activity_id, "early");
		assert.equal(five.tied_by, 1);
		assert.equal(five.next[0].time, "20:00");
	});

	it("says when no activity covered a distance, and paces in miles on request", () => {
		const [half, km] = personalBests([run("1", "2026-01-01", [[1000, 300]])], ["half marathon", "1 km"], "mile") as any[];
		assert.match(half.best, /no activity/);
		assert.equal(km.pace, "8:03 /mi");
	});
});

describe("race estimates", () => {
	it("computes T2 = T1 x (D2/D1)^1.06", () => {
		assert.equal(Math.round(riegel(1200, 5000, 10_000)), 2502); // 20:00 5k -> 41:42 10k
		assert.equal(Math.round(riegel(2400, 10_000, 21_097.5)), 5295); // 40:00 10k -> 1:28:15 half
		assert.equal(riegel(1000, 5000, 5000), 1000);
	});

	const by = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.distance, r]));

	it("anchors on an actual effort at the race distance instead of a faster extrapolation", () => {
		// The real case: a fast 10k extrapolates to a 1:45 half, but the user ran
		// a half in 1:50:05 five days earlier.
		const runs = [
			run("tenk", "2026-10-20", [[5000, 1380], [10000, 2808]]),
			run("half", "2026-10-15", [[5000, 1500], [10000, 3080], [21097.5, 6605]]),
		];
		const est = by(racePredictions(runs, "2026-08-01", "km") as any[]);
		assert.equal(est["half marathon"].estimate, "1:50:05");
		assert.equal(est["half marathon"].basis, "actual");
		assert.match(est["half marathon"].from, /^you ran 1:50:05 on 2026-10-15 \(activity half\)$/);
		assert.equal(est["10 km"].estimate, "46:48", "the fastest actual 10 km");
		assert.equal(est["10 km"].basis, "actual");
		// Marathon: no actual; the half is 2x away, the 10k 4.2x (over the cap).
		assert.equal(est.marathon.basis, "riegel");
		assert.match(est.marathon.from, /^half marathon in 1:50:05 on 2026-10-15/);
		assert.equal(est.marathon.estimate, clockOf(riegel(6605, 21_097.5, 42_195)));
	});

	it("extrapolates from the closest distance, not whichever gives the fastest estimate", () => {
		// A fast 5 km and a slower 10 km: the half comes from the 10 km (2.1x), not the 5 km (4.2x, over the cap anyway).
		const runs = [run("a", "2026-10-01", [[5000, 1140]]), run("b", "2026-10-05", [[5000, 1300], [10000, 2700]])];
		const est = by(racePredictions(runs, "2026-08-01", "km") as any[]);
		assert.match(est["half marathon"].from, /^10 km in 45:00/);
		assert.equal(est["half marathon"].estimate, clockOf(riegel(2700, 10_000, 21_097.5)));
		assert.equal(est["5 km"].estimate, "19:00", "actual: the fastest 5 km");
	});

	it("prefers the more recent effort when two distances are about equally close", () => {
		// 10 km target: the 5 km (2x) and the half (2.1x) are about equally close.
		const olderFive = [run("five", "2026-09-01", [[5000, 1200]]), run("half", "2026-10-01", [[21097.5, 6300]])];
		assert.match(by(racePredictions(olderFive, "2026-08-01", "km") as any[])["10 km"].from, /^half marathon .* \(activity half\)/);
		const newerFive = [run("five", "2026-10-10", [[5000, 1200]]), run("half", "2026-10-01", [[21097.5, 6300]])];
		assert.match(by(racePredictions(newerFive, "2026-08-01", "km") as any[])["10 km"].from, /^5 km .* \(activity five\)/);
	});

	it("ignores efforts outside the window and under 3 km, and keeps the 4x cap both ways", () => {
		const old = [run("old", "2026-01-01", [[5000, 1000], [10000, 2000]])];
		assert.match(racePredictions(old, "2026-08-01", "km") as string, /no 5 km or longer effort since 2026-08-01/);
		assert.match(racePredictions([run("k", "2026-10-01", [[1000, 200]])], "2026-08-01", "km") as string, /no 5 km or longer/);
		const fiveOnly = racePredictions([run("5", "2026-10-01", [[5000, 1200]])], "2026-08-01", "km") as any[];
		assert.deepEqual(fiveOnly.map((r) => r.distance), ["5 km", "10 km"], "a 5 km effort reaches 20 km at most");
		const marathonOnly = racePredictions([run("m", "2026-10-01", [[5000, 1500], [42195, 14400]])], "2026-08-01", "km") as any[];
		const m = by(marathonOnly);
		assert.equal(m["half marathon"].basis, "riegel");
		assert.match(m["half marathon"].from, /^marathon in/, "the marathon (2x) is closer than the 5 km (4.2x)");
		assert.match(m["10 km"].from, /^5 km in/, "5 km is 2x away, the marathon 4.2x");
	});
});

function clockOf(s: number) {
	const r = Math.round(s);
	const h = Math.floor(r / 3600);
	const m = Math.floor((r % 3600) / 60);
	const sec = String(r % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

describe("loadMany", () => {
	const fitZip = (speed: number) => buildZip([{ name: "a.fit", data: buildFit({ records: steadyRun(1300, speed) }) }]);
	const acts = (n: number) =>
		Array.from({ length: n }, (_, i) => ({ activityId: i + 1, activityName: `R${i + 1}`, startTimeLocal: `2026-10-${String(30 - i).padStart(2, "0")} 07:00:00` }));
	const limits = { maxActivities: 150, maxDownloads: 100, timeBudgetMs: 60_000, concurrency: 2 };

	function source(opts: { status?: (id: string) => number | undefined; cached?: Map<string, unknown> } = {}) {
		const cache = opts.cached ?? new Map<string, unknown>();
		const downloads: string[] = [];
		return {
			downloads,
			cache,
			async getCached<T>(name: string) {
				return cache.get(name) as T | undefined;
			},
			async putCached(name: string, value: unknown) {
				cache.set(name, value);
			},
			async getBytes(path: string) {
				const id = path.split("/").pop()!;
				downloads.push(id);
				const status = opts.status?.(id);
				if (status) throw new GarminApiError(`HTTP ${status}`, status);
				return fitZip(4);
			},
		};
	}

	it("skips activities with no file and counts them", async () => {
		const src = source({ status: (id) => (id === "2" ? 404 : undefined) });
		const r = await loadMany(src, acts(3), limits);
		assert.equal(r.runs.length, 2);
		assert.equal(r.noFile, 1);
		assert.equal(r.runs[0]!.name, "R1");
		assert.equal(r.runs[0]!.date, "2026-10-30");
	});

	it("returns what it has when Garmin rate-limits, and starts no more downloads", async () => {
		const src = source({ status: (id) => (Number(id) >= 3 ? 429 : undefined) });
		const r = await loadMany(src, acts(10), { ...limits, concurrency: 1 });
		assert.equal(r.rateLimited, true);
		assert.equal(r.runs.length, 2);
		assert.equal(r.deferred, 8);
		assert.deepEqual(src.downloads, ["1", "2", "3"], "stops downloading after the first 429");
	});

	it("uses cached analyses for free and defers downloads past the per-call limit", async () => {
		const cached = new Map<string, unknown>([[analysisCacheName("1"), analysis([[1000, 200]])]]);
		const src = source({ cached });
		const r = await loadMany(src, acts(5), { ...limits, maxDownloads: 2, concurrency: 1 });
		assert.equal(r.runs.length, 3, "one cached + two downloaded");
		assert.equal(r.downloaded, 2);
		assert.equal(r.deferred, 2);
		const again = await loadMany(src, acts(5), { ...limits, maxDownloads: 2, concurrency: 1 });
		assert.equal(again.runs.length, 5, "the next call continues where it stopped");
	});

	it("stops starting downloads once the time budget is spent", async () => {
		let t = 0;
		const src = source();
		const r = await loadMany(src, acts(4), { ...limits, timeBudgetMs: 10, concurrency: 1 }, { now: () => (t += 6) });
		assert.ok(r.deferred > 0 && r.runs.length > 0, JSON.stringify({ runs: r.runs.length, deferred: r.deferred }));
	});
});

describe("get_personal_bests tool", () => {
	const callTool = (fetch: (url: URL) => Response | Promise<Response>, args: object, options = {}) =>
		callGarminTool("get_personal_bests", fetch, args, options);

	const listing = (n: number, extra: (i: number) => object = () => ({})) =>
		Array.from({ length: n }, (_, i) => ({
			activityId: i + 1,
			activityName: `Run ${i + 1}`,
			startTimeLocal: `2026-10-${String(1 + (i % 28)).padStart(2, "0")} 07:00:00`,
			distance: 5300,
			activityType: { typeKey: "running" },
			...extra(i),
		}));

	it("analyses the newest 150, skips manual entries, and says so", async () => {
		const list = listing(170, (i) => (i < 5 ? { manualActivity: true } : {}));
		const downloads: string[] = [];
		const zip = buildZip([{ name: "a.fit", data: buildFit({ records: steadyRun(1400, 4) }) }]);
		const out = await callTool(
			(url) => {
				if (url.pathname.endsWith("/search/activities")) {
					assert.equal(url.searchParams.get("activityType"), "running");
					const start = Number(url.searchParams.get("start"));
					return Response.json(list.slice(start, start + Number(url.searchParams.get("limit"))));
				}
				downloads.push(url.pathname);
				return new Response(zip);
			},
			{ start_date: "2026-01-01", end_date: "2026-10-31", distances: ["5 km"] },
		);
		assert.equal(out.complete, true);
		assert.equal(Object.keys(out)[0], "complete");
		assert.equal(out.status, undefined, "no partial note when complete");
		assert.equal(out.provisional_personal_bests, undefined);
		assert.equal(out.activities_analysed, 150);
		assert.equal(downloads.length, 150);
		assert.equal(out.personal_bests[0].time, "20:50");
		assert.equal(out.personal_bests[0].pace, "4:10 /km");
		assert.ok(out.notes.some((n: string) => /165 matching activities; analysed the newest 150/.test(n)), out.notes);
		assert.ok(out.notes.some((n: string) => /5 activities skipped: no FIT file/.test(n)), out.notes);
		assert.match(out.source, /not Garmin's official records/);
		assert.equal(out.race_estimates.estimates[0].distance, "5 km");
	});

	it("returns a partial result with a clear note when Garmin rate-limits", async () => {
		const list = listing(6);
		let served = 0;
		const zip = buildZip([{ name: "a.fit", data: buildFit({ records: steadyRun(1400, 4) }) }]);
		const out = await callTool(
			(url) => {
				if (url.pathname.endsWith("/search/activities")) return Response.json(list);
				return ++served <= 2 ? new Response(zip) : new Response("slow down", { status: 429 });
			},
			{ period: "last_365_days" },
		);
		assert.ok(out.activities_analysed >= 1 && out.activities_analysed <= 2, String(out.activities_analysed));
		assert.equal(out.complete, false);
		assert.match(out.status, /^Partial: \d of 6 runs analysed so far \(Garmin rate-limited the file downloads\)\. Wait a minute, then call again before answering; these are not the final bests\.$/);
		assert.ok(out.provisional_personal_bests && !out.personal_bests);
	});

	it("reports complete: true once repeated calls have analysed everything", async () => {
		const zip = buildZip([{ name: "a.fit", data: buildFit({ records: steadyRun(1400, 4) }) }]);
		const kv = new MemoryKV();
		const call = () =>
			callGarminTool(
				"get_personal_bests",
				(url) => (url.pathname.endsWith("/search/activities") ? Response.json(listing(10)) : new Response(zip)),
				{},
				{ personalBests: { maxDownloads: 4 } },
				kv,
			);
		const runs = [await call(), await call(), await call()];
		assert.deepEqual(runs.map((r) => [r.complete, r.activities_analysed]), [[false, 4], [false, 8], [true, 10]]);
		const done = runs[2];
		assert.equal(done.status, undefined);
		assert.equal(done.personal_bests[0].time, "4:10");
		assert.ok(done.race_estimates.estimates.length > 0);
		assert.equal(done.provisional_personal_bests, undefined);
	});

	it("caps downloads per call when the deployment asks (the Worker does)", async () => {
		const zip = buildZip([{ name: "a.fit", data: buildFit({ records: steadyRun(1400, 4) }) }]);
		const out = await callTool(
			(url) => (url.pathname.endsWith("/search/activities") ? Response.json(listing(10)) : new Response(zip)),
			{},
			{ personalBests: { maxDownloads: 4 } },
		);
		// Partial: completeness comes first, and the results are labelled provisional.
		assert.deepEqual(Object.keys(out).slice(0, 2), ["complete", "status"]);
		assert.equal(out.complete, false);
		assert.equal(out.status, "Partial: 4 of 10 runs analysed so far. Call again to continue (finished analyses are cached) before answering; these are not the final bests.");
		assert.equal(out.activities_analysed, 4);
		assert.equal(out.activities_to_analyse, 10);
		assert.equal(out.personal_bests, undefined);
		assert.equal(out.race_estimates, undefined);
		assert.equal(out.provisional_personal_bests[0].distance, "1 km");
		assert.ok(out.provisional_race_estimates.estimates.length > 0);
	});
});
