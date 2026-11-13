/// <reference types="node" />
/**
 * On-disk cache for the local stdio server, so derived data (activity
 * analyses, settled past-date responses) survives restarts.
 *
 * - One file per key, named by a hash of the key, under a private directory
 *   (0700, files 0600). Writes go to a temp file that is then renamed, so a
 *   reader never sees half a file.
 * - Only allowlisted key prefixes reach disk. Everything else, including the
 *   Garmin bearer token, stays in memory (see createLocalKV).
 * - Size-capped: when over the cap, expired files go first, then the oldest.
 * - Never fatal. If the directory can't be created or written, it logs one
 *   warning to stderr and carries on in memory.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KVLike } from "./garmin.ts";
import { MemoryKV } from "./memory-kv.ts";

/** Default cap on the cache directory's total size. */
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/** After evicting, aim this far under the cap so the next few writes don't evict again. */
const PRUNE_TARGET = 0.9;
const SUFFIX = ".json";

/**
 * Keys that may be written to disk: cached Garmin responses and derived
 * values (analyses), both already keyed by a hash of the API key. Anything
 * else (notably `garmin:token:*`, the bearer token) is kept in memory only.
 */
export const DISK_PREFIXES = ["garmin:resp:", "garmin:derived:"] as const;

export const isDiskKey = (key: string) => DISK_PREFIXES.some((p) => key.startsWith(p));

type Stored = { e: number | null; v: string };

export interface FileKVOptions {
	maxBytes?: number;
	/** Seconds since epoch; injectable for tests. */
	now?: () => number;
	/** Where the one-off warning goes. Defaults to stderr (stdout carries MCP). */
	warn?: (msg: string) => void;
}

/** One file per key under `dir`. Falls back to memory, with one warning, if the disk fails. */
export class FileKV implements KVLike {
	readonly dir: string;
	private readonly maxBytes: number;
	private readonly now: () => number;
	private readonly warn: (msg: string) => void;
	private readonly memory: MemoryKV;
	/** Set once the disk has failed; from then on everything is in memory. */
	private disabled = false;
	private ready?: Promise<void>;
	/** Running estimate of the directory's size; recomputed by every prune. */
	private size = 0;
	private pruning?: Promise<void>;

	constructor(dir: string, opts: FileKVOptions = {}) {
		this.dir = dir;
		this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
		this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
		this.warn = opts.warn ?? ((msg) => console.error(msg));
		this.memory = new MemoryKV(this.now);
	}

	/** True while the disk is in use (false after a failure fell back to memory). */
	get onDisk(): boolean {
		return !this.disabled;
	}

	private file(key: string): string {
		return join(this.dir, createHash("sha256").update(key).digest("hex") + SUFFIX);
	}

	/** Creates the directory and measures what's there, once, on first use. */
	private init(): Promise<void> {
		this.ready ??= (async () => {
			try {
				await mkdir(this.dir, { recursive: true, mode: 0o700 });
				await this.prune();
			} catch (err) {
				this.fail(err);
			}
		})();
		return this.ready;
	}

	private fail(err: unknown) {
		if (this.disabled) return;
		this.disabled = true;
		const reason = err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.message) : String(err);
		this.warn(`garmin-mcp: can't use the cache directory ${this.dir} (${reason}); caching in memory for this session instead.`);
	}

	async get(key: string): Promise<string | null> {
		await this.init();
		if (this.disabled) return this.memory.get(key);
		const path = this.file(key);
		let entry: Stored;
		try {
			entry = JSON.parse(await readFile(path, "utf8")) as Stored;
		} catch {
			// Missing, unreadable or corrupt: a cache miss either way.
			return null;
		}
		if (typeof entry?.v !== "string") return null;
		if (entry.e !== null && entry.e <= this.now()) {
			await unlink(path).catch(() => {});
			return null;
		}
		return entry.v;
	}

	async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
		await this.init();
		if (this.disabled) return this.memory.put(key, value, options);
		const ttl = options?.expirationTtl;
		const body = JSON.stringify({ e: ttl === undefined ? null : this.now() + ttl, v: value } satisfies Stored);
		const path = this.file(key);
		const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(tmp, body, { mode: 0o600 });
			await rename(tmp, path);
		} catch (err) {
			await unlink(tmp).catch(() => {});
			this.fail(err);
			return this.memory.put(key, value, options);
		}
		this.size += Buffer.byteLength(body);
		if (this.size > this.maxBytes) await this.prune();
	}

	async delete(key: string): Promise<void> {
		await this.init();
		if (this.disabled) return this.memory.delete(key);
		await unlink(this.file(key)).catch(() => {});
	}

	/**
	 * Re-measures the directory, drops expired entries and leftover temp files,
	 * then deletes the oldest files until it's comfortably under the cap.
	 */
	prune(): Promise<void> {
		this.pruning ??= this.doPrune().finally(() => (this.pruning = undefined));
		return this.pruning;
	}

	private async doPrune(): Promise<void> {
		const now = this.now();
		const files: { path: string; size: number; mtime: number }[] = [];
		for (const name of await readdir(this.dir)) {
			const path = join(this.dir, name);
			const isTmp = name.endsWith(".tmp");
			if (!isTmp && !name.endsWith(SUFFIX)) continue; // not ours
			const st = await stat(path).catch(() => undefined);
			if (!st?.isFile()) continue;
			// A temp file over a minute old is from a write that never finished.
			if (isTmp) {
				if (Date.now() - st.mtimeMs > 60_000) await unlink(path).catch(() => {});
				continue;
			}
			if (await this.expired(path, now)) {
				await unlink(path).catch(() => {});
				continue;
			}
			files.push({ path, size: st.size, mtime: st.mtimeMs });
		}
		let total = files.reduce((n, f) => n + f.size, 0);
		if (total > this.maxBytes) {
			files.sort((a, b) => a.mtime - b.mtime);
			const target = this.maxBytes * PRUNE_TARGET;
			for (const f of files) {
				if (total <= target) break;
				await unlink(f.path).catch(() => {});
				total -= f.size;
			}
		}
		this.size = total;
	}

	private async expired(path: string, now: number): Promise<boolean> {
		try {
			const entry = JSON.parse(await readFile(path, "utf8")) as Stored;
			return typeof entry?.v !== "string" || (entry.e !== null && entry.e <= now);
		} catch {
			return true; // corrupt
		}
	}
}

/**
 * Sends allowlisted keys to `disk` and everything else to `memory`, so a
 * token or anything credential-like can never be written to disk.
 */
export class SplitKV implements KVLike {
	private readonly disk: KVLike;
	private readonly memory: KVLike;

	constructor(disk: KVLike, memory: KVLike = new MemoryKV()) {
		this.disk = disk;
		this.memory = memory;
	}

	private pick(key: string): KVLike {
		return isDiskKey(key) ? this.disk : this.memory;
	}

	get(key: string) {
		return this.pick(key).get(key);
	}

	put(key: string, value: string, options?: { expirationTtl?: number }) {
		return this.pick(key).put(key, value, options);
	}

	delete(key: string) {
		return this.pick(key).delete(key);
	}
}

type Env = Record<string, string | undefined>;

/**
 * Where the cache lives: GARMIN_MCP_CACHE_DIR, else $XDG_CACHE_HOME/garmin-mcp,
 * else %LOCALAPPDATA%\garmin-mcp\cache on Windows or ~/.cache/garmin-mcp
 * elsewhere.
 */
export function cacheDir(env: Env = process.env, platform = process.platform, home = homedir()): string {
	if (env.GARMIN_MCP_CACHE_DIR?.trim()) return env.GARMIN_MCP_CACHE_DIR.trim();
	if (env.XDG_CACHE_HOME?.trim()) return join(env.XDG_CACHE_HOME.trim(), "garmin-mcp");
	if (platform === "win32") {
		const base = env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
		return join(base, "garmin-mcp", "cache");
	}
	return join(home, ".cache", "garmin-mcp");
}

/** The KV the stdio server uses: disk-backed for derived data unless GARMIN_MCP_NO_CACHE=1. */
export function createLocalKV(
	env: Env = process.env,
	opts: FileKVOptions = {},
): { kv: KVLike; dir?: string } {
	if (["1", "true", "yes"].includes(env.GARMIN_MCP_NO_CACHE?.trim().toLowerCase() ?? "")) {
		return { kv: new MemoryKV(opts.now) };
	}
	let dir: string;
	try {
		dir = cacheDir(env);
	} catch (err) {
		(opts.warn ?? ((m: string) => console.error(m)))(
			`garmin-mcp: can't work out a cache directory (${err instanceof Error ? err.message : String(err)}); caching in memory.`,
		);
		return { kv: new MemoryKV(opts.now) };
	}
	return { kv: new SplitKV(new FileKV(dir, opts), new MemoryKV(opts.now)), dir };
}
