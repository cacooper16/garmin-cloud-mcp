import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cacheDir, createLocalKV, FileKV, SplitKV } from "../src/file-kv.ts";
import { GarminClient } from "../src/garmin.ts";
import { MemoryKV } from "../src/memory-kv.ts";

const root = mkdtempSync(join(tmpdir(), "garmin-mcp-filekv-"));
let n = 0;
const freshDir = () => join(root, `c${n++}`);
after(() => rmSync(root, { recursive: true, force: true }));

const files = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".json"));
const isPosix = process.platform !== "win32";
const isRoot = process.getuid?.() === 0;

describe("FileKV", () => {
	it("stores, returns, overwrites and deletes values across instances", async () => {
		const dir = freshDir();
		const kv = new FileKV(dir);
		assert.equal(await kv.get("garmin:resp:a"), null);
		await kv.put("garmin:resp:a", "1");
		await kv.put("garmin:resp:a", "2");
		assert.equal(await new FileKV(dir).get("garmin:resp:a"), "2", "survives a restart");
		assert.equal(files(dir).length, 1, "an overwrite replaces the file");
		await kv.delete("garmin:resp:a");
		assert.equal(await kv.get("garmin:resp:a"), null);
		await kv.delete("garmin:resp:missing"); // no-op
	});

	it("names files by a hash of the key and keeps the key out of the directory listing", async () => {
		const dir = freshDir();
		await new FileKV(dir).put("garmin:derived:analysis/../x", "v");
		const [name] = files(dir);
		assert.match(name!, /^[0-9a-f]{64}\.json$/);
	});

	it("honours expirationTtl, including across restarts", async () => {
		const dir = freshDir();
		let now = 1_000;
		const kv = new FileKV(dir, { now: () => now });
		await kv.put("garmin:resp:ttl", "x", { expirationTtl: 60 });
		await kv.put("garmin:resp:forever", "y");
		now += 59;
		assert.equal(await new FileKV(dir, { now: () => now }).get("garmin:resp:ttl"), "x");
		now += 1;
		assert.equal(await kv.get("garmin:resp:ttl"), null);
		assert.equal(files(dir).length, 1, "the expired file is removed on read");
		now += 10_000_000;
		assert.equal(await kv.get("garmin:resp:forever"), "y");
	});

	it("writes atomically: no temp files left, and an overwrite is all-or-nothing", async () => {
		const dir = freshDir();
		const kv = new FileKV(dir);
		const big = "x".repeat(200_000);
		await Promise.all(Array.from({ length: 20 }, (_, i) => kv.put("garmin:resp:same", `${i}:${big}`)));
		const v = await kv.get("garmin:resp:same");
		assert.match(v!, /^\d+:x{200000}$/, "a complete value from one of the writers");
		assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
	});

	it("treats a corrupt file as a miss", async () => {
		const dir = freshDir();
		const kv = new FileKV(dir);
		await kv.put("garmin:resp:c", "ok");
		writeFileSync(join(dir, files(dir)[0]!), "{not json");
		assert.equal(await kv.get("garmin:resp:c"), null);
	});

	it("creates the directory 0700 and files 0600", { skip: !isPosix }, async () => {
		const dir = freshDir();
		await new FileKV(dir).put("garmin:resp:p", "v");
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		assert.equal(statSync(join(dir, files(dir)[0]!)).mode & 0o777, 0o600);
	});

	it("evicts the oldest files first when over the size cap", async () => {
		const dir = freshDir();
		const value = "v".repeat(1_000);
		const kv = new FileKV(dir, { maxBytes: 5_500 });
		for (let i = 0; i < 5; i++) {
			await kv.put(`garmin:resp:${i}`, value);
			// Spread mtimes so "oldest" is unambiguous on coarse filesystems.
			const f = readdirSync(dir).map((x) => join(dir, x)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
			utimesSync(f, 1_000 + i, 1_000 + i);
		}
		assert.equal(files(dir).length, 5, "under the cap so far");
		await kv.put("garmin:resp:5", value);
		assert.equal(await kv.get("garmin:resp:0"), null, "oldest evicted");
		assert.equal(await kv.get("garmin:resp:5"), value, "newest kept");
		const total = files(dir).reduce((s, f) => s + statSync(join(dir, f)).size, 0);
		assert.ok(total <= 5_500 * 0.9, `total ${total} should be under 90% of the cap`);
	});

	it("drops expired files when it first opens the directory", async () => {
		const dir = freshDir();
		let now = 0;
		await new FileKV(dir, { now: () => now }).put("garmin:resp:old", "x", { expirationTtl: 60 });
		now = 1_000;
		const kv = new FileKV(dir, { now: () => now });
		await kv.get("garmin:resp:other");
		assert.equal(files(dir).length, 0);
	});

	it("falls back to memory with one warning when the directory can't be created", async () => {
		const blocker = join(root, `file${n++}`);
		writeFileSync(blocker, "not a directory");
		const warnings: string[] = [];
		const kv = new FileKV(join(blocker, "cache"), { warn: (m) => warnings.push(m) });
		await kv.put("garmin:resp:a", "1");
		await kv.put("garmin:resp:b", "2");
		assert.equal(await kv.get("garmin:resp:a"), "1", "still works, in memory");
		assert.equal(kv.onDisk, false);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /caching in memory/);
	});

	it("falls back to memory with one warning when the directory isn't writable", { skip: !isPosix || isRoot }, async () => {
		const dir = freshDir();
		const warnings: string[] = [];
		const kv = new FileKV(dir, { warn: (m) => warnings.push(m) });
		await kv.get("garmin:resp:init"); // creates the directory
		chmodSync(dir, 0o500);
		try {
			await kv.put("garmin:resp:a", "1");
			await kv.put("garmin:resp:b", "2");
			assert.equal(await kv.get("garmin:resp:a"), "1");
			assert.equal(warnings.length, 1);
		} finally {
			chmodSync(dir, 0o700);
		}
	});
});

describe("SplitKV / createLocalKV", () => {
	it("never writes the Garmin bearer token (or any non-allowlisted key) to disk", async () => {
		const dir = freshDir();
		const { kv } = createLocalKV({ GARMIN_MCP_CACHE_DIR: dir });
		const jwt = (exp: number) =>
			`${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
		const token = jwt(Math.floor(Date.now() / 1000) + 86_400);
		const fetch = async (url: string | URL | Request) => {
			const u = new URL(String(url));
			if (u.pathname.endsWith("/token")) return new Response(token);
			return Response.json([{ calendarDate: "2020-01-01", totalSteps: 1 }]);
		};
		const client = new GarminClient({ apiKey: "secret-api-key", kv, fetch, cacheResponses: true });
		await client.get("/usersummary-service/v2/dailysummaries", { startDate: "2020-01-01", endDate: "2020-01-01" });
		await client.putCached("analysis:v2:1", { v: 2 });
		await kv.put("anything:else", "secret");

		const onDisk = files(dir).map((f) => readFileSync(join(dir, f), "utf8"));
		assert.equal(onDisk.length, 2, "the cached response and the analysis");
		for (const body of onDisk) {
			assert.ok(!body.includes(token), "token on disk");
			assert.ok(!body.includes("secret-api-key"), "API key on disk");
			assert.ok(!body.includes("secret"), "non-allowlisted value on disk");
		}
		assert.equal(await kv.get("anything:else"), "secret", "still served from memory");
	});

	it("routes by prefix", async () => {
		const disk = new MemoryKV();
		const memory = new MemoryKV();
		const kv = new SplitKV(disk, memory);
		await kv.put("garmin:token:abc", "t");
		await kv.put("garmin:resp:abc", "r");
		await kv.put("garmin:derived:abc", "d");
		assert.equal(await disk.get("garmin:token:abc"), null);
		assert.equal(await memory.get("garmin:token:abc"), "t");
		assert.equal(await disk.get("garmin:resp:abc"), "r");
		assert.equal(await disk.get("garmin:derived:abc"), "d");
	});

	it("GARMIN_MCP_NO_CACHE=1 keeps everything in memory", async () => {
		const dir = freshDir();
		const { kv, dir: used } = createLocalKV({ GARMIN_MCP_CACHE_DIR: dir, GARMIN_MCP_NO_CACHE: "1" });
		await kv.put("garmin:resp:a", "1");
		assert.equal(used, undefined);
		assert.equal(await kv.get("garmin:resp:a"), "1");
		assert.throws(() => readdirSync(dir), /ENOENT/);
	});

	it("works out the cache directory per platform", () => {
		assert.equal(cacheDir({ GARMIN_MCP_CACHE_DIR: "/x/y" }, "linux", "/home/u"), "/x/y");
		assert.equal(cacheDir({ XDG_CACHE_HOME: "/xdg" }, "linux", "/home/u"), join("/xdg", "garmin-mcp"));
		assert.equal(cacheDir({}, "linux", "/home/u"), join("/home/u", ".cache", "garmin-mcp"));
		assert.equal(cacheDir({}, "darwin", "/Users/u"), join("/Users/u", ".cache", "garmin-mcp"));
		assert.equal(
			cacheDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u"),
			join("C:\\Users\\u\\AppData\\Local", "garmin-mcp", "cache"),
		);
	});
});
