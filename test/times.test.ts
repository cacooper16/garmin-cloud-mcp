// Local-time formatting. Garmin's *Local epochs are wall-clock time encoded as
// if it were UTC; *GMT values are real instants that need the record's offset.
// The model once added the offset to a *Local epoch and reported bedtime an
// hour late, so every time leaves the server as local "YYYY-MM-DD HH:MM".
//
// Garmin also stamps a whole night or day with one offset, so on DST nights
// its "Local" values are an hour out. The values marked "real" below are
// from a Europe/Paris account around the 2026-10-25 change.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactActivity } from "../src/activities.ts";
import { compactActivityDetail, compactBodyBattery, compactSleep, compactSpo2, stripNoise } from "../src/compact.ts";
import { compactHeartRate } from "../src/compact.ts";
import { chooseOffsetMs, gmtToLocalStamp, localizeTimes, localStamp, zoneOffsetMs } from "../src/times.ts";

/** Ground truth for a UTC instant in an IANA zone, independent of the code under test. */
const inZone = (ms: number, timeZone: string) =>
	new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" }).format(ms);

describe("sleep start and end", () => {
	// Real: get_sleep for 2026-11-09, a UTC+1 user who went to bed at 22:41.
	const nov9 = {
		calendarDate: "2026-11-09",
		sleepTimeSeconds: 28320,
		sleepStartTimestampGMT: 1794174070000,
		sleepEndTimestampGMT: 1794202390000,
		sleepStartTimestampLocal: 1794177670000,
		sleepEndTimestampLocal: 1794205990000,
	};

	it("formats the real *Local epochs from testing as local time, with no offset applied", () => {
		for (const tz of [undefined, "Europe/Paris"]) {
			const out = compactSleep(nov9, tz);
			assert.equal(out.start_local, "2026-11-08 22:41");
			assert.equal(out.end_local, "2026-11-09 06:33");
		}
	});

	it("corrects Garmin's one-offset-per-night on the real DST night (Paris, 2026-10-25)", () => {
		// Garmin's Local for bedtime uses the wake-up offset (+1h); it was still CEST (+2h).
		const night = {
			calendarDate: "2026-10-25",
			sleepStartTimestampGMT: 1792876497000, // 21:14:57Z
			sleepEndTimestampGMT: 1792906017000, // 05:26:57Z
			sleepStartTimestampLocal: 1792880097000, // Garmin: 22:14:57 (wrong)
			sleepEndTimestampLocal: 1792909617000, // Garmin: 06:26:57
		};
		const out = compactSleep(night, "Europe/Paris");
		assert.equal(out.start_local, "2026-10-24 23:14");
		assert.equal(out.end_local, "2026-10-25 06:26");
		assert.equal(out.start_local, inZone(night.sleepStartTimestampGMT, "Europe/Paris"));
		// Without the profile zone, Garmin's own value is all there is.
		assert.equal(compactSleep(night).start_local, "2026-10-24 22:14");
	});

	it("keeps Garmin's offset when the user was travelling", () => {
		// Profile zone Paris, but the watch says UTC+0 that night (London): not a DST hour.
		const london = { ...nov9, sleepStartTimestampLocal: nov9.sleepStartTimestampGMT, sleepEndTimestampLocal: nov9.sleepEndTimestampGMT };
		assert.equal(compactSleep(london, "Europe/Paris").start_local, "2026-11-08 21:41");
		// New York (UTC-5) too.
		const ny = { ...nov9, sleepStartTimestampLocal: nov9.sleepStartTimestampGMT - 5 * 3600_000 };
		assert.equal(compactSleep(ny, "Europe/Paris").start_local, "2026-11-08 16:41");
	});

	it("is right across a DST change when Garmin's Local values are right (Europe/Madrid)", () => {
		// Bed 23:30 CEST (UTC+2), up 07:00 CET (UTC+1): the offset changes mid-sleep.
		const bedGmt = Date.UTC(2026, 9, 24, 21, 30);
		const wakeGmt = Date.UTC(2026, 9, 25, 6, 0);
		const out = compactSleep(
			{
				calendarDate: "2026-10-25",
				sleepStartTimestampGMT: bedGmt,
				sleepEndTimestampGMT: wakeGmt,
				sleepStartTimestampLocal: Date.UTC(2026, 9, 24, 23, 30),
				sleepEndTimestampLocal: Date.UTC(2026, 9, 25, 7, 0),
			},
			"Europe/Madrid",
		);
		assert.equal(out.start_local, "2026-10-24 23:30");
		assert.equal(out.end_local, "2026-10-25 07:00");
		assert.equal(out.start_local, inZone(bedGmt, "Europe/Madrid"));
		assert.equal(out.end_local, inZone(wakeGmt, "Europe/Madrid"));
		// One offset for the whole night would get the wake-up time wrong.
		assert.notEqual(gmtToLocalStamp(wakeGmt, 2 * 3600_000), out.end_local);
	});

	it("accepts the ISO string form the Swagger spec documents", () => {
		const out = compactSleep({ sleepStartTimestampLocal: "2026-11-04T23:00:00.0", sleepEndTimestampLocal: "2026-11-05 07:15:00" });
		assert.equal(out.start_local, "2026-11-04 23:00");
		assert.equal(out.end_local, "2026-11-05 07:15");
	});
});

describe("GMT times plus the record's offset", () => {
	// Real Body Battery report shape: the window's Local/GMT pair gives UTC+1.
	const report = (events: object[]) => ({
		date: "2026-11-08",
		startTimestampGMT: "2026-11-07T23:00:00.0",
		startTimestampLocal: "2026-11-08T00:00:00.0",
		bodyBatteryValuesArray: [[1794092400000, 24]],
		bodyBatteryActivityEvent: events,
		bodyBatteryDynamicFeedbackEvent: { eventTimestampGmt: "2026-11-08T19:35:01.0", feedbackShortType: "X" },
	});

	it("converts a Body Battery event with its own timezoneOffset, and drops the offset", () => {
		const out = compactBodyBattery(report([{ eventType: "SLEEP", eventStartTimeGmt: "2026-11-07T22:31:58.0", timezoneOffset: 3600000 }]));
		assert.deepEqual(out.events, [{ eventType: "SLEEP", eventStartTimeLocal: "2026-11-07 23:31" }]);
		assert.deepEqual(out.feedback, { eventTimestampLocal: "2026-11-08 20:35", feedbackShortType: "X" });
		assert.deepEqual(out.readings_local, [{ time: "00:00", level: 24 }]);
	});

	it("uses each event's own offset on a DST change day (Europe/Madrid, 2026-10-25)", () => {
		const before = Date.UTC(2026, 9, 25, 0, 30); // 02:30 CEST
		const after = Date.UTC(2026, 9, 25, 9, 15); // 10:15 CET
		const iso = (ms: number) => new Date(ms).toISOString().slice(0, 21).replace("Z", "");
		const out = compactBodyBattery(
			report([
				{ eventType: "SLEEP", eventStartTimeGmt: iso(before), timezoneOffset: 7200000 },
				{ eventType: "ACTIVITY", eventStartTimeGmt: iso(after), timezoneOffset: 3600000 },
			]),
		);
		const times = (out.events as { eventStartTimeLocal: string }[]).map((e) => e.eventStartTimeLocal);
		assert.deepEqual(times, [inZone(before, "Europe/Madrid"), inZone(after, "Europe/Madrid")]);
		assert.deepEqual(times, ["2026-10-25 02:30", "2026-10-25 10:15"]);
	});

	it("corrects real DST-day Body Battery and heart-rate readings and events (Paris, 2026-10-25)", () => {
		// Garmin's day window says 23:00Z = 00:00 local (+1h); it was 01:00 CEST.
		const window = { startTimestampGMT: "2026-10-24T23:00:00.0", startTimestampLocal: "2026-10-25T00:00:00.0" };
		const bb = compactBodyBattery(
			{
				date: "2026-10-25",
				...window,
				bodyBatteryValuesArray: [[1792882800000, 30], [1792969020000, 25]], // 23:00Z, 22:57Z next day
				bodyBatteryActivityEvent: [{ eventType: "SLEEP", eventStartTimeGmt: "2026-10-24T21:14:57.0", timezoneOffset: 3600000 }],
			},
			"Europe/Paris",
		);
		assert.deepEqual(bb.readings_local, [{ time: "01:00", level: 30 }, { time: "23:57", level: 25 }]);
		assert.deepEqual(bb.events, [{ eventType: "SLEEP", eventStartTimeLocal: "2026-10-24 23:14" }]);

		const hr = compactHeartRate({ calendarDate: "2026-10-25", ...window, heartRateValues: [[1792882800000, 55]] }, undefined, "Europe/Paris");
		assert.deepEqual(hr.hourly_local, [{ hour: "01:00", min: 55, avg: 55, max: 55 }]);
	});

	it("corrects a real DST-night HRV reading (Paris, 2026-10-25)", () => {
		// Garmin's readingTimeLocal uses the bedtime offset (+2h) after the switch to +1h.
		const out = stripNoise(
			localizeTimes({ hrvReadings: [{ readingTimeGMT: "2026-10-25T05:24:08.0", readingTimeLocal: "2026-10-25T07:24:08.0" }] }, undefined, "Europe/Paris"),
		);
		assert.deepEqual(out, { hrvReadings: [{ readingTimeLocal: "2026-10-25 06:24" }] });
	});

	it("turns SpO2 hourly averages' GMT epochs into local times", () => {
		const out = compactSpo2({
			calendarDate: "2026-11-08",
			tomorrowSleepStartTimestampGMT: "2026-11-08T21:41:10.0",
			tomorrowSleepStartTimestampLocal: "2026-11-08T22:41:10.0",
			spO2HourlyAveragesDescriptorList: [
				{ spo2ValueDescIndex: 0, spo2ValueDescKey: "timestamp" },
				{ spo2ValueDescIndex: 1, spo2ValueDescKey: "spo2Level" },
			],
			spO2HourlyAverages: [[1794092400000, 95]],
		});
		assert.deepEqual(out.spO2HourlyAverages, [["2026-11-08 00:00", 95]]);
		assert.equal(out.tomorrowSleepStartTimestampLocal, "2026-11-08 22:41");
		assert.equal(out.tomorrowSleepStartTimestampGMT, undefined);
	});
});

describe("raw payloads returned as Garmin sends them", () => {
	it("weight: formats the local date epoch and drops its GMT duplicate", () => {
		const out = stripNoise(
			localizeTimes({ previousDateWeight: { calendarDate: "2026-07-21", date: 1784626703005, timestampGMT: 1784619503005, weight: 74000 } }),
		);
		assert.deepEqual(out, { previousDateWeight: { calendarDate: "2026-07-21", date: "2026-07-21 09:38", weight: 74000 } });
	});

	it("weight: formats the totalAverage range bounds", () => {
		assert.deepEqual(localizeTimes({ totalAverage: { from: 1786406400000, until: 1794268799999, weight: null } }), {
			totalAverage: { from: "2026-08-11 00:00", until: "2026-11-09 23:59", weight: null },
		});
	});

	it("HRV: reformats local reading times; GMT twins are dropped", () => {
		const out = stripNoise(
			localizeTimes({
				startTimestampGMT: "2026-11-08T21:41:10.0",
				startTimestampLocal: "2026-11-08T22:41:10.0",
				hrvReadings: [{ hrvValue: 40, readingTimeGMT: "2026-11-08T21:42:09.0", readingTimeLocal: "2026-11-08T22:42:09.0" }],
			}),
		);
		assert.deepEqual(out, {
			startTimestampLocal: "2026-11-08 22:41",
			hrvReadings: [{ hrvValue: 40, readingTimeLocal: "2026-11-08 22:42" }],
		});
	});

	it("leaves GMT-only fields alone when there's no offset to convert them with", () => {
		assert.deepEqual(localizeTimes({ timeCreated: "x", lastUpdateGMT: "2026-11-08T10:00:00.0" }), {
			timeCreated: "x",
			lastUpdateGMT: "2026-11-08T10:00:00.0",
		});
	});
});

describe("activities", () => {
	it("gives search results and activity detail the same local start format", () => {
		assert.equal(compactActivity({ startTimeLocal: "2026-11-08 09:02:25" }).startTimeLocal, "2026-11-08 09:02");
		const detail = compactActivityDetail({ summaryDTO: { startTimeLocal: "2026-11-08T09:02:25.0", startTimeGMT: "2026-11-08T08:02:25.0" } });
		assert.equal(detail.startTimeLocal, "2026-11-08 09:02");
		assert.equal(detail.startTimeGMT, undefined);
	});
});

describe("zone offsets", () => {
	it("reads an IANA zone's offset at an instant, across DST", () => {
		assert.equal(zoneOffsetMs("Europe/Paris", Date.UTC(2026, 6, 1)), 2 * 3600_000);
		assert.equal(zoneOffsetMs("Europe/Paris", Date.UTC(2026, 11, 1)), 3600_000);
		assert.equal(zoneOffsetMs("Asia/Kolkata", Date.UTC(2026, 0, 1)), 5.5 * 3600_000);
		assert.equal(zoneOffsetMs("Not/AZone", Date.UTC(2026, 0, 1)), undefined);
	});

	it("chooses the zone's offset over a stale DST one, and Garmin's when travelling", () => {
		const t = Date.UTC(2026, 9, 24, 21, 15); // still CEST
		assert.equal(chooseOffsetMs(t, 3600_000, "Europe/Paris"), 7200_000); // Garmin's stale +1h corrected
		assert.equal(chooseOffsetMs(t, -4 * 3600_000, "Europe/Paris"), -4 * 3600_000); // travelling
		assert.equal(chooseOffsetMs(t, 3600_000, undefined), 3600_000); // no profile zone
		assert.equal(chooseOffsetMs(t, undefined, "Europe/Paris"), 7200_000);
	});
});

describe("localStamp", () => {
	it("ignores values that aren't timestamps", () => {
		for (const v of [undefined, null, 0, 42, 1794, "today", "22:41", {}]) assert.equal(localStamp(v), undefined);
	});
});
