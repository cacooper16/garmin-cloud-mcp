import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { detectInstall, npxHash } from "../src/install.ts";
import { MemoryKV } from "../src/memory-kv.ts";
import {
	CHECK_INTERVAL_SECONDS,
	checkUrl,
	compareSemver,
	howToUpdate,
	type Install,
	optedOut,
	UpdateCheck,
} from "../src/update.ts";
import { callGarminTool } from "./tool-harness.ts";

const RELEASE = "https://github.com/colincooperio/garmin-mcp/releases/tag/v1.5.0";
const DAY = CHECK_INTERVAL_SECONDS;

/** A fake GitHub: answers the version file, counts requests. */
function github(latest: string | Error = "1.5.0") {
	const urls: string[] = [];
	const inits: RequestInit[] = [];
	const fetch = async (url: string, init?: RequestInit) => {
		urls.push(url);
		inits.push(init ?? {});
		if (latest instanceof Error) throw latest;
		return Response.json({ latest, url: RELEASE });
	};
	return { fetch, urls, inits };
}

function checker(o: { install?: Install; latest?: string | Error; kv?: MemoryKV; clock?: { t: number }; disabled?: boolean; perDay?: boolean; current?: string } = {}) {
	const gh = github(o.latest);
	const clock = o.clock ?? { t: 1_800_000_000 };
	const kv = o.kv ?? new MemoryKV(() => clock.t);
	const u = new UpdateCheck({
		current: o.current ?? "1.4.0",
		install: o.install ?? { type: "mcpb" },
		kv,
		fetch: gh.fetch,
		now: () => clock.t,
		disabled: o.disabled,
		perDay: o.perDay,
	});
	return { u, gh, kv, clock };
}

describe("version file per install type", () => {
	it("downloads latest-<type>.json from the latest release", () => {
		const base = "https://github.com/colincooperio/garmin-mcp/releases/latest/download";
		assert.equal(checkUrl({ type: "mcpb" }), `${base}/latest-mcpb.json`);
		assert.equal(checkUrl({ type: "npx", pinned: false }), `${base}/latest-npx.json`);
		assert.equal(checkUrl({ type: "npx", pinned: true }), `${base}/latest-npx.json`);
		assert.equal(checkUrl({ type: "global" }), `${base}/latest-npx.json`, "other npm installs count as npx");
		assert.equal(checkUrl({ type: "cloud" }), `${base}/latest-cloud.json`);
	});

	it("sends a generic User-Agent, follows redirects and times out after 3 seconds", async () => {
		const { u, gh } = checker();
		await u.refresh();
		const init = gh.inits[0]!;
		assert.deepEqual(init.headers, { "User-Agent": "garmin-mcp-update-check", Accept: "application/json" });
		assert.equal(init.redirect, "follow");
		assert.ok(init.signal instanceof AbortSignal);
	});
});

describe("compareSemver", () => {
	it("orders versions numerically, pre-releases before releases", () => {
		assert.equal(compareSemver("1.5.0", "1.4.0"), 1);
		assert.equal(compareSemver("1.4.0", "1.4.0"), 0);
		assert.equal(compareSemver("1.3.9", "1.4.0"), -1);
		assert.equal(compareSemver("1.10.0", "1.9.0"), 1);
		assert.equal(compareSemver("1.5.0-beta.1", "1.5.0"), -1);
		assert.equal(compareSemver("v1.5.0", "1.4.0"), undefined);
	});
});

describe("UpdateCheck", () => {
	it("a newer version: one notice with the version, instruction, release link and note", async () => {
		const { u } = checker({ latest: "1.5.0" });
		await u.refresh();
		assert.deepEqual(await u.notice(), {
			current: "1.4.0",
			latest: "1.5.0",
			how_to_update: "Download garmin-mcp.mcpb from the latest release and double-click it.",
			release: RELEASE,
			note: "Mention this to the user once, briefly, then answer their question.",
		});
		assert.match(u.instructionsLine()!, /^An update is available \(1\.4\.0 -> 1\.5\.0\)\. When a tool result includes update_available, mention it to the user once, briefly/);
	});

	it("the same or an older version: no notice and no instructions line", async () => {
		for (const latest of ["1.4.0", "1.3.0", "1.4.0-rc.1"]) {
			const { u } = checker({ latest });
			await u.refresh();
			assert.equal(await u.notice(), undefined, latest);
			assert.equal(u.instructionsLine(), undefined, latest);
		}
	});

	it("fails silently when GitHub can't be reached, and doesn't retry for 24 hours", async () => {
		const clock = { t: 1_800_000_000 };
		const kv = new MemoryKV(() => clock.t);
		const down = checker({ latest: new Error("ENOTFOUND"), kv, clock });
		await down.u.refresh(); // doesn't throw
		assert.equal(await down.u.notice(), undefined);
		assert.equal(down.gh.urls.length, 1);
		// A new session (a restart) within the day doesn't try again...
		const later = checker({ kv, clock });
		await later.u.refresh();
		assert.equal(later.gh.urls.length, 0);
		// ...but after 24 hours it does.
		clock.t += DAY;
		await later.u.refresh();
		assert.equal(later.gh.urls.length, 1);
		assert.equal((await later.u.notice())?.latest, "1.5.0");
	});

	it("ignores a malformed answer", async () => {
		const u = new UpdateCheck({
			current: "1.4.0",
			install: { type: "mcpb" },
			kv: new MemoryKV(),
			fetch: async () => Response.json({ latest: "not-a-version", url: "https://evil.example/" }),
		});
		await u.refresh();
		assert.equal(await u.notice(), undefined);
	});

	it("checks at most once every 24 hours, using the cache across sessions", async () => {
		const clock = { t: 1_800_000_000 };
		const kv = new MemoryKV(() => clock.t);
		const first = checker({ kv, clock });
		await Promise.all([first.u.refresh(), first.u.refresh()]);
		assert.equal(first.gh.urls.length, 1, "concurrent refreshes share one request");
		clock.t += DAY - 60;
		const second = checker({ kv, clock });
		await second.u.refresh();
		assert.equal(second.gh.urls.length, 0, "cached");
		assert.equal((await second.u.notice())?.latest, "1.5.0", "a new session knows from the cache");
		assert.ok(second.u.instructionsLine(), "and says so at initialize");
		clock.t += 120;
		await second.u.refresh();
		assert.equal(second.gh.urls.length, 1, "the day has passed");
	});

	it("local: once per server session", async () => {
		const clock = { t: 1_800_000_000 };
		const kv = new MemoryKV(() => clock.t);
		const { u } = checker({ kv, clock });
		await u.refresh();
		assert.ok(await u.notice());
		assert.equal(await u.notice(), undefined);
		assert.equal(await u.notice(), undefined);
		const restarted = checker({ kv, clock });
		assert.ok(await restarted.u.notice(), "a new session shows it again");
	});

	it("cloud: once per day, across server instances sharing KV", async () => {
		const clock = { t: Date.parse("2026-11-14T08:00:00Z") / 1000 };
		const kv = new MemoryKV(() => clock.t);
		const a = checker({ kv, clock, install: { type: "cloud" }, perDay: true });
		await a.u.refresh();
		assert.equal((await a.u.notice())?.how_to_update, "Run npm run update in your garmin-mcp folder.");
		const b = checker({ kv, clock, install: { type: "cloud" }, perDay: true }); // another request
		assert.equal(await b.u.notice(), undefined, "already shown today");
		clock.t += 20 * 3600; // the next day
		const c = checker({ kv, clock, install: { type: "cloud" }, perDay: true });
		assert.ok(await c.u.notice());
	});

	it("GARMIN_MCP_NO_UPDATE_CHECK=1: no request, no notice", async () => {
		assert.equal(optedOut("1"), true);
		assert.equal(optedOut(" TRUE "), true);
		assert.equal(optedOut(undefined), false);
		assert.equal(optedOut("0"), false);
		const { u, gh } = checker({ disabled: true });
		await u.refresh();
		assert.equal(gh.urls.length, 0);
		assert.equal(await u.notice(), undefined);
		assert.equal(u.instructionsLine(), undefined);
	});

	it("unpinned npx: checked (so it's counted) but never told", async () => {
		const { u, gh } = checker({ install: { type: "npx", pinned: false } });
		await u.refresh();
		assert.deepEqual(gh.urls, ["https://github.com/colincooperio/garmin-mcp/releases/latest/download/latest-npx.json"]);
		assert.equal(await u.notice(), undefined);
		assert.equal(u.instructionsLine(), undefined);
	});

	it("gives one instruction per install type", () => {
		assert.equal(howToUpdate({ type: "mcpb" }, "1.5.0"), "Download garmin-mcp.mcpb from the latest release and double-click it.");
		assert.equal(howToUpdate({ type: "cloud" }, "1.5.0"), "Run npm run update in your garmin-mcp folder.");
		assert.equal(
			howToUpdate({ type: "npx", pinned: true, spec: "garmin-mcp@1.4.0" }, "1.5.0"),
			"Change garmin-mcp@1.4.0 to garmin-mcp@1.5.0 in your MCP config, then restart the app.",
		);
		assert.match(howToUpdate({ type: "npx", pinned: true }, "1.5.0"), /^Change the pinned garmin-mcp@<version> to garmin-mcp@1\.5\.0/);
		assert.equal(howToUpdate({ type: "global" }, "1.5.0"), "Run npm install -g garmin-mcp@1.5.0, then restart the app.");
	});
});

describe("detectInstall", () => {
	const npxPath = async (spec: string) => `/Users/me/.npm/_npx/${await npxHash(spec)}/node_modules/garmin-mcp/dist/stdio.js`;

	it("tells unpinned npx (garmin-mcp, garmin-mcp@latest) from pinned, the way npm names its cache folders", async () => {
		// libnpmexec: sha512 of the spec, first 16 hex characters (checked against Node's own hash).
		assert.equal(await npxHash("garmin-mcp"), createHash("sha512").update("garmin-mcp").digest("hex").slice(0, 16));
		assert.deepEqual(await detectInstall({}, await npxPath("garmin-mcp"), "1.4.0"), { type: "npx", pinned: false });
		assert.deepEqual(await detectInstall({}, await npxPath("garmin-mcp@latest"), "1.4.0"), { type: "npx", pinned: false });
		assert.deepEqual(await detectInstall({}, await npxPath("garmin-mcp@1.4.0"), "1.4.0"), { type: "npx", pinned: true, spec: "garmin-mcp@1.4.0" });
		const win = (await npxPath("garmin-mcp@1.4.0")).replace(/\//g, "\\");
		assert.deepEqual(await detectInstall({}, win, "1.4.0"), { type: "npx", pinned: true, spec: "garmin-mcp@1.4.0" }, "Windows paths");
	});

	it("falls back to unpinned (counted, no notice) whenever npx detection is uncertain", async () => {
		const unpinned = { type: "npx", pinned: false };
		// A range, another version's pin, several packages in one npx call.
		assert.deepEqual(await detectInstall({}, await npxPath("garmin-mcp@^1.3"), "1.4.0"), unpinned);
		assert.deepEqual(await detectInstall({}, await npxPath("garmin-mcp@1.3.0"), "1.4.0"), unpinned);
		assert.deepEqual(await detectInstall({}, await npxPath("garmin-mcp\nsomething-else"), "1.4.0"), unpinned);
		// npm changing its cache layout or hash length: still npx, still unpinned, not "global".
		assert.deepEqual(await detectInstall({}, "/Users/me/.npm/_npx/0123abcd/lib/node_modules/garmin-mcp/dist/stdio.js", "1.4.0"), unpinned);
		assert.deepEqual(await detectInstall({}, "/Users/me/.npm/_npx/x/garmin-mcp/stdio.js", "1.4.0"), unpinned);
		// Hashing failing: unpinned, so it's still counted.
		const subtle = globalThis.crypto.subtle;
		const digest = subtle.digest;
		(subtle as any).digest = async () => {
			throw new Error("no crypto");
		};
		try {
			assert.deepEqual(await detectInstall({}, await Promise.resolve("/Users/me/.npm/_npx/abcdef0123456789/node_modules/garmin-mcp/dist/stdio.js"), "1.4.0"), unpinned);
		} finally {
			(subtle as any).digest = digest;
		}
		// And the result is what the notice logic expects: counted, never told.
		const { u, gh } = checker({ install: unpinned as Install });
		await u.refresh();
		assert.equal(gh.urls.length, 1);
		assert.equal(await u.notice(), undefined);
	});

	it("knows the Desktop extension, other npm installs, and skips source checkouts", async () => {
		assert.deepEqual(await detectInstall({ GARMIN_MCP_INSTALL: "mcpb" }, "/Users/me/Library/x/server/index.js", "1.4.0"), { type: "mcpb" });
		assert.deepEqual(await detectInstall({}, "/usr/local/lib/node_modules/garmin-mcp/dist/stdio.js", "1.4.0"), { type: "global" });
		assert.equal(await detectInstall({}, "/Users/me/garmin-mcp/src/stdio.ts", "1.4.0"), undefined);
		assert.equal(await detectInstall({}, "/Users/me/garmin-mcp/mcpb/server/index.js", "1.4.0"), undefined);
	});
});

describe("the notice in tool results", () => {
	const settings = (url: URL) =>
		url.pathname.includes("dailysummaries")
			? Response.json({ data: [{ calendarDate: "2020-01-01", movement: { steps: { value: 1234 } } }] })
			: new Response("unexpected", { status: 500 });

	it("goes first in the first result, and not in the next", async () => {
		const { u } = checker({ latest: "1.5.0" });
		await u.refresh();
		const args = { start_date: "2020-01-01", end_date: "2020-01-02" };
		const first = await callGarminTool("get_daily_summaries", settings, args, { update: u });
		assert.deepEqual(Object.keys(first), ["update_available", "result"], "a list result is wrapped");
		assert.equal(first.update_available.latest, "1.5.0");
		assert.equal(first.update_available.note, "Mention this to the user once, briefly, then answer their question.");
		const second = await callGarminTool("get_daily_summaries", settings, args, { update: u });
		assert.ok(Array.isArray(second) && second[0].steps === 1234, "unchanged shape once shown");
		assert.equal(first.result[0].steps, 1234);
	});

	it("is added to the server instructions when already known", async () => {
		const { InMemoryTransport } = await import("@modelcontextprotocol/server");
		const { createGarminServer } = await import("../src/server.ts");
		const { u } = checker({ latest: "1.5.0" });
		await u.refresh();
		const server = createGarminServer(() => {
			throw new Error("not needed");
		}, { update: u });
		const [c, s] = InMemoryTransport.createLinkedPair();
		const got = new Promise<any>((resolve) => (c.onmessage = resolve as any));
		await server.connect(s);
		await c.start();
		await c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
		const init = await got;
		await server.close();
		assert.match(init.result.instructions, /An update is available \(1\.4\.0 -> 1\.5\.0\)/);
	});
});
