/**
 * Builds small synthetic FIT files (and zips of them) for tests, so no real
 * activity, and no GPS track, ever needs to be committed. Written from the
 * public FIT protocol: 14-byte header, definition + data records, CRC.
 */
import { deflateRawSync } from "node:zlib";

/** FIT seconds for 2026-01-01T00:00:00Z (FIT epoch is 1989-12-31). */
export const T0 = 1_135_987_200;

export interface SynthRecord {
	/** Seconds after T0. */
	at: number;
	distance?: number;
	hr?: number;
	/** FIT cadence (strides/min for running). */
	cadence?: number;
	power?: number;
	altitude?: number;
}

export interface SynthLap {
	at: number;
	timerTime: number;
	distance: number;
	avgHr?: number;
	intensity?: number;
	trigger?: number;
}

export interface SynthActivity {
	/** FIT sport enum: 1 running, 2 cycling. */
	sport?: number;
	records: SynthRecord[];
	/** [secondsAfterT0, eventType] for timer events: 0 start, 1 stop, 4 stopAll. */
	timer?: [number, number][];
	laps?: SynthLap[];
	/** Write records after the first with compressed-timestamp headers where possible. */
	compressTimestamps?: boolean;
	/** Write record definitions big-endian. */
	bigEndian?: boolean;
	/**
	 * time_in_zone messages (216): `highs` are the zone high boundaries in bpm,
	 * `seconds` the time in each zone (one more entry than `highs`). `ref` is
	 * the referenced message: 18 session (default), 19 lap.
	 */
	timeInZone?: { highs: number[]; seconds: number[]; ref?: number }[];
}

// base types
const ENUM = 0x00;
const UINT8 = 0x02;
const UINT16 = 0x84;
const UINT32 = 0x86;

type Field = [num: number, baseType: number, value: number | undefined];

const SIZE: Record<number, number> = { [ENUM]: 1, [UINT8]: 1, [UINT16]: 2, [UINT32]: 4 };
const INVALID: Record<number, number> = { [ENUM]: 0xff, [UINT8]: 0xff, [UINT16]: 0xffff, [UINT32]: 0xffffffff };

class Writer {
	bytes: number[] = [];
	u8(v: number) {
		this.bytes.push(v & 0xff);
	}
	uint(v: number, size: number, little: boolean) {
		const b = Array.from({ length: size }, (_, i) => (v / 2 ** (8 * i)) & 0xff);
		this.bytes.push(...(little ? b : b.reverse()));
	}
}

const CRC_TABLE = [
	0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01,
	0x8801, 0x4400,
];
function crc16(bytes: number[]): number {
	let crc = 0;
	for (const byte of bytes) {
		let tmp = CRC_TABLE[crc & 0xf]!;
		crc = (crc >> 4) & 0x0fff;
		crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf]!;
		tmp = CRC_TABLE[crc & 0xf]!;
		crc = (crc >> 4) & 0x0fff;
		crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf]!;
	}
	return crc;
}

export function buildFit(a: SynthActivity): Uint8Array {
	const w = new Writer();
	const define = (local: number, global: number, fields: Field[], little = true) => {
		w.u8(0x40 | local);
		w.u8(0);
		w.u8(little ? 0 : 1);
		w.uint(global, 2, little);
		w.u8(fields.length);
		for (const [num, bt] of fields) {
			w.u8(num);
			w.u8(SIZE[bt]!);
			w.u8(bt);
		}
	};
	const data = (header: number, fields: Field[], little = true) => {
		w.u8(header);
		for (const [, bt, v] of fields) w.uint(v ?? INVALID[bt]!, SIZE[bt]!, little);
	};
	const scaled = (v: number | undefined, scale: number, offset = 0) =>
		v === undefined ? undefined : Math.round((v + offset) * scale);

	const sessionFields: Field[] = [
		[253, UINT32, T0],
		[5, ENUM, a.sport ?? 1],
	];
	define(0, 18, sessionFields);
	data(0, sessionFields);

	const eventFields = (at: number, type: number): Field[] => [
		[253, UINT32, T0 + at],
		[0, ENUM, 0],
		[1, ENUM, type],
	];
	define(1, 21, eventFields(0, 0));
	const timer = a.timer ?? [[a.records[0]?.at ?? 0, 0]];

	const little = !a.bigEndian;
	const recordFields = (r: SynthRecord, withTs: boolean): Field[] => [
		...(withTs ? ([[253, UINT32, T0 + r.at]] as Field[]) : []),
		[5, UINT32, scaled(r.distance, 100)],
		[3, UINT8, r.hr],
		[4, UINT8, r.cadence],
		[7, UINT16, r.power],
		[78, UINT32, scaled(r.altitude, 5, 500)],
	];
	define(2, 20, recordFields({ at: 0 }, true), little);
	if (a.compressTimestamps) define(3, 20, recordFields({ at: 0 }, false), little);

	// Interleave timer events with records by time, like a watch does.
	const events = [...timer];
	let last = -Infinity;
	for (const r of a.records) {
		while (events.length && events[0]![0] <= r.at) {
			const [at, type] = events.shift()!;
			data(1, eventFields(at, type));
			last = at;
		}
		const delta = r.at - last;
		if (a.compressTimestamps && last !== -Infinity && delta >= 0 && delta < 32) {
			data(0x80 | (3 << 5) | ((T0 + r.at) & 0x1f), recordFields(r, false), little);
		} else {
			data(2, recordFields(r, true), little);
		}
		last = r.at;
	}
	for (const [at, type] of events) data(1, eventFields(at, type));

	if (a.laps?.length) {
		const lapFields = (l: SynthLap): Field[] => [
			[253, UINT32, T0 + l.at],
			[8, UINT32, scaled(l.timerTime, 1000)],
			[9, UINT32, scaled(l.distance, 100)],
			[15, UINT8, l.avgHr],
			[23, ENUM, l.intensity],
			[24, ENUM, l.trigger],
		];
		define(4, 19, lapFields(a.laps[0]!));
		for (const l of a.laps) data(4, lapFields(l));
	}

	if (a.timeInZone?.length) {
		// Array fields, so written by hand: reference_mesg, time_in_hr_zone (ms), hr_zone_high_boundary.
		for (const z of a.timeInZone) {
			w.u8(0x40 | 5);
			w.u8(0);
			w.u8(0);
			w.uint(216, 2, true);
			w.u8(3);
			w.u8(0), w.u8(2), w.u8(UINT16);
			w.u8(2), w.u8(4 * z.seconds.length), w.u8(UINT32);
			w.u8(6), w.u8(z.highs.length), w.u8(UINT8);
			w.u8(5);
			w.uint(z.ref ?? 18, 2, true);
			for (const s of z.seconds) w.uint(Math.round(s * 1000), 4, true);
			for (const h of z.highs) w.u8(h);
		}
	}

	const header = new Writer();
	header.u8(14);
	header.u8(0x20);
	header.uint(2132, 2, true);
	header.uint(w.bytes.length, 4, true);
	header.bytes.push(0x2e, 0x46, 0x49, 0x54);
	header.uint(crc16(header.bytes), 2, true);
	const all = [...header.bytes, ...w.bytes];
	const out = new Writer();
	out.bytes = all;
	out.uint(crc16(all), 2, true);
	return new Uint8Array(out.bytes);
}

/** A zip archive of the given files, deflated unless `store` is set. */
export function buildZip(files: { name: string; data: Uint8Array }[], store = false): Uint8Array {
	const w = new Writer();
	const central = new Writer();
	for (const f of files) {
		const body = store ? f.data : new Uint8Array(deflateRawSync(f.data));
		const name = new TextEncoder().encode(f.name);
		const offset = w.bytes.length;
		const common = (wr: Writer) => {
			wr.uint(20, 2, true); // version needed
			wr.uint(0, 2, true); // flags
			wr.uint(store ? 0 : 8, 2, true);
			wr.uint(0, 4, true); // time/date
			wr.uint(0, 4, true); // crc32 (unchecked by the reader)
			wr.uint(body.length, 4, true);
			wr.uint(f.data.length, 4, true);
			wr.uint(name.length, 2, true);
			wr.uint(0, 2, true); // extra
		};
		w.uint(0x04034b50, 4, true);
		common(w);
		w.bytes.push(...name, ...body);

		central.uint(0x02014b50, 4, true);
		central.uint(20, 2, true); // version made by
		common(central);
		central.uint(0, 2, true); // comment
		central.uint(0, 2, true); // disk
		central.uint(0, 2, true); // internal attrs
		central.uint(0, 4, true); // external attrs
		central.uint(offset, 4, true);
		central.bytes.push(...name);
	}
	const cdOffset = w.bytes.length;
	w.bytes.push(...central.bytes);
	w.uint(0x06054b50, 4, true);
	w.uint(0, 2, true);
	w.uint(0, 2, true);
	w.uint(files.length, 2, true);
	w.uint(files.length, 2, true);
	w.uint(central.bytes.length, 4, true);
	w.uint(cdOffset, 4, true);
	w.uint(0, 2, true);
	return new Uint8Array(w.bytes);
}

/**
 * A steady run: one record per second at `speed` m/s for `seconds`, HR and
 * altitude following simple patterns. Returns records only.
 */
export function steadyRun(seconds: number, speed: number, startAt = 0, startDistance = 0): SynthRecord[] {
	return Array.from({ length: seconds + 1 }, (_, i) => ({
		at: startAt + i,
		distance: startDistance + i * speed,
		hr: 140 + Math.floor(i / 60),
		cadence: 85,
		power: 250,
		altitude: 100 + (i % 200 < 100 ? i % 100 : 100 - (i % 100)) * 0.1,
	}));
}
