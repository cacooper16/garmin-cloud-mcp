import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	_resetCachesForTests,
	GarminApiError,
	GarminClient,
	jwtExpiry,
	type KVLike,
	TOKEN_PATH,
} from "../src/garmin.ts";
import { isAllowedUser } from "../src/allowlist.ts";
import { formatResult, isRealDate, MAX_OUTPUT_CHARS, resolveRange } from "../src/tools.ts";

const NOW = 1_800_000_000;

function makeJwt(exp: number): string {
	const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${b64({ alg: "RS256" })}.${b64({ exp, sub: "u" })}.sig`;
}

class FakeKV implements KVLike {
	store = new Map<string, string>();
	ttls = new Map<string, number | undefined>();
	async get(k: string) {
		return this.store.get(k) ?? null;
	}
	async put(k: string, v: string, o?: { expirationTtl?: number }) {
		this.store.set(k, v);
		this.ttls.set(k, o?.expirationTtl);
	}
	async delete(k: string) {
		this.store.delete(k);
	}
}

type Call = { url: string; auth: string };

/** Fake Garmin: issues tokens, serves data, can be told to 401 a given token. */
function fakeGarmin(opts: { tokenExp?: number; revoked?: Set<string>; tokenStatus?: number } = {}) {
	const calls: Call[] = [];
	let n = 0;
	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const auth = new Headers(init?.headers).get("Authorization") ?? "";
		calls.push({ url, auth });
		if (url.endsWith(TOKEN_PATH)) {
			if (opts.tokenStatus) return new Response("nope", { status: opts.tokenStatus });
			assert.match(auth, /^ApiKey /);
			n++;
			// Make each issued token distinct.
			return new Response(`${makeJwt((opts.tokenExp ?? NOW + 86_400) + n)}\n`, { status: 200 });
		}
		const token = auth.replace(/^Bearer /, "");
		if (opts.revoked?.has(token)) return new Response("expired", { status: 401 });
		return Response.json({ ok: true, path: new URL(url).pathname, q: new URL(url).search });
	};
	return { fetch, calls, tokenCalls: () => calls.filter((c) => c.url.endsWith(TOKEN_PATH)).length };
}

const client = (kv: KVLike, f: ReturnType<typeof fakeGarmin>, now = () => NOW) =>
	new GarminClient({ apiKey: "test-key", kv, fetch: f.fetch, now });

describe("GarminClient", () => {
	beforeEach(() => _resetCachesForTests());

	it("exchanges the key once and reuses the cached token", async () => {
		const kv = new FakeKV();
		const g = fakeGarmin();
		const c = client(kv, g);
		await c.get("/a");
		await c.get("/b");
		await client(kv, g).get("/c"); // new client instance, same isolate
		assert.equal(g.tokenCalls(), 1);
		assert.equal(g.calls.length, 4);
		assert.match(g.calls[1]!.auth, /^Bearer ey/);
	});

	it("reads the token from KV after an isolate restart, with TTL set to token expiry", async () => {
		const kv = new FakeKV();
		const g = fakeGarmin();
		await client(kv, g).get("/a");
		const [[, ttl]] = [...kv.ttls];
		assert.ok(ttl! > 86_000 && ttl! <= 86_401, `ttl ${ttl}`);
		_resetCachesForTests(); // simulate a cold isolate
		await client(kv, g).get("/b");
		assert.equal(g.tokenCalls(), 1);
	});

	it("never stores the raw API key in KV", async () => {
		const kv = new FakeKV();
		await client(kv, fakeGarmin()).get("/a");
		for (const [k, v] of kv.store) {
			assert.ok(!k.includes("test-key") && !v.includes("test-key"));
		}
	});

	it("refreshes when the token is within an hour of expiry", async () => {
		const kv = new FakeKV();
		const g = fakeGarmin({ tokenExp: NOW + 3000 }); // < 1h left
		const c = client(kv, g);
		await c.get("/a");
		await c.get("/b");
		assert.equal(g.tokenCalls(), 2);
	});

	it("collapses concurrent refreshes into one token call", async () => {
		const g = fakeGarmin();
		const c = client(new FakeKV(), g);
		await Promise.all([c.get("/a"), c.get("/b"), c.get("/c"), c.get("/d")]);
		assert.equal(g.tokenCalls(), 1);
	});

	it("on 401, fetches a new token and retries once", async () => {
		const revoked = new Set<string>();
		const g = fakeGarmin({ revoked });
		const kv = new FakeKV();
		const c = client(kv, g);
		await c.get("/a");
		revoked.add(g.calls[1]!.auth.replace("Bearer ", "")); // revoke the first token
		const res = (await c.get("/b")) as { ok: boolean };
		assert.equal(res.ok, true);
		assert.equal(g.tokenCalls(), 2);
	});

	it("releases the 401 response body before retrying", async () => {
		let cancelled = false;
		let first = true;
		const fetch = async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith(TOKEN_PATH)) return new Response(makeJwt(NOW + 86_400 + Number(!first)));
			if (first) {
				first = false;
				const body = new ReadableStream({
					cancel() {
						cancelled = true;
					},
				});
				return new Response(body, { status: 401 });
			}
			return Response.json({ ok: true });
		};
		const c = new GarminClient({ apiKey: "test-key", kv: new FakeKV(), fetch, now: () => NOW });
		assert.deepEqual(await c.get("/a"), { ok: true });
		assert.ok(cancelled, "unread 401 body was cancelled");
	});

	it("gives an actionable error when the key itself is rejected", async () => {
		const c = client(new FakeKV(), fakeGarmin({ tokenStatus: 401 }));
		await assert.rejects(c.get("/a"), (e: GarminApiError) => {
			assert.match(e.message, /wrangler secret put GARMIN_API_KEY/);
			return true;
		});
	});

	it("refuses to start without a key", () => {
		assert.throws(() => new GarminClient({ apiKey: " ", kv: new FakeKV() }), /GARMIN_API_KEY/);
	});

	it("builds query strings and drops empty params", async () => {
		const c = client(new FakeKV(), fakeGarmin());
		const res = (await c.get("/x", { startDate: "2026-11-01", type: undefined, z: "" })) as {
			q: string;
		};
		assert.equal(res.q, "?startDate=2026-11-01");
	});

	it("rejects paths that could leave the Garmin host", () => {
		const c = client(new FakeKV(), fakeGarmin());
		for (const bad of [
			"//evil.com/x",
			"/../x",
			"@evil.com",
			"https://evil.com",
			"/a?b=c",
			"/a#frag",
			"x",
			"/a\\b",
		]) {
			assert.throws(() => c.buildUrl(bad), GarminApiError, bad);
		}
		assert.equal(
			c.buildUrl("/hrv-service/hrv/2026-11-01").href,
			"https://personal.connectapi.garmin.com/hrv-service/hrv/2026-11-01",
		);
	});

	it("parses JWT exp and rejects non-JWTs", () => {
		assert.equal(jwtExpiry(makeJwt(123)), 123);
		assert.throws(() => jwtExpiry("not-a-jwt"), GarminApiError);
	});
});

describe("response cache", () => {
	beforeEach(() => _resetCachesForTests());
	// NOW = 2027-01-15T08:00Z, so the cache cutoff is 2027-01-12.
	const cached = (kv: KVLike, f: ReturnType<typeof fakeGarmin>) =>
		new GarminClient({ apiKey: "test-key", kv, fetch: f.fetch, now: () => NOW, cacheResponses: true });
	const dataCalls = (f: ReturnType<typeof fakeGarmin>) => f.calls.filter((c) => !c.url.endsWith(TOKEN_PATH)).length;

	it("serves settled past dates from KV on repeat", async () => {
		const kv = new FakeKV();
		const f = fakeGarmin();
		const a = await cached(kv, f).get("/hrv-service/hrv/daily/2026-12-01/2026-12-31");
		_resetCachesForTests();
		const b = await cached(kv, f).get("/hrv-service/hrv/daily/2026-12-01/2026-12-31");
		assert.deepEqual(a, b);
		assert.equal(dataCalls(f), 1);
		const key = [...kv.store.keys()].find((k) => k.startsWith("garmin:resp:"));
		assert.equal(kv.ttls.get(key!), 7 * 86_400);
	});

	it("never caches recent dates, undated paths, or when disabled", async () => {
		const kv = new FakeKV();
		const f = fakeGarmin();
		const c = cached(kv, f);
		await c.get("/hrv-service/hrv/daily/2027-01-01/2027-01-14");
		await c.get("/hrv-service/hrv/daily/2027-01-01/2027-01-14");
		await c.get("/activity-service/activity/123");
		await c.get("/activity-service/activity/123");
		await client(kv, f).get("/hrv-service/hrv/daily/2026-12-01/2026-12-31");
		await client(kv, f).get("/hrv-service/hrv/daily/2026-12-01/2026-12-31");
		assert.equal(dataCalls(f), 6);
		assert.ok(![...kv.store.keys()].some((k) => k.startsWith("garmin:resp:")));
	});

	it("never caches an open-ended range, however old its one date", async () => {
		const kv = new FakeKV();
		const f = fakeGarmin();
		const c = cached(kv, f);
		const path = "/activitylist-service/activities/search/activities";
		await c.get(path, { startDate: "2026-01-01" });
		await c.get(path, { startDate: "2026-01-01" });
		await c.get(path, { endDate: "2026-01-31" });
		await c.get(path, { endDate: "2026-01-31" });
		assert.equal(dataCalls(f), 4);
		await c.get(path, { startDate: "2026-01-01", endDate: "2026-01-31" });
		await c.get(path, { startDate: "2026-01-01", endDate: "2026-01-31" });
		assert.equal(dataCalls(f), 5, "a closed past range is still cached");
	});

	it("caches undated paths when the caller passes a TTL", async () => {
		const kv = new FakeKV();
		const f = fakeGarmin();
		await cached(kv, f).get("/activity-service/activity/123", undefined, { cacheTtl: 86_400 });
		await cached(kv, f).get("/activity-service/activity/123", undefined, { cacheTtl: 86_400 });
		assert.equal(dataCalls(f), 1);
	});
});

describe("tool helpers", () => {
	it("validates real dates", () => {
		assert.ok(isRealDate("2028-02-29"));
		assert.ok(!isRealDate("2026-02-30"));
		assert.ok(!isRealDate("2026-13-01"));
	});

	it("caps and orders ranges", () => {
		assert.deepEqual(resolveRange("2026-11-01"), ["2026-11-01", "2026-11-01"]);
		assert.deepEqual(resolveRange("2026-08-07", "2026-11-06"), ["2026-08-07", "2026-11-06"]); // 92 days
		assert.throws(() => resolveRange("2026-08-06", "2026-11-06"), /max is 92/);
		assert.throws(() => resolveRange("2026-11-06", "2026-11-01"), /before/);
	});

	it("truncates huge payloads with a note", () => {
		const out = formatResult({ s: "x".repeat(MAX_OUTPUT_CHARS * 2) });
		assert.ok(out.content[0]!.text.length < MAX_OUTPUT_CHARS + 300);
		assert.match(out.content[0]!.text, /TRUNCATED/);
	});
});

describe("allowlist", () => {
	it("fails closed and matches exact numeric IDs only", () => {
		assert.equal(isAllowedUser(42, "42"), true);
		assert.equal(isAllowedUser(43, "42"), false);
		assert.equal(isAllowedUser("42", "42"), false);
		assert.equal(isAllowedUser(0, "0"), false);
		assert.equal(isAllowedUser(undefined, undefined), false);
		assert.equal(isAllowedUser(42, ""), false);
		assert.equal(isAllowedUser(42, "abc"), false);
	});
});
