// Shared by scripts/setup.mjs and scripts/update.mjs. Plain Node, no
// dependencies. Everything that touches the outside world (commands, prompts,
// files, HTTP) comes in through a context object, so the logic can be tested
// with fakes (test/setup.test.ts).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export const CONFIG = "wrangler.jsonc";
export const EXAMPLE = "wrangler.example.jsonc";
export const KV_PLACEHOLDER = "YOUR_KV_NAMESPACE_ID";
export const GARMIN_KEY_PAGE = "https://connect.garmin.com/app/settings/personalApiToken";
export const NEW_OAUTH_APP = "https://github.com/settings/applications/new";

/** A failed step: which one (number and name), what went wrong, and the one thing that fixes it. */
export class StepError extends Error {
	constructor(step, message, hint, num) {
		super(message);
		this.name = "StepError";
		this.step = step;
		this.hint = hint;
		this.num = num;
	}
}

/** How a StepError is shown: the step, what went wrong, and what to do. */
export function describeFailure(err) {
	return `\nStep ${err.num ? `${err.num} ` : ""}(${err.step}) failed: ${err.message}\nTo fix it: ${err.hint}`;
}

// ---- real implementations ---------------------------------------------------

/**
 * Runs a command. `inherit` hands the terminal over (for interactive commands
 * such as wrangler login and deploy); otherwise output is captured. `input` is
 * written to stdin, so secrets never appear in arguments.
 */
export function makeRunner(cwd) {
	return (cmd, args, opts = {}) =>
		new Promise((resolve) => {
			const child = spawn(cmd, args, {
				cwd,
				// npm and npx are .cmd scripts on Windows.
				shell: process.platform === "win32",
				stdio: opts.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
				env: { ...process.env, ...opts.env },
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (d) => (stdout += d));
			child.stderr?.on("data", (d) => (stderr += d));
			if (!opts.inherit) child.stdin.end(opts.input ?? "");
			child.on("error", (err) => resolve({ code: 127, stdout, stderr: stderr + String(err.message) }));
			child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
		});
}

/** A stream that discards everything: hidden input is "echoed" here. */
const discard = () => new Writable({ write: (_chunk, _enc, cb) => cb() });

/**
 * Terminal prompts. Each question gets its own readline interface, closed
 * straight after, so nothing is left listening to stdin between questions.
 *
 * `secret` writes its label to the terminal first, and only then reads the
 * answer through an interface whose output is discarded. So the label stays
 * on screen (readline can't redraw over it) and nothing typed or pasted is
 * shown. `trace`, when given, records the order of those two events (tests).
 */
export function makeIO({ input = process.stdin, output = process.stdout, trace } = {}) {
	const read = async (question, out) => {
		const rl = createInterface({ input, output: out, terminal: Boolean(input.isTTY) });
		rl.on("SIGINT", () => {
			rl.close();
			output.write("\n");
			process.exit(130);
		});
		try {
			return (await rl.question(question)).trim();
		} finally {
			rl.close();
		}
	};
	return {
		print: (msg = "") => output.write(`${msg}\n`),
		ask: (question) => read(question, output),
		async secret(label) {
			output.write(label);
			trace?.push(`label:${label}`);
			trace?.push("muted");
			try {
				return await read("", discard());
			} finally {
				output.write("\n");
			}
		},
		close: () => {},
	};
}

export function makeFiles(cwd) {
	return {
		exists: (f) => existsSync(join(cwd, f)),
		read: (f) => readFileSync(join(cwd, f), "utf8"),
		write: (f, text) => writeFileSync(join(cwd, f), text),
	};
}

// ---- prompts ------------------------------------------------------------------

/** Yes/no with a default; Enter takes the default. */
export async function confirm(io, question, def = true) {
	for (;;) {
		const a = (await io.ask(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
		if (!a) return def;
		if (["y", "yes"].includes(a)) return true;
		if (["n", "no"].includes(a)) return false;
	}
}

/** Asks until the answer passes `valid` (a message string means invalid). */
/**
 * Asks until `valid` returns true; otherwise it returns what was expected,
 * which is shown before asking again. A hidden answer is confirmed by its
 * length only, never shown.
 */
export async function askValid(io, question, valid, { secret = false } = {}) {
	for (;;) {
		const a = secret ? await io.secret(question) : await io.ask(question);
		const problem = valid(a);
		if (problem === true || problem === undefined) {
			if (secret) io.print(`     ✓ received (${a.length} characters)`);
			return a;
		}
		io.print(`     ${secret && !a ? "Nothing was entered. " : ""}${problem}`);
	}
}

// ---- wrangler -----------------------------------------------------------------

/** Runs the project's wrangler (node_modules/.bin via npx). */
export const wrangler = (ctx, args, opts) => ctx.run("npx", ["--no", "--", "wrangler", ...args], opts);

export function parseJson(text) {
	// wrangler can print a banner or warnings before the JSON.
	const start = text.search(/[[{]/);
	if (start < 0) return undefined;
	try {
		return JSON.parse(text.slice(start));
	} catch {
		return undefined;
	}
}

/** The id from `wrangler kv namespace create` output (TOML, JSON or jsonc style). */
export function parseKvId(output) {
	return output.match(/\bid\b"?\s*[:=]\s*"([0-9a-f]{32})"/i)?.[1];
}

// ---- wrangler.jsonc editing ---------------------------------------------------
// Line-based on purpose: it keeps the user's comments and layout. Commented-out
// lines are never read or changed.

const isComment = (line) => line.trim().startsWith("//");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The string value of `"key": "value"` on the first uncommented line that has it. */
export function readValue(text, key) {
	const re = new RegExp(`"${esc(key)}"\\s*:\\s*"([^"]*)"`);
	for (const line of text.split("\n")) {
		if (isComment(line)) continue;
		const m = line.match(re);
		if (m) return m[1];
	}
	return undefined;
}

/** Replaces `"key": "..."` on the first uncommented line that has it; undefined if absent. */
export function replaceValue(text, key, value) {
	const re = new RegExp(`("${esc(key)}"\\s*:\\s*)"[^"]*"`);
	const lines = text.split("\n");
	const i = lines.findIndex((l) => !isComment(l) && re.test(l));
	if (i < 0) return undefined;
	lines[i] = lines[i].replace(re, (_, pre) => `${pre}${JSON.stringify(value)}`);
	return lines.join("\n");
}

/** Sets a var in "vars", adding it if missing. */
export function setVar(text, key, value) {
	const replaced = replaceValue(text, key, value);
	if (replaced !== undefined) return replaced;
	const lines = text.split("\n");
	const i = lines.findIndex((l) => !isComment(l) && /"vars"\s*:\s*\{/.test(l));
	if (i < 0) throw new Error(`no "vars" block in ${CONFIG}`);
	const indent = (lines[i].match(/^\s*/)?.[0] ?? "") + "\t";
	lines.splice(i + 1, 0, `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)},`);
	return lines.join("\n");
}

/** The OAUTH_KV binding's id. */
export function readKvId(text) {
	const m = stripComments(text).match(/"binding"\s*:\s*"OAUTH_KV"[^}]*?"id"\s*:\s*"([^"]*)"|"id"\s*:\s*"([^"]*)"[^}]*?"binding"\s*:\s*"OAUTH_KV"/);
	return m?.[1] ?? m?.[2];
}

export function setKvId(text, id) {
	const current = readKvId(text);
	if (current === undefined) throw new Error(`no OAUTH_KV binding in ${CONFIG}`);
	const lines = text.split("\n");
	const i = lines.findIndex((l) => !isComment(l) && l.includes(`"${current}"`) && /"id"\s*:/.test(l));
	lines[i] = lines[i].replace(`"${current}"`, JSON.stringify(id));
	return lines.join("\n");
}

/**
 * Top-level settings the Worker should always have, added to an older
 * wrangler.jsonc by npm run setup when missing.
 */
export const DEFAULT_SETTINGS = { workers_dev: true, preview_urls: false };

/** Adds a top-level boolean or string setting after "main" (or after "name") when missing. */
export function addTopLevel(text, key, value) {
	if (key in parseJsonc(text)) return text;
	const lines = text.split("\n");
	let i = lines.findIndex((l) => !isComment(l) && /^\s*"main"\s*:/.test(l));
	if (i < 0) i = lines.findIndex((l) => !isComment(l) && /^\s*"name"\s*:/.test(l));
	if (i < 0) throw new Error(`no "name" in ${CONFIG}`);
	const indent = lines[i].match(/^\s*/)?.[0] ?? "\t";
	lines.splice(i + 1, 0, `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)},`);
	return lines.join("\n");
}

/** Adds a top-level "account_id" after "name" (or replaces it). */
export function setAccountId(text, id) {
	const replaced = replaceValue(text, "account_id", id);
	if (replaced !== undefined) return replaced;
	const lines = text.split("\n");
	const i = lines.findIndex((l) => !isComment(l) && /^\s*"name"\s*:/.test(l));
	const indent = lines[i].match(/^\s*/)?.[0] ?? "\t";
	lines.splice(i + 1, 0, `${indent}"account_id": ${JSON.stringify(id)},`);
	return lines.join("\n");
}

/** Removes // and /* *\/ comments outside strings. */
export function stripComments(text) {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (c === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2) + 1;
		} else out += c;
	}
	return out;
}

/** Parses JSONC (comments, trailing commas). */
export function parseJsonc(text) {
	return JSON.parse(stripComments(text).replace(/,(\s*[}\]])/g, "$1"));
}

// ---- comparing configs (npm run update) ---------------------------------------

/** Settings the Worker runs fine without. Everything else in the example is required. */
const OPTIONAL = new Set(["$schema", "observability", "dev", "vars.MCP_RESOURCE", "workers_dev", "preview_urls"]);

/**
 * Settings in the example that the user's config lacks: top-level keys, vars,
 * compatibility flags, required secrets and KV bindings.
 */
export function missingSettings(exampleText, userText) {
	const ex = parseJsonc(exampleText);
	const me = parseJsonc(userText);
	const out = [];
	const add = (key, what) => out.push({ key, what, required: !OPTIONAL.has(key) });
	for (const k of Object.keys(ex)) if (!(k in me)) add(k, `top-level setting "${k}"`);
	for (const k of Object.keys(ex.vars ?? {})) if (!(k in (me.vars ?? {}))) add(`vars.${k}`, `variable "${k}" in "vars"`);
	for (const f of ex.compatibility_flags ?? []) {
		if (!(me.compatibility_flags ?? []).includes(f)) add(`compatibility_flags.${f}`, `compatibility flag "${f}"`);
	}
	for (const s of ex.secrets?.required ?? []) {
		if ("secrets" in me && !(me.secrets?.required ?? []).includes(s)) add(`secrets.${s}`, `required secret "${s}" in "secrets"`);
	}
	const bindings = (c) => new Set((c.kv_namespaces ?? []).map((k) => k.binding));
	for (const b of bindings(ex)) if (!bindings(me).has(b)) add(`kv.${b}`, `KV binding "${b}"`);
	if (ex.compatibility_date && me.compatibility_date && me.compatibility_date < ex.compatibility_date) {
		out.push({
			key: "compatibility_date",
			what: `compatibility_date: yours is ${me.compatibility_date}, the example's is ${ex.compatibility_date}`,
			required: false,
		});
	}
	return out;
}

// ---- lookups --------------------------------------------------------------------

/** GitHub's numeric user ID for a username, or a reason it couldn't be found. */
export async function githubUser(fetchImpl, username) {
	if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(username)) return { error: "That isn't a valid GitHub username." };
	let res;
	try {
		res = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(username)}`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": "garmin-mcp-setup" },
		});
	} catch (err) {
		return { error: `Couldn't reach GitHub (${err.message}).` };
	}
	if (res.status === 404) return { error: `GitHub has no user called "${username}".` };
	if (!res.ok) return { error: `GitHub returned HTTP ${res.status}.` };
	const body = await res.json();
	if (typeof body.id !== "number") return { error: "GitHub's answer had no user ID." };
	return { id: body.id, login: body.login ?? username };
}

/**
 * GET from Cloudflare's API using wrangler's own login. The token is held in
 * memory only, never printed or stored. Undefined when there's no usable
 * login or the request fails outright.
 */
async function cloudflareGet(ctx, path) {
	if (!ctx.cfHeaders) {
		const tok = await wrangler(ctx, ["auth", "token", "--json"]);
		const auth = tok.code === 0 ? parseJson(tok.stdout) : undefined;
		ctx.cfHeaders =
			auth?.type === "api_key"
				? { "X-Auth-Key": auth.key, "X-Auth-Email": auth.email }
				: auth?.token
					? { Authorization: `Bearer ${auth.token}` }
					: null;
	}
	if (!ctx.cfHeaders) return undefined;
	try {
		const res = await ctx.fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: ctx.cfHeaders });
		const body = await res.json().catch(() => undefined);
		return { status: res.status, body };
	} catch {
		return undefined;
	}
}

/** The account's workers.dev subdomain, or undefined if it can't be found. */
export async function workersSubdomain(ctx, accountId) {
	const res = await cloudflareGet(ctx, `/accounts/${accountId}/workers/subdomain`);
	const sub = res?.status === 200 ? res.body?.result?.subdomain : undefined;
	return typeof sub === "string" && sub ? sub : undefined;
}

/** Whether a Worker with this name exists in the account: true, false, or undefined if unknown. */
export async function workerExists(ctx, accountId, name) {
	const res = await cloudflareGet(ctx, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/settings`);
	if (res?.status === 200) return true;
	if (res?.status === 404) return false;
	return undefined;
}

/** Most Workers checked when looking for which one uses a KV namespace. */
const MAX_WORKERS_CHECKED = 50;

/**
 * Names of the Workers in the account that bind KV namespace `nsId`, or
 * undefined when Cloudflare's API can't say.
 */
export async function kvNamespaceUsers(ctx, accountId, nsId) {
	const list = await cloudflareGet(ctx, `/accounts/${accountId}/workers/scripts`);
	if (list?.status !== 200 || !Array.isArray(list.body?.result)) return undefined;
	const names = list.body.result.map((s) => s?.id).filter((n) => typeof n === "string").slice(0, MAX_WORKERS_CHECKED);
	const users = [];
	for (const name of names) {
		const res = await cloudflareGet(ctx, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/settings`);
		if (res?.status !== 200) return undefined;
		const bindings = res.body?.result?.bindings;
		if (Array.isArray(bindings) && bindings.some((b) => b?.type === "kv_namespace" && b.namespace_id === nsId)) users.push(name);
	}
	return users;
}

/** The KV namespace title for a Worker: its name plus the binding, so several deployments can share an account. */
export const kvTitle = (workerName) => `${workerName}-OAUTH_KV`;

/** Cloudflare Worker names: lowercase letters, digits and dashes, up to 63, not starting or ending with a dash. */
export const isWorkerName = (s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s);

export function readPackageVersion(files) {
	try {
		return JSON.parse(files.read("package.json")).version;
	} catch {
		return undefined;
	}
}
