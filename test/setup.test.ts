// npm run setup / npm run update, driven with a fake command runner, scripted
// answers and an in-memory file store: no wrangler, git, npm or network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { askValid, describeFailure, makeIO, missingSettings, readKvId, readValue } from "../scripts/lib.mjs";
import { runSetup } from "../scripts/setup.mjs";
import { NEW_REMOTE, runUpdate } from "../scripts/update.mjs";

const EXAMPLE = readFileSync(new URL("../wrangler.example.jsonc", import.meta.url), "utf8");
const KV_ID = "0123456789abcdef0123456789abcdef";
const ACCOUNT = { id: "a".repeat(32), name: "Me" };
const GH_ID = "Ov23liAbCdEfGhIjKlMn";
const GH_SECRET = "0123456789abcdef0123456789abcdef01234567";
const GARMIN_KEY = "garmin-secret-key-123456";
const CF_TOKEN = "cf-oauth-token-should-never-be-printed";

type Result = { code: number; stdout?: string; stderr?: string };
type Handler = (args: string[], opts: { input?: string; inherit?: boolean }) => Result | undefined;

/** A fake world: commands answered by `handlers` (first match by prefix), files in a Map. */
function world(handlers: Record<string, Handler | Result>, files: Record<string, string> = {}) {
	const store = new Map(Object.entries({ "wrangler.example.jsonc": EXAMPLE, ...files }));
	const calls: { cmd: string; args: string[]; input?: string; inherit?: boolean }[] = [];
	const run = async (cmd: string, args: string[], opts: { input?: string; inherit?: boolean } = {}) => {
		calls.push({ cmd, args, ...opts });
		// "npx --no -- wrangler x y" is looked up as "wrangler x y".
		const line = (cmd === "npx" && args[0] === "--no" ? args.slice(2) : [cmd, ...args]).join(" ");
		const key = Object.keys(handlers)
			.sort((a, b) => b.length - a.length)
			.find((k) => line === k || line.startsWith(`${k} `));
		if (!key) return { code: 1, stdout: "", stderr: `unexpected command: ${line}` };
		const h = handlers[key]!;
		const r = typeof h === "function" ? h(args, opts) : h;
		return { code: r?.code ?? 0, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
	};
	const fs = {
		exists: (f: string) => store.has(f),
		read: (f: string) => {
			if (!store.has(f)) throw new Error(`ENOENT ${f}`);
			return store.get(f)!;
		},
		write: (f: string, t: string) => void store.set(f, t),
	};
	return { run, files: fs, store, calls };
}

/** Scripted answers, in order; an empty answer takes the prompt's default. */
function io(answers: string[]) {
	const queue = [...answers];
	const printed: string[] = [];
	const asked: string[] = [];
	const hidden: string[] = [];
	let empty = 0;
	const next = async (q: string) => {
		asked.push(q);
		if (queue.length) return queue.shift()!;
		// Running out means Enter (the default), but a loop that keeps asking is a bug.
		if (++empty > 20) throw new Error(`test ran out of answers; still asking: ${q.trim()}`);
		return "";
	};
	const secret = async (q: string) => {
		hidden.push(q);
		return next(q);
	};
	return { print: (m = "") => void printed.push(m), ask: next, secret, printed, asked, hidden, queue };
}

const json = (v: unknown) => ({ code: 0, stdout: `banner\n${JSON.stringify(v)}` });

/**
 * GitHub and Cloudflare's API. `workers` exist in the account; `bindings` maps
 * a Worker to the KV namespace ids it binds (those Workers exist too).
 */
const fakeFetch = (opts: { subdomain?: string | null; workers?: string[]; workersUnknown?: boolean; bindings?: Record<string, string[]> } = {}) => {
	const all = [...new Set([...(opts.workers ?? []), ...Object.keys(opts.bindings ?? {})])];
	const seen: { url: string; headers: Record<string, string> }[] = [];
	const fetch = async (url: string, init: { headers: Record<string, string> }) => {
		seen.push({ url, headers: init.headers });
		if (url === "https://api.github.com/users/octo-cat") return Response.json({ id: 583231, login: "octo-cat" });
		if (url.startsWith("https://api.github.com/users/")) return new Response("{}", { status: 404 });
		if (url === `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT.id}/workers/subdomain`) {
			if (opts.subdomain === null) return new Response("{}", { status: 403 });
			return Response.json({ success: true, result: { subdomain: opts.subdomain ?? "alice" } });
		}
		if (url === `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT.id}/workers/scripts`) {
			if (opts.workersUnknown) return new Response("{}", { status: 403 });
			return Response.json({ success: true, result: all.map((id) => ({ id })) });
		}
		const script = url.match(/\/accounts\/[0-9a-f]+\/workers\/scripts\/([^/]+)\/settings$/);
		if (script) {
			if (opts.workersUnknown) return new Response("{}", { status: 403 });
			const name = decodeURIComponent(script[1]!);
			if (!all.includes(name)) return Response.json({ success: false }, { status: 404 });
			const bindings = (opts.bindings?.[name] ?? []).map((id) => ({ type: "kv_namespace", name: "OAUTH_KV", namespace_id: id }));
			return Response.json({ success: true, result: { bindings: [{ type: "plain_text", name: "X", text: "y" }, ...bindings] } });
		}
		return new Response("unexpected", { status: 500 });
	};
	return { fetch, seen };
};

/** Handlers for a logged-in account with nothing set up yet. */
function freshHandlers(extra: Record<string, Handler | Result> = {}) {
	let loggedIn = false;
	return {
		"wrangler --version": { code: 0, stdout: " ⛅️ wrangler 4.158.0\n4.158.0" },
		"wrangler whoami --json": () => (loggedIn ? json({ loggedIn: true, email: "me@example.com", accounts: [ACCOUNT] }) : { code: 1, stdout: '{"loggedIn":false}' }),
		"wrangler login": () => ((loggedIn = true), { code: 0 }),
		"wrangler kv namespace list": json([]),
		"wrangler kv namespace create": { code: 0, stdout: `Success!\n{\n  "kv_namespaces": [\n    {\n      "binding": "OAUTH_KV",\n      "id": "${KV_ID}"\n    }\n  ]\n}` },
		"wrangler auth token --json": json({ type: "oauth", token: CF_TOKEN }),
		"wrangler secret list": { code: 1, stderr: 'Worker "garmin-cloud-mcp" not found.' },
		"wrangler secret bulk": { code: 0, stdout: "✨ Success! Uploaded 4 secrets" },
		"wrangler deploy": { code: 0 },
		...extra,
	};
}

describe("npm run setup", () => {
	it("sets everything up from scratch, without ever showing or passing a secret as an argument", async () => {
		const w = world(freshHandlers());
		const f = fakeFetch();
		const term = io(["", "octo-cat", "", GH_ID, GH_SECRET, GARMIN_KEY]);
		const url = await runSetup({ run: w.run, io: term, files: w.files, fetch: f.fetch, nodeVersion: "22.12.0", randomHex: () => "c".repeat(64) });

		assert.equal(url, "https://garmin-cloud-mcp.alice.workers.dev/mcp");
		const config = w.store.get("wrangler.jsonc")!;
		assert.equal(readKvId(config), KV_ID);
		assert.equal(readValue(config, "ALLOWED_GITHUB_USER_ID"), "583231");
		assert.equal(readValue(config, "account_id"), undefined, "one account: nothing to pin");
		assert.ok(config.includes("// Optional. The public URL"), "comments kept");

		const out = term.printed.join("\n");
		assert.match(out, /https:\/\/github\.com\/settings\/applications\/new/);
		assert.match(out, /Homepage URL: +https:\/\/garmin-cloud-mcp\.alice\.workers\.dev\n/);
		assert.match(out, /Authorization callback URL: https:\/\/garmin-cloud-mcp\.alice\.workers\.dev\/callback/);
		assert.match(out, /connect\.garmin\.com\/app\/settings\/personalApiToken/);
		assert.match(out, /https:\/\/garmin-cloud-mcp\.alice\.workers\.dev\/mcp/);

		const bulk = w.calls.find((c) => c.args.includes("bulk"))!;
		assert.deepEqual(JSON.parse(bulk.input!), {
			GITHUB_CLIENT_ID: GH_ID,
			GITHUB_CLIENT_SECRET: GH_SECRET,
			GARMIN_API_KEY: GARMIN_KEY,
			COOKIE_ENCRYPTION_KEY: "c".repeat(64),
		});
		for (const secret of [GH_SECRET, GARMIN_KEY, "c".repeat(64), CF_TOKEN]) {
			assert.ok(!out.includes(secret), "secret printed");
			assert.ok(!w.calls.some((c) => c.args.join(" ").includes(secret)), "secret in a command line");
			assert.ok(![...w.store.values()].some((t) => t.includes(secret)), "secret written to a file");
		}
		// The Cloudflare token went only to Cloudflare's API.
		assert.equal(f.seen.find((s) => s.url.includes("cloudflare"))!.headers.Authorization, `Bearer ${CF_TOKEN}`);
		assert.ok(w.calls.some((c) => c.args.includes("login") && c.inherit), "login runs interactively");
		assert.ok(w.calls.at(-1)!.args.includes("deploy") && w.calls.at(-1)!.inherit, "deploys last");
	});

	it("is safe to rerun: skips what's done and asks before replacing secrets", async () => {
		const done = EXAMPLE.replace("YOUR_KV_NAMESPACE_ID", KV_ID).replace('"ALLOWED_GITHUB_USER_ID": "0"', '"ALLOWED_GITHUB_USER_ID": "583231"');
		const w = world(
			freshHandlers({
				"wrangler whoami --json": json({ loggedIn: true, accounts: [ACCOUNT] }),
				"wrangler secret list": json(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "COOKIE_ENCRYPTION_KEY", "GARMIN_API_KEY"].map((name) => ({ name, type: "secret_text" }))),
			}),
			{ "wrangler.jsonc": done },
		);
		const term = io([]); // Enter at every prompt: keep everything, don't replace secrets.
		await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch().fetch, nodeVersion: "24.0.0" });
		assert.equal(w.store.get("wrangler.jsonc"), done, "file untouched");
		assert.ok(!w.calls.some((c) => c.args.includes("namespace") || c.args.includes("bulk") || c.args.includes("login")));
		assert.deepEqual(
			term.asked.map((q) => q.trim()),
			[
				"Keep these? [Y/n]",
				"Your GitHub OAuth app's ID and secret are already stored. Replace them? [y/N]",
				"A Garmin key is already stored. Replace it? [y/N]",
			],
		);
		const out = term.printed.join("\n");
		assert.match(out, /From your last run:\n {5}Worker name {5}garmin-cloud-mcp\n {5}KV namespace {4}0123456789abcdef0123456789abcdef\n {5}GitHub user ID {2}583231/);
		assert.doesNotMatch(out, /\n4\. |\n5\. /, "steps 4 and 5 aren't shown one by one");
		assert.ok(w.calls.some((c) => c.args.includes("deploy")));
	});

	it("asks for the subdomain when Cloudflare's API can't give it, and rejects unknown GitHub users", async () => {
		const w = world(freshHandlers({ "wrangler whoami --json": json({ loggedIn: true, accounts: [ACCOUNT] }) }));
		const term = io(["", "no-such-user", "octo-cat", "", "bob", GH_ID, GH_SECRET, GARMIN_KEY]);
		const url = await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch({ subdomain: null }).fetch, nodeVersion: "22.0.0" });
		assert.equal(url, "https://garmin-cloud-mcp.bob.workers.dev/mcp");
		assert.ok(term.printed.some((p) => /no user called "no-such-user"/.test(p)));
		assert.ok(term.printed.some((p) => /Couldn't look up your workers.dev subdomain/.test(p)));
	});

	it("asks for the Worker name, saves it and builds the URL from it", async () => {
		const w = world(freshHandlers({ "wrangler whoami --json": json({ loggedIn: true, accounts: [ACCOUNT] }) }));
		const term = io(["Bad_Name", "my-garmin", "octo-cat", "", GH_ID, GH_SECRET, GARMIN_KEY]);
		const url = await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch().fetch, nodeVersion: "22.0.0" });
		assert.equal(url, "https://my-garmin.alice.workers.dev/mcp");
		assert.equal(readValue(w.store.get("wrangler.jsonc")!, "name"), "my-garmin");
		assert.equal(readValue(w.store.get("wrangler.jsonc")!, "binding"), "OAUTH_KV", "only the Worker's name changed");
		assert.ok(term.printed.some((p) => /lowercase letters, digits and dashes/.test(p)));
		assert.ok(term.printed.some((p) => p.includes("Authorization callback URL: https://my-garmin.alice.workers.dev/callback")));
	});

	it("warns when a Worker with that name already exists, and asks before replacing it", async () => {
		const handlers = () => freshHandlers({ "wrangler whoami --json": json({ loggedIn: true, accounts: [ACCOUNT] }) });
		const f = fakeFetch({ workers: ["garmin-cloud-mcp"] });

		// Decline, then pick a free name.
		const w = world(handlers());
		const term = io(["", "", "garmin-2", "octo-cat", "", GH_ID, GH_SECRET, GARMIN_KEY]);
		const url = await runSetup({ run: w.run, io: term, files: w.files, fetch: f.fetch, nodeVersion: "22.0.0" });
		assert.ok(term.printed.some((p) => /already has a Worker called "garmin-cloud-mcp".*replace/.test(p)));
		assert.ok(term.asked.some((q) => q.includes("Replace it? [y/N]")));
		assert.equal(url, "https://garmin-2.alice.workers.dev/mcp");

		// Confirm: keeps the name.
		const w2 = world(handlers());
		const url2 = await runSetup({ run: w2.run, io: io(["", "y", "octo-cat", "", GH_ID, GH_SECRET, GARMIN_KEY]), files: w2.files, fetch: f.fetch, nodeVersion: "22.0.0" });
		assert.equal(url2, "https://garmin-cloud-mcp.alice.workers.dev/mcp");

		// Can't tell: says so and carries on.
		const w3 = world(handlers());
		const t3 = io(["", "octo-cat", "", GH_ID, GH_SECRET, GARMIN_KEY]);
		await runSetup({ run: w3.run, io: t3, files: w3.files, fetch: fakeFetch({ workersUnknown: true }).fetch, nodeVersion: "22.0.0" });
		assert.ok(t3.printed.some((p) => /Couldn't check whether a Worker called "garmin-cloud-mcp" already exists/.test(p)));
	});

	it("doesn't warn on a rerun about the Worker it set up itself", async () => {
		const done = EXAMPLE.replace("YOUR_KV_NAMESPACE_ID", KV_ID).replace('"ALLOWED_GITHUB_USER_ID": "0"', '"ALLOWED_GITHUB_USER_ID": "583231"');
		const w = world(freshHandlers({ "wrangler whoami --json": json({ loggedIn: true, accounts: [ACCOUNT] }) }), { "wrangler.jsonc": done });
		// Say no to "Keep these?": the name is asked again, and keeping it doesn't warn.
		const term = io(["n", "", "", "", GH_ID, GH_SECRET, GARMIN_KEY]);
		await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch({ workers: ["garmin-cloud-mcp"] }).fetch, nodeVersion: "22.0.0" });
		assert.ok(!term.printed.some((p) => /already has a Worker/.test(p)));
		assert.ok(term.asked.some((q) => q.includes("Keep the KV namespace 0123456789abcdef0123456789abcdef? [Y/n]")));
		assert.ok(term.asked.some((q) => q.includes("Keep GitHub user ID 583231? [Y/n]")));
	});

	it("adds workers_dev and preview_urls to an older wrangler.jsonc without asking", async () => {
		const older = EXAMPLE.replace(/\t\/\/ Serve the Worker.*\n\t"workers_dev": true,\n\t\/\/ No extra public.*\n\t"preview_urls": false,\n/, "")
			.replace("YOUR_KV_NAMESPACE_ID", KV_ID)
			.replace('"ALLOWED_GITHUB_USER_ID": "0"', '"ALLOWED_GITHUB_USER_ID": "583231"');
		assert.ok(!older.includes("workers_dev"), "fixture lacks them");
		const w = world(freshHandlers({ "wrangler whoami --json": json({ loggedIn: true, accounts: [ACCOUNT] }) }), { "wrangler.jsonc": older });
		const term = io(["", GH_ID, GH_SECRET, GARMIN_KEY]);
		await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch().fetch, nodeVersion: "22.0.0" });
		const config = w.store.get("wrangler.jsonc")!;
		assert.match(config, /"workers_dev": true,/);
		assert.match(config, /"preview_urls": false,/);
		assert.ok(term.printed.some((p) => p.includes('Added "workers_dev": true and "preview_urls": false to wrangler.jsonc.')));
		assert.deepEqual(missingSettings(EXAMPLE, config), [], "now matches the example");
	});

	it("pins the account when the login has several", async () => {
		const other = { id: "b".repeat(32), name: "Work" };
		const w = world(freshHandlers({ "wrangler whoami --json": json({ loggedIn: true, accounts: [other, ACCOUNT] }) }));
		const term = io(["2", "", "octo-cat", "", GH_ID, GH_SECRET, GARMIN_KEY]);
		await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch().fetch, nodeVersion: "22.0.0" });
		assert.equal(readValue(w.store.get("wrangler.jsonc")!, "account_id"), ACCOUNT.id);
	});

	it("uses the MCP_RESOURCE override's host for the OAuth app URLs", async () => {
		const custom = EXAMPLE.replace('// "MCP_RESOURCE": "https://garmin.example.com/mcp",', '"MCP_RESOURCE": "https://garmin.example.com/mcp",');
		const w = world(freshHandlers({ "wrangler whoami --json": json({ loggedIn: true, accounts: [ACCOUNT] }) }), { "wrangler.jsonc": custom });
		const term = io(["", "octo-cat", "", GH_ID, GH_SECRET, GARMIN_KEY]);
		const url = await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch().fetch, nodeVersion: "22.0.0" });
		assert.equal(url, "https://garmin.example.com/mcp");
		assert.ok(term.printed.some((p) => p.includes("Authorization callback URL: https://garmin.example.com/callback")));
	});

	it("says which step failed and how to retry", async () => {
		const w = world(freshHandlers({
			"wrangler whoami --json": json({ loggedIn: true, accounts: [ACCOUNT] }),
			"wrangler kv namespace create": { code: 1, stderr: "You have reached the limit of namespaces" },
		}));
		await assert.rejects(
			runSetup({ run: w.run, io: io([]), files: w.files, fetch: fakeFetch().fetch, nodeVersion: "22.0.0" }),
			(err: any) =>
				err.step === "KV namespace" &&
				/limit of namespaces/.test(err.message) &&
				err.num === 4 &&
				err.hint.includes("npx wrangler kv namespace create garmin-cloud-mcp-OAUTH_KV,") &&
				/npm run setup again/.test(err.hint) &&
				describeFailure(err).startsWith("\nStep 4 (KV namespace) failed: couldn't create the KV namespace \"garmin-cloud-mcp-OAUTH_KV\": You have reached the limit of namespaces\nTo fix it: run npx wrangler kv namespace create garmin-cloud-mcp-OAUTH_KV,"),
		);
		await assert.rejects(
			runSetup({ run: w.run, io: io([]), files: w.files, fetch: fakeFetch().fetch, nodeVersion: "20.11.0" }),
			(err: any) => err.step === "Node version" && /Node 22/.test(err.hint),
		);
		const noWrangler = world({ "wrangler --version": { code: 1, stderr: "npm ERR! canceled" } });
		await assert.rejects(
			runSetup({ run: noWrangler.run, io: io([]), files: noWrangler.files, fetch: fakeFetch().fetch, nodeVersion: "22.0.0" }),
			(err: any) => err.step === "wrangler" && /npm install/.test(err.hint),
		);
	});

	describe("KV namespace", () => {
		const OTHER_ID = "f".repeat(32);
		const whoami = { "wrangler whoami --json": json({ loggedIn: true, accounts: [ACCOUNT] }) };
		const listing = (...titles: [string, string][]) => ({ "wrangler kv namespace list": json(titles.map(([title, id]) => ({ title, id }))) });
		const answersAfterKv = ["octo-cat", "", GH_ID, GH_SECRET, GARMIN_KEY];
		const created = (w: ReturnType<typeof world>) => w.calls.filter((c) => c.args.includes("create")).map((c) => c.args.at(-1));

		it("creates '<worker>-OAUTH_KV' by default and leaves a plain 'OAUTH_KV' (another Worker's) alone", async () => {
			// The reported case: the account's live Worker already owns "OAUTH_KV".
			const w = world(freshHandlers({ ...whoami, ...listing(["OAUTH_KV", OTHER_ID]) }));
			const term = io(["my-garmin", ...answersAfterKv]);
			await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch({ bindings: { "garmin-mcp-cloud": [OTHER_ID] } }).fetch, nodeVersion: "22.0.0" });
			assert.deepEqual(created(w), ["my-garmin-OAUTH_KV"]);
			assert.ok(!term.asked.some((q) => /Use it/.test(q)), "never offered");
			assert.ok(term.printed.some((p) => p.includes('Found "OAUTH_KV", which probably belongs to another Worker; leaving it alone.')));
			const config = w.store.get("wrangler.jsonc")!;
			assert.equal(readKvId(config), KV_ID);
			assert.notEqual(readKvId(config), OTHER_ID);
			assert.match(config, /"binding": "OAUTH_KV"/, "the binding name is unchanged");
		});

		it("on a rerun, offers the namespace titled after this Worker (an earlier run made it but didn't save it): default yes", async () => {
			const half = EXAMPLE.replace('"name": "garmin-cloud-mcp"', '"name": "garmin-mcp-cloud"');
			const w = world(freshHandlers({ ...whoami, ...listing(["OAUTH_KV", OTHER_ID], ["garmin-mcp-cloud-OAUTH_KV", KV_ID]) }), { "wrangler.jsonc": half });
			const term = io(["", "", ...answersAfterKv]); // name, use it
			await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch({ workers: ["unrelated"] }).fetch, nodeVersion: "22.0.0" });
			assert.deepEqual(created(w), [], "nothing created");
			assert.equal(readKvId(w.store.get("wrangler.jsonc")!), KV_ID);
			assert.ok(term.printed.some((p) => p.includes('Found "garmin-mcp-cloud-OAUTH_KV" (not used by any Worker yet, probably from an earlier run).')));
			assert.ok(term.asked.some((q) => q.includes("Use it for this Worker? [Y/n]")));
		});

		it("defaults to yes when this same Worker already uses it", async () => {
			const w = world(freshHandlers({ ...whoami, ...listing(["garmin-cloud-mcp-OAUTH_KV", KV_ID]) }));
			const term = io(["", "y", "", ...answersAfterKv]); // name, replace the existing Worker, use it
			await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch({ bindings: { "garmin-cloud-mcp": [KV_ID] } }).fetch, nodeVersion: "22.0.0" });
			assert.ok(term.printed.some((p) => p.includes('Found "garmin-cloud-mcp-OAUTH_KV" (used by garmin-cloud-mcp).')));
			assert.ok(term.asked.some((q) => q.includes("Use it for this Worker? [Y/n]")));
			assert.equal(readKvId(w.store.get("wrangler.jsonc")!), KV_ID);
		});

		it("names the other Worker using a matching title, defaults to no, and prints a command that works", async () => {
			const w = world(freshHandlers({ ...whoami, ...listing(["garmin-cloud-mcp-OAUTH_KV", KV_ID]) }));
			const term = io(["", ""]); // default name, then Enter at "Use it?" (= no)
			await assert.rejects(
				runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch({ bindings: { "old-garmin": [KV_ID] } }).fetch, nodeVersion: "22.0.0" }),
				(err: any) =>
					err.num === 4 &&
					err.hint.includes("choose a different Worker name") &&
					err.hint.includes("npx wrangler kv namespace create garmin-cloud-mcp-OAUTH_KV-2,"),
			);
			assert.ok(term.printed.some((p) => p.includes('It probably belongs to "old-garmin"; sharing it would mix their sign-ins')));
			assert.ok(term.asked.some((q) => q.includes("Use it for this Worker? [y/N]")));
			assert.equal(readKvId(w.store.get("wrangler.jsonc")!), "YOUR_KV_NAMESPACE_ID", "config untouched");
		});

		it("when creation fails because the title appeared meanwhile, suggests a title that doesn't exist", async () => {
			const w = world(freshHandlers({
				...whoami,
				"wrangler kv namespace create": { code: 1, stderr: 'X [ERROR] A KV namespace with the title "garmin-cloud-mcp-OAUTH_KV" already exists.' },
			}));
			await assert.rejects(
				runSetup({ run: w.run, io: io([""]), files: w.files, fetch: fakeFetch().fetch, nodeVersion: "22.0.0" }),
				(err: any) => /already exists/.test(err.message) && err.hint.includes("npx wrangler kv namespace create garmin-cloud-mcp-OAUTH_KV-2,"),
			);
		});

		it("still offers a matching one, default yes, when Cloudflare's API can't say who uses it", async () => {
			const w = world(freshHandlers({ ...whoami, ...listing(["garmin-cloud-mcp-OAUTH_KV", KV_ID]) }));
			const term = io(["", "", ...answersAfterKv]);
			await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch({ workersUnknown: true }).fetch, nodeVersion: "22.0.0" });
			assert.ok(term.printed.some((p) => p.includes("couldn't check which Worker uses it")));
			assert.equal(readKvId(w.store.get("wrangler.jsonc")!), KV_ID);
		});
	});

	describe("hidden prompts", () => {
		it("labels both hidden prompts clearly, and confirms each answer by length only", async () => {
			const w = world(freshHandlers({ "wrangler whoami --json": json({ loggedIn: true, accounts: [ACCOUNT] }) }));
			const term = io(["", "octo-cat", "", GH_ID, "", "too-short", GH_SECRET, "has a space", GARMIN_KEY]);
			await runSetup({ run: w.run, io: term, files: w.files, fetch: fakeFetch().fetch, nodeVersion: "22.0.0" });
			assert.deepEqual(term.hidden.map((h) => h.trim()), [
				"Client secret (paste it; nothing will show as you type):",
				"Client secret (paste it; nothing will show as you type):",
				"Client secret (paste it; nothing will show as you type):",
				"Garmin key (paste it; nothing will show as you type):",
				"Garmin key (paste it; nothing will show as you type):",
			]);
			const out = term.printed.join("\n");
			assert.match(out, /Nothing was entered\. A GitHub client secret is 40 letters and numbers/);
			assert.match(out, /\n {5}A GitHub client secret is 40 letters and numbers \(0-9 and a-f\)/);
			assert.match(out, /A Garmin key is one long string with no spaces/);
			assert.match(out, /✓ received \(40 characters\)/);
			assert.match(out, new RegExp(`✓ received \\(${GARMIN_KEY.length} characters\\)`));
			assert.match(out, /The secret appears once, in a green box/);
			assert.match(out, /The client ID isn't secret; the client secret is\./);
			assert.match(out, /reuse a key you already have \(e\.g\. from a local setup\), or create a new one/);
			assert.match(out, /Garmin shows a new key only once\./);
			assert.ok(!out.includes(GH_SECRET) && !out.includes(GARMIN_KEY));
		});

		it("makeIO writes the label to the terminal before muting input, and never echoes the answer", async () => {
			const input = new PassThrough();
			let shown = "";
			const output = new Writable({
				write(chunk, _enc, cb) {
					shown += chunk;
					trace.push(`out:${chunk}`);
					cb();
				},
			});
			const trace: string[] = [];
			const term = makeIO({ input, output, trace });
			const label = "   Client secret (paste it; nothing will show as you type): ";
			const answer = askValid(term, label, () => true, { secret: true });
			setImmediate(() => input.write("s3cret-value\n"));
			assert.equal(await answer, "s3cret-value");
			// The label reached the terminal, and was recorded, before input was muted.
			assert.ok(trace.indexOf(`out:${label}`) >= 0 && trace.indexOf(`out:${label}`) < trace.indexOf("muted"), trace.join(" | "));
			assert.ok(trace.indexOf(`label:${label}`) < trace.indexOf("muted"));
			assert.equal(shown, `${label}\n     ✓ received (12 characters)\n`);
			assert.ok(!shown.includes("s3cret"));
		});

		it("makeIO shows ordinary questions and reads the answer", async () => {
			const input = new PassThrough();
			let shown = "";
			const output = new Writable({ write: (c, _e, cb) => ((shown += c), cb()) });
			const term = makeIO({ input, output });
			const answer = term.ask("Your GitHub username: ");
			setImmediate(() => input.write("  octo-cat \n"));
			assert.equal(await answer, "octo-cat");
			assert.ok(shown.startsWith("Your GitHub username: "));
		});
	});
});

describe("npm run update", () => {
	const pkg = (v: string) => JSON.stringify({ name: "garmin-mcp", version: v });
	const userConfig = EXAMPLE.replace("YOUR_KV_NAMESPACE_ID", KV_ID);

	function updateWorld(extra: Record<string, Handler | Result> = {}, files: Record<string, string> = {}) {
		let w: ReturnType<typeof world>;
		let commit = "aaa111";
		w = world(
			{
				"git remote get-url origin": { code: 0, stdout: "https://github.com/colincooperio/garmin-mcp.git\n" },
				"git status --porcelain --untracked-files=no": { code: 0, stdout: "" },
				"git rev-parse HEAD": () => ({ code: 0, stdout: `${commit}\n` }),
				"git pull --ff-only": () => (w.store.set("package.json", pkg("1.4.0")), (commit = "bbb222"), { code: 0 }),
				"npm ci": { code: 0 },
				"npm run check": { code: 0 },
				"wrangler deploy": { code: 0 },
				...extra,
			},
			{ "package.json": pkg("1.3.0"), "wrangler.jsonc": userConfig, ...files },
		);
		return w;
	}

	it("offers to move the remote, pulls, installs, checks, deploys and prints both versions", async () => {
		const w = updateWorld({ "git remote get-url origin": { code: 0, stdout: "git@github.com:cacooper16/garmin-cloud-mcp.git\n" }, "git remote set-url": { code: 0 } });
		const term = io([""]);
		assert.deepEqual(await runUpdate({ run: w.run, io: term, files: w.files }), { from: "1.3.0", to: "1.4.0" });
		assert.deepEqual(
			w.calls.map((c) => (c.cmd === "npx" && c.args[0] === "--no" ? c.args.slice(2) : [c.cmd, ...c.args]).join(" ")),
			[
				"git remote get-url origin",
				`git remote set-url origin ${NEW_REMOTE}`,
				"git status --porcelain --untracked-files=no",
				"git rev-parse HEAD",
				"git pull --ff-only",
				"npm ci",
				"git rev-parse HEAD",
				"npm run check",
				"wrangler deploy",
			],
		);
		assert.ok(term.printed.some((p) => p.includes("Updated: 1.3.0 -> 1.4.0")));
		assert.ok(term.printed.some((p) => p.includes("npx wrangler rollback")));
		assert.equal(w.store.get("wrangler.jsonc"), userConfig, "never edits wrangler.jsonc");
	});

	it("says it's already up to date when the pull brought nothing, and still redeploys", async () => {
		const w = updateWorld({ "git pull --ff-only": { code: 0 } }, { "package.json": pkg("1.4.0") });
		const term = io([]);
		assert.deepEqual(await runUpdate({ run: w.run, io: term, files: w.files }), { from: "1.4.0", to: "1.4.0" });
		const out = term.printed.join("\n");
		assert.match(out, /Already up to date: redeployed 1\.4\.0\./);
		assert.doesNotMatch(out, /Updated:/);
		assert.match(out, /npx wrangler rollback/);
		assert.ok(w.calls.some((c) => c.args.includes("deploy")));
	});

	it("says Updated when the pull brought commits but the version is the same", async () => {
		const w = updateWorld({}, { "package.json": pkg("1.4.0") });
		const term = io([]);
		await runUpdate({ run: w.run, io: term, files: w.files });
		assert.match(term.printed.join("\n"), /Updated: 1\.4\.0 -> 1\.4\.0\./);
	});

	it("refuses to continue with uncommitted changes to tracked files", async () => {
		const w = updateWorld({ "git status --porcelain --untracked-files=no": { code: 0, stdout: " M src/tools.ts\n" } });
		await assert.rejects(runUpdate({ run: w.run, io: io([]), files: w.files }), (err: any) => err.step === "local changes" && /src\/tools\.ts/.test(err.message) && /git stash/.test(err.hint));
		assert.ok(!w.calls.some((c) => c.args.includes("pull")), "nothing pulled");
	});

	it("lists settings missing from wrangler.jsonc, and stops before deploying if a required one is missing and you say so", async () => {
		const old = userConfig.replace('"global_fetch_strictly_public",', "").replace(/\t"observability": \{\n\t\t"enabled": true,\n\t\},\n/, "");
		const w = updateWorld({}, { "wrangler.jsonc": old });
		const term = io([""]); // default: don't deploy
		await assert.rejects(runUpdate({ run: w.run, io: term, files: w.files }), (err: any) => err.step === "settings" && /nothing was changed/.test(err.message));
		const out = term.printed.join("\n");
		assert.match(out, /compatibility flag "global_fetch_strictly_public": required/);
		assert.match(out, /top-level setting "observability": optional/);
		assert.ok(!w.calls.some((c) => c.args.includes("deploy")));
		assert.equal(w.store.get("wrangler.jsonc"), old);
	});

	it("lists workers_dev and preview_urls as new optional settings, and still deploys", async () => {
		const old = userConfig.replace(/\t\/\/ Serve the Worker.*\n\t"workers_dev": true,\n\t\/\/ No extra public.*\n\t"preview_urls": false,\n/, "");
		const w = updateWorld({}, { "wrangler.jsonc": old });
		const term = io([]);
		await runUpdate({ run: w.run, io: term, files: w.files });
		const out = term.printed.join("\n");
		assert.match(out, /top-level setting "workers_dev": optional/);
		assert.match(out, /top-level setting "preview_urls": optional/);
		assert.deepEqual(term.asked, [], "optional settings don't stop the update");
		assert.ok(w.calls.some((c) => c.args.includes("deploy")));
		assert.equal(w.store.get("wrangler.jsonc"), old, "never edits wrangler.jsonc");
	});

	it("explains how to roll back when the deploy fails", async () => {
		const w = updateWorld({ "wrangler deploy": { code: 1 } });
		await assert.rejects(runUpdate({ run: w.run, io: io([]), files: w.files }), (err: any) => {
			assert.match(describeFailure(err), /^\nStep 6 \(deploy\) failed: wrangler deploy failed .*\nTo fix it: run npx wrangler rollback/s);
			return true;
		});
	});

	it("doesn't deploy when the tests fail", async () => {
		const w = updateWorld({ "npm run check": { code: 1 } });
		await assert.rejects(runUpdate({ run: w.run, io: io([]), files: w.files }), (err: any) => err.step === "tests" && /Nothing was deployed/.test(err.message));
		assert.ok(!w.calls.some((c) => c.args.includes("deploy")));
	});
});

describe("missingSettings", () => {
	it("treats an older config that still sets MCP_RESOURCE as complete", () => {
		const older = EXAMPLE.replace('"vars": {', '"vars": {\n\t\t"MCP_RESOURCE": "https://x.workers.dev/mcp",');
		assert.deepEqual(missingSettings(EXAMPLE, older), []);
	});

	it("flags an older compatibility_date as optional", () => {
		const older = EXAMPLE.replace(/"compatibility_date": "[^"]+"/, '"compatibility_date": "2025-01-01"');
		const [m] = missingSettings(EXAMPLE, older);
		assert.equal(m!.required, false);
		assert.match(m!.what, /yours is 2025-01-01/);
	});
});
