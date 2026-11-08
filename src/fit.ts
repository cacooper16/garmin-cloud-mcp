/**
 * Minimal reader for Garmin activity downloads: unzips the original file and
 * decodes just the FIT messages the analysis needs (record, lap, event,
 * session). Everything else, including GPS position, is skipped unread.
 *
 * Deliberately dependency-free: Garmin's FIT SDK decodes every message and
 * costs ~40 ms of CPU for a two-hour run, which is past the Workers free
 * plan's 10 ms budget, and its licence doesn't allow redistribution. This
 * decoder follows the public FIT protocol (header, definition and data
 * records, compressed timestamps) and reads ~10 fields by number.
 */

export interface FitRecord {
	/** Seconds since the FIT epoch (1989-12-31 UTC). */
	ts: number;
	/** Metres from the start. */
	distance?: number;
	hr?: number;
	/** Raw FIT cadence: strides/min (one leg) for running, rpm for cycling. */
	cadence?: number;
	power?: number;
	/** Metres. */
	altitude?: number;
	/** m/s. */
	speed?: number;
}

export interface FitLap {
	startTs?: number;
	timerTime?: number;
	elapsedTime?: number;
	distance?: number;
	avgSpeed?: number;
	avgHr?: number;
	maxHr?: number;
	avgCadence?: number;
	avgPower?: number;
	maxPower?: number;
	ascent?: number;
	descent?: number;
	intensity?: string;
	trigger?: string;
	workoutStep?: number;
}

export interface FitEvent {
	ts: number;
	/** FIT event number; 0 is the timer. */
	event: number;
	type: string;
}

export interface FitActivity {
	sport?: string;
	subSport?: number;
	records: FitRecord[];
	laps: FitLap[];
	events: FitEvent[];
	session?: { timerTime?: number; distance?: number; startTs?: number };
}

export class FitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FitError";
	}
}

// ---- zip ------------------------------------------------------------------

export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

/** Reads every file in a zip archive (stored or deflated), using the platform's DecompressionStream. */
export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
		if (v.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new FitError("not a zip archive");
	const count = v.getUint16(eocd + 10, true);
	let p = v.getUint32(eocd + 16, true);
	const out: ZipEntry[] = [];
	for (let n = 0; n < count; n++) {
		if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new FitError("corrupt zip directory");
		const method = v.getUint16(p + 10, true);
		const compressedSize = v.getUint32(p + 20, true);
		const nameLen = v.getUint16(p + 28, true);
		const extraLen = v.getUint16(p + 30, true);
		const commentLen = v.getUint16(p + 32, true);
		const local = v.getUint32(p + 42, true);
		const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
		p += 46 + nameLen + extraLen + commentLen;

		if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw new FitError("corrupt zip entry");
		const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
		const raw = bytes.subarray(start, start + compressedSize);
		if (method === 0) out.push({ name, data: raw });
		else if (method === 8) out.push({ name, data: await inflateRaw(raw) });
		// Other methods never appear in Garmin downloads; skip rather than fail.
	}
	return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream("deflate-raw");
	const writer = ds.writable.getWriter();
	// Not awaited: the readable side must drain concurrently. Errors surface there.
	writer.write(data).catch(() => {});
	writer.close().catch(() => {});
	try {
		return new Uint8Array(await new Response(ds.readable).arrayBuffer());
	} catch {
		throw new FitError("corrupt compressed data in zip");
	}
}

/** True when the bytes start with a FIT file header. */
export function isFit(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 12 &&
		(bytes[0] === 12 || bytes[0] === 14) &&
		bytes[8] === 0x2e && // .FIT
		bytes[9] === 0x46 &&
		bytes[10] === 0x49 &&
		bytes[11] === 0x54
	);
}

// ---- FIT ------------------------------------------------------------------

const MESG_SESSION = 18;
const MESG_LAP = 19;
const MESG_RECORD = 20;
const MESG_EVENT = 21;
const FIELD_TIMESTAMP = 253;

const EVENT_TYPES = [
	"start",
	"stop",
	"consecutive",
	"marker",
	"stopAll",
	"begin",
	"end",
	"endAll",
	"stopDisable",
	"stopDisableAll",
];
const INTENSITY = ["active", "rest", "warmup", "cooldown", "recovery", "interval", "other"];
const LAP_TRIGGER = [
	"manual",
	"time",
	"distance",
	"position_start",
	"position_lap",
	"position_waypoint",
	"position_marked",
	"session_end",
	"fitness_equipment",
];
const SPORTS: Record<number, string> = {
	0: "generic",
	1: "running",
	2: "cycling",
	4: "fitness_equipment",
	5: "swimming",
	10: "training",
	11: "walking",
	13: "cross_country_skiing",
	15: "rowing",
	17: "hiking",
	18: "multisport",
	19: "paddling",
	37: "stand_up_paddleboarding",
};

type FieldDef = { num: number; size: number; baseType: number };
type Definition = { global: number; little: boolean; fields: FieldDef[]; devSize: number; size: number };

/**
 * Reads one field value. Returns undefined for FIT "invalid" values and for
 * arrays/strings, which none of the fields we use need.
 */
function readField(v: DataView, at: number, f: FieldDef, little: boolean): number | undefined {
	switch (f.baseType & 0x1f) {
		case 0: // enum
		case 2: // uint8
		case 10: // uint8z
		case 13: {
			// byte
			const x = v.getUint8(at);
			return x === 0xff || ((f.baseType & 0x1f) === 10 && x === 0) ? undefined : x;
		}
		case 1: {
			const x = v.getInt8(at);
			return x === 0x7f ? undefined : x;
		}
		case 3: {
			if (f.size < 2) return undefined;
			const x = v.getInt16(at, little);
			return x === 0x7fff ? undefined : x;
		}
		case 4:
		case 11: {
			if (f.size < 2) return undefined;
			const x = v.getUint16(at, little);
			return x === 0xffff || ((f.baseType & 0x1f) === 11 && x === 0) ? undefined : x;
		}
		case 5: {
			if (f.size < 4) return undefined;
			const x = v.getInt32(at, little);
			return x === 0x7fffffff ? undefined : x;
		}
		case 6:
		case 12: {
			if (f.size < 4) return undefined;
			const x = v.getUint32(at, little);
			return x === 0xffffffff || ((f.baseType & 0x1f) === 12 && x === 0) ? undefined : x;
		}
		case 8: {
			if (f.size < 4) return undefined;
			const x = v.getFloat32(at, little);
			return Number.isFinite(x) ? x : undefined;
		}
		default:
			return undefined;
	}
}

const WANTED: Record<number, Set<number>> = {
	[MESG_RECORD]: new Set([FIELD_TIMESTAMP, 2, 3, 4, 5, 6, 7, 53, 73, 78]),
	[MESG_EVENT]: new Set([FIELD_TIMESTAMP, 0, 1]),
	[MESG_LAP]: new Set([FIELD_TIMESTAMP, 2, 7, 8, 9, 13, 15, 16, 17, 19, 20, 21, 22, 23, 24, 71, 80, 110]),
	[MESG_SESSION]: new Set([FIELD_TIMESTAMP, 2, 5, 6, 8, 9]),
};

/** Decodes the activity messages of a FIT file. Throws FitError on malformed data. */
export function decodeFit(bytes: Uint8Array): FitActivity {
	if (!isFit(bytes)) throw new FitError("not a FIT file");
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: FitActivity = { records: [], laps: [], events: [] };
	let fileStart = 0;
	// A download can hold several FIT files back to back ("chained" files).
	while (fileStart + 12 <= bytes.length && isFit(bytes.subarray(fileStart))) {
		const headerSize = bytes[fileStart]!;
		const dataEnd = fileStart + headerSize + v.getUint32(fileStart + 4, true);
		if (dataEnd > bytes.length) throw new FitError("truncated FIT file");
		decodeData(v, fileStart + headerSize, dataEnd, out);
		fileStart = dataEnd + 2; // skip file CRC
	}
	return out;
}

function decodeData(v: DataView, start: number, end: number, out: FitActivity) {
	const defs: (Definition | undefined)[] = new Array(16);
	let lastTs = 0;
	let p = start;
	while (p < end) {
		const h = v.getUint8(p++);
		if ((h & 0x80) === 0 && (h & 0x40) !== 0) {
			// Definition message.
			const little = v.getUint8(p + 1) === 0;
			const global = v.getUint16(p + 2, little);
			const n = v.getUint8(p + 4);
			p += 5;
			const fields: FieldDef[] = [];
			let size = 0;
			for (let i = 0; i < n; i++, p += 3) {
				const f = { num: v.getUint8(p), size: v.getUint8(p + 1), baseType: v.getUint8(p + 2) };
				fields.push(f);
				size += f.size;
			}
			let devSize = 0;
			if (h & 0x20) {
				const nd = v.getUint8(p++);
				for (let i = 0; i < nd; i++, p += 3) devSize += v.getUint8(p + 1);
			}
			defs[h & 0x0f] = { global, little, fields, devSize, size };
			continue;
		}

		const compressed = (h & 0x80) !== 0;
		const def = defs[compressed ? (h >> 5) & 0x03 : h & 0x0f];
		if (!def) throw new FitError(`data message before its definition at byte ${p - 1}`);
		if (p + def.size + def.devSize > end) throw new FitError("truncated FIT record");
		let ts: number | undefined;
		if (compressed) {
			const offset = h & 0x1f;
			ts = (lastTs & ~0x1f) + offset + (offset < (lastTs & 0x1f) ? 0x20 : 0);
			lastTs = ts;
		}

		const wanted = WANTED[def.global];
		if (!wanted) {
			// Still track timestamps so later compressed headers resolve correctly.
			for (const f of def.fields) {
				if (f.num === FIELD_TIMESTAMP) {
					const t = readField(v, p, f, def.little);
					if (t !== undefined) lastTs = t;
				}
				p += f.size;
			}
			p += def.devSize;
			continue;
		}

		const vals = new Map<number, number>();
		for (const f of def.fields) {
			if (wanted.has(f.num)) {
				const x = readField(v, p, f, def.little);
				if (x !== undefined) vals.set(f.num, x);
			}
			p += f.size;
		}
		p += def.devSize;
		const t = vals.get(FIELD_TIMESTAMP);
		if (t !== undefined) lastTs = t;
		ts = t ?? ts;
		collect(def.global, vals, ts, out);
	}
}

const scaled = (x: number | undefined, scale: number, offset = 0) =>
	x === undefined ? undefined : (x - offset * scale) / scale;

function collect(global: number, f: Map<number, number>, ts: number | undefined, out: FitActivity) {
	switch (global) {
		case MESG_RECORD: {
			if (ts === undefined) return;
			const cad = f.get(4);
			out.records.push({
				ts,
				distance: scaled(f.get(5), 100),
				hr: f.get(3),
				cadence: cad === undefined ? undefined : cad + (f.get(53) ?? 0) / 128,
				power: f.get(7),
				altitude: scaled(f.get(78) ?? f.get(2), 5, 500),
				speed: scaled(f.get(73) ?? f.get(6), 1000),
			});
			return;
		}
		case MESG_EVENT: {
			const type = f.get(1);
			if (ts === undefined || f.get(0) === undefined || type === undefined) return;
			out.events.push({ ts, event: f.get(0)!, type: EVENT_TYPES[type] ?? String(type) });
			return;
		}
		case MESG_LAP: {
			const cad = f.get(17);
			out.laps.push({
				startTs: f.get(2),
				elapsedTime: scaled(f.get(7), 1000),
				timerTime: scaled(f.get(8), 1000),
				distance: scaled(f.get(9), 100),
				avgSpeed: scaled(f.get(110) ?? f.get(13), 1000),
				avgHr: f.get(15),
				maxHr: f.get(16),
				avgCadence: cad === undefined ? undefined : cad + (f.get(80) ?? 0) / 128,
				avgPower: f.get(19),
				maxPower: f.get(20),
				ascent: f.get(21),
				descent: f.get(22),
				intensity: f.get(23) === undefined ? undefined : (INTENSITY[f.get(23)!] ?? String(f.get(23))),
				trigger: f.get(24) === undefined ? undefined : (LAP_TRIGGER[f.get(24)!] ?? String(f.get(24))),
				workoutStep: f.get(71),
			});
			return;
		}
		case MESG_SESSION: {
			const sport = f.get(5);
			if (sport !== undefined && out.sport === undefined) out.sport = SPORTS[sport] ?? "other";
			if (out.subSport === undefined) out.subSport = f.get(6);
			out.session ??= {
				startTs: f.get(2),
				timerTime: scaled(f.get(8), 1000),
				distance: scaled(f.get(9), 100),
			};
			return;
		}
	}
}
