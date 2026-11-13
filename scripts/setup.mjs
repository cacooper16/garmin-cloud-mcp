#!/usr/bin/env node
// npm run setup: deploys your own copy of the cloud server, step by step.
// Run it from the repo folder after npm install. Safe to rerun: it lists what
// it already has, keeps it, and asks before replacing anything.
//
// Secrets are read without echo, sent to wrangler on stdin (never in command
// arguments) and never printed or written to disk.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	addTopLevel,
	askValid,
	CONFIG,
	confirm,
	DEFAULT_SETTINGS,
	describeFailure,
	EXAMPLE,
	GARMIN_KEY_PAGE,
	githubUser,
	isWorkerName,
	KV_PLACEHOLDER,
	kvNamespaceUsers,
	kvTitle,
	makeFiles,
	makeIO,
	makeRunner,
	NEW_OAUTH_APP,
	parseJson,
	parseKvId,
	readKvId,
	readValue,
	replaceValue,
	setAccountId,
	setKvId,
	setVar,
	StepError,
	workerExists,
	workersSubdomain,
	wrangler,
} from "./lib.mjs";

const SECRETS = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "COOKIE_ENCRYPTION_KEY", "GARMIN_API_KEY"];
const HIDDEN = "(paste it; nothing will show as you type): ";

/** Answer checks: true, or what was expected. */
const CHECKS = {
	clientId: (a) =>
		/^[A-Za-z0-9._-]{16,40}$/.test(a) ||
		"A GitHub client ID is about 20 letters and numbers (e.g. Ov23liAbCdEfGhIjKlMn), shown at the top of the OAuth app's page.",
	clientSecret: (a) =>
		/^[0-9a-f]{40}$/i.test(a) ||
		"A GitHub client secret is 40 letters and numbers (0-9 and a-f). Copy it from the green box shown after 'Generate a new client secret'.",
	garminKey: (a) =>
		(a.length >= 8 && !/\s/.test(a)) ||
		"A Garmin key is one long string with no spaces. Copy it again from Garmin Connect, or create a new one.",
};

/**
 * ctx: { run, io, files, fetch, nodeVersion, randomHex }. Returns the server
 * URL. Throws StepError when a step fails.
 */
export async function runSetup(ctx) {
	const { io, files } = ctx;
	const step = (n, title) => io.print(`\n${n}. ${title}`);
	const fail = (num, name, message, hint) => new StepError(name, message, hint, num);
	const randomHex = ctx.randomHex ?? (() => randomBytes(32).toString("hex"));
	const node = ctx.nodeVersion ?? process.versions.node;

	// 1. Tools
	step(1, "Node and wrangler");
	if (!(Number(String(node).split(".")[0]) >= 22)) {
		throw fail(1, "Node version", `this is Node ${node}, and setup needs Node 22 or newer.`, "install Node 22 or newer from https://nodejs.org, then run npm run setup again.");
	}
	const ver = await wrangler(ctx, ["--version"]);
	if (ver.code !== 0) {
		throw fail(1, "wrangler", "wrangler isn't installed in this folder.", "run npm install here, then npm run setup again.");
	}
	io.print(`   Node ${node}, wrangler ${ver.stdout.trim().split("\n").pop()}.`);

	// 2. Cloudflare login
	step(2, "Cloudflare login");
	let who = await whoami(ctx);
	if (!who) {
		io.print("   Not logged in. Opening Cloudflare in your browser...");
		const login = await wrangler(ctx, ["login"], { inherit: true });
		who = login.code === 0 ? await whoami(ctx) : undefined;
		if (!who) throw fail(2, "Cloudflare login", "the Cloudflare login didn't complete.", "run npx wrangler login, then npm run setup again.");
	}
	io.print(`   Logged in${who.email ? ` as ${who.email}` : ""}.`);

	// 3. Settings file
	step(3, `Settings (${CONFIG})`);
	const hadConfig = files.exists(CONFIG);
	if (!hadConfig) {
		files.write(CONFIG, files.read(EXAMPLE));
		io.print(`   Created ${CONFIG} from ${EXAMPLE} (it's git-ignored, so it's never committed).`);
	}
	let config = files.read(CONFIG);
	const save = (text) => {
		config = text;
		files.write(CONFIG, text);
	};
	// Settings newer versions rely on, added to an older file without asking.
	const added = [];
	for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
		const next = addTopLevel(config, key, value);
		if (next !== config) {
			save(next);
			added.push(`"${key}": ${JSON.stringify(value)}`);
		}
	}
	if (hadConfig && added.length) io.print(`   Added ${added.join(" and ")} to ${CONFIG}.`);

	// Which Cloudflare account: wrangler needs to know when there's more than one.
	let accountId = readValue(config, "account_id");
	const accounts = who.accounts ?? [];
	if (!accountId) {
		if (accounts.length === 1) accountId = accounts[0].id;
		else if (accounts.length > 1) {
			io.print("   Your login has several Cloudflare accounts:");
			accounts.forEach((a, i) => io.print(`     ${i + 1}. ${a.name} (${a.id})`));
			const pick = await askValid(io, "   Which one should the server live in? Number: ", (a) =>
				(Number(a) >= 1 && Number(a) <= accounts.length) || `Enter a number from 1 to ${accounts.length}.`,
			);
			accountId = accounts[Number(pick) - 1].id;
			save(setAccountId(config, accountId));
			io.print(`   Saved account_id to ${CONFIG}.`);
		}
	}

	// On a rerun, show what's already set and keep it with one answer.
	const savedName = readValue(config, "name") ?? "garmin-cloud-mcp";
	const savedKv = readKvId(config);
	const haveKv = Boolean(savedKv) && savedKv !== KV_PLACEHOLDER;
	const savedUser = readValue(config, "ALLOWED_GITHUB_USER_ID");
	const haveUser = Boolean(savedUser) && /^[1-9]\d*$/.test(savedUser);
	let keep = false;
	if (hadConfig && (haveKv || haveUser)) {
		io.print("   From your last run:");
		io.print(`     Worker name     ${savedName}`);
		if (haveKv) io.print(`     KV namespace    ${savedKv}`);
		if (haveUser) io.print(`     GitHub user ID  ${savedUser}`);
		keep = await confirm(io, "   Keep these?");
	}

	// The Worker's name, which is also part of its URL.
	let name = savedName;
	if (!keep) {
		// A previous run that got as far as the KV namespace set this Worker up,
		// so finding it in the account is expected, not a clash.
		const ours = hadConfig && haveKv;
		for (;;) {
			const answer = await askValid(io, `   Worker name, part of its URL [${savedName}]: `, (a) =>
				!a || isWorkerName(a) || "Use lowercase letters, digits and dashes (up to 63, no dash at either end).",
			);
			name = answer || savedName;
			if (ours && name === savedName) break;
			const exists = accountId ? await workerExists(ctx, accountId, name) : undefined;
			if (exists === false) break;
			if (exists === undefined) {
				io.print(`   Couldn't check whether a Worker called "${name}" already exists. If it does, deploying replaces it.`);
				break;
			}
			io.print(`   Your Cloudflare account already has a Worker called "${name}". Deploying will replace its code and settings.`);
			if (await confirm(io, "   Replace it?", false)) break;
			io.print("   Then pick another name.");
		}
		if (name !== readValue(config, "name")) {
			save(replaceValue(config, "name", name));
			io.print(`   Saved the name "${name}".`);
		}
	}

	// 4. KV namespace: titled after the Worker, so it can't clash with another
	// deployment's in the same account. The binding stays OAUTH_KV.
	if (!(keep && haveKv)) {
		step(4, "Storage for sign-ins (KV namespace)");
		if (haveKv && (await confirm(io, `   Keep the KV namespace ${savedKv}?`))) io.print("   Kept.");
		else save(setKvId(config, await kvNamespace(ctx, name, accountId)));
	}

	// 5. Allowed GitHub account
	if (!(keep && haveUser)) {
		step(5, "Lock it to your GitHub account");
		if (haveUser && (await confirm(io, `   Keep GitHub user ID ${savedUser}?`))) io.print("   Kept.");
		else {
			for (;;) {
				const login = await askValid(io, "   Your GitHub username: ", (a) => Boolean(a) || "Enter the username you sign in to GitHub with.");
				const user = await githubUser(ctx.fetch, login);
				if (user.error) {
					io.print(`     ${user.error}`);
					continue;
				}
				if (await confirm(io, `   That's ${user.login}, numeric ID ${user.id}. Only this account will be able to sign in. Correct?`)) {
					save(setVar(config, "ALLOWED_GITHUB_USER_ID", String(user.id)));
					io.print(`   Saved GitHub user ID ${user.id}.`);
					break;
				}
			}
		}
	}

	// 6. The Worker's URL
	step(6, "Your server's URL");
	const override = readValue(config, "MCP_RESOURCE");
	let base;
	if (override) {
		base = new URL(override).origin;
		io.print(`   ${base} (from MCP_RESOURCE in ${CONFIG})`);
	} else {
		const sub = accountId ? await workersSubdomain(ctx, accountId) : undefined;
		if (sub) base = `https://${name}.${sub}.workers.dev`;
		else {
			io.print("   Couldn't look up your workers.dev subdomain automatically.");
			io.print("   It's on the Workers & Pages overview in the Cloudflare dashboard (e.g. 'alice' in alice.workers.dev).");
			const answer = await askValid(io, "   Your workers.dev subdomain (or the Worker's full URL): ", (a) =>
				/^https:\/\/[^/\s]+\/?$/.test(a) || /^[a-z0-9][a-z0-9-]*$/i.test(a) || "Enter just the subdomain (e.g. alice), or a URL like https://host.",
			);
			base = answer.startsWith("https://") ? answer.replace(/\/$/, "") : `https://${name}.${answer.toLowerCase()}.workers.dev`;
		}
		io.print(`   ${base}`);
	}

	// 7-10. Secrets
	const existing = await secretNames(ctx);
	const toSet = {};

	step(7, "GitHub OAuth app (how sign-in works)");
	const haveGitHub = existing.has("GITHUB_CLIENT_ID") && existing.has("GITHUB_CLIENT_SECRET");
	if (haveGitHub && !(await confirm(io, "   Your GitHub OAuth app's ID and secret are already stored. Replace them?", false))) {
		io.print("   Kept.");
	} else {
		io.print(`   Open ${NEW_OAUTH_APP} and fill in:`);
		io.print("     Application name:           anything, e.g. Garmin MCP");
		io.print(`     Homepage URL:               ${base}`);
		io.print(`     Authorization callback URL: ${base}/callback`);
		io.print("   Click 'Register application'. The next page shows the Client ID at the top.");
		io.print("   Then click 'Generate a new client secret'. The secret appears once, in a green box:");
		io.print("   copy it straight away. The client ID isn't secret; the client secret is.");
		toSet.GITHUB_CLIENT_ID = await askValid(io, "   Client ID: ", CHECKS.clientId);
		toSet.GITHUB_CLIENT_SECRET = await askValid(io, `   Client secret ${HIDDEN}`, CHECKS.clientSecret, { secret: true });
	}

	step(8, "Garmin Personal API key");
	if (existing.has("GARMIN_API_KEY") && !(await confirm(io, "   A Garmin key is already stored. Replace it?", false))) {
		io.print("   Kept.");
	} else {
		io.print("   You can reuse a key you already have (e.g. from a local setup), or create a new one at");
		io.print(`   ${GARMIN_KEY_PAGE} (Create Key, pick 1 year). Garmin shows a new key only once.`);
		toSet.GARMIN_API_KEY = await askValid(io, `   Garmin key ${HIDDEN}`, CHECKS.garminKey, { secret: true });
	}

	step(9, "Cookie encryption key");
	if (existing.has("COOKIE_ENCRYPTION_KEY")) io.print("   Already stored; keeping it.");
	else {
		toSet.COOKIE_ENCRYPTION_KEY = randomHex();
		io.print("   Generated a random one.");
	}

	step(10, "Storing secrets in Cloudflare");
	const names = Object.keys(toSet);
	if (!names.length) io.print("   Nothing new to store.");
	else {
		// JSON on stdin: values never appear in arguments or output.
		const res = await wrangler(ctx, ["secret", "bulk"], { input: JSON.stringify(toSet) });
		if (res.code !== 0) {
			throw fail(
				10,
				"secrets",
				`wrangler couldn't store the secrets: ${redact(res.stderr || res.stdout, toSet).trim().slice(0, 300)}`,
				"check you're logged in to the right Cloudflare account with npx wrangler whoami, then run npm run setup again.",
			);
		}
		io.print(`   Stored ${names.join(", ")}.`);
	}
	const missing = SECRETS.filter((s) => !existing.has(s) && !names.includes(s));
	if (missing.length) {
		throw fail(10, "secrets", `these secrets still aren't stored: ${missing.join(", ")}.`, "run npm run setup again and answer yes when it asks to replace them.");
	}

	// 11. Deploy
	step(11, "Deploying");
	const deployed = await wrangler(ctx, ["deploy"], { inherit: true });
	if (deployed.code !== 0) {
		throw fail(11, "deploy", "wrangler deploy failed (its output is above).", "fix what it reports, then run npx wrangler deploy.");
	}

	const url = `${base}/mcp`;
	io.print(`\nDone. Your server URL is:\n\n   ${url}\n`);
	io.print("Add it to your AI app; the first time, it opens a GitHub sign-in:");
	io.print("   Claude:      Settings > Connectors > Add custom connector, paste the URL.");
	io.print("   ChatGPT:     add a custom connector (MCP server) with OAuth; needs developer mode.");
	io.print(`   Claude Code: claude mcp add --transport http garmin ${url}  then /mcp to sign in.`);
	io.print('Then ask: "Am I ready to train today?"');
	return url;
}

/**
 * The id of the Worker's own KV namespace ("<worker>-OAUTH_KV"): an existing
 * one with exactly that title (offered for reuse), or a new one. Namespaces
 * with other titles, such as a plain "OAUTH_KV", belong to other deployments
 * and are never used.
 */
async function kvNamespace(ctx, name, accountId) {
	const { io } = ctx;
	const title = kvTitle(name);
	const fail = (message, hint) => new StepError("KV namespace", message, hint, 4);
	const createHint = (t) => `run npx wrangler kv namespace create ${t}, put the id it prints in ${CONFIG} (the OAUTH_KV binding's "id"), then run npm run setup again.`;

	const listed = await wrangler(ctx, ["kv", "namespace", "list"]);
	const list = listed.code === 0 ? parseJson(listed.stdout) : undefined;
	const namespaces = Array.isArray(list) ? list.filter((n) => typeof n?.id === "string" && typeof n?.title === "string") : [];

	const mine = namespaces.find((n) => n.title === title);
	if (mine) {
		const users = accountId ? await kvNamespaceUsers(ctx, accountId, mine.id) : undefined;
		const others = (users ?? []).filter((u) => u !== name);
		const usedBy =
			users === undefined ? "couldn't check which Worker uses it" : users.length ? `used by ${users.join(", ")}` : "not used by any Worker yet, probably from an earlier run";
		io.print(`   Found "${title}" (${usedBy}).`);
		if (others.length) io.print(`   It probably belongs to ${others.length > 1 ? "those Workers" : `"${others[0]}"`}; sharing it would mix their sign-ins with this one's.`);
		if (await confirm(io, "   Use it for this Worker?", !others.length)) {
			io.print(`   Using "${title}".`);
			return mine.id;
		}
		throw fail(
			`didn't use the existing "${title}" namespace, and one with that title can't be created twice.`,
			`run npm run setup again and choose a different Worker name (the namespace is named after it), or ${createHint(`${title}-2`)}`,
		);
	}

	// Other deployments' namespaces: say why they're left alone.
	const foreign = namespaces.filter((n) => n.title === "OAUTH_KV" || n.title.endsWith("-OAUTH_KV"));
	if (foreign.length) {
		const names = foreign.map((n) => `"${n.title}"`).join(", ");
		io.print(`   Found ${names}, which probably belong${foreign.length > 1 ? "" : "s"} to another Worker; leaving ${foreign.length > 1 ? "them" : "it"} alone.`);
	}

	const created = await wrangler(ctx, ["kv", "namespace", "create", title]);
	const id = created.code === 0 ? parseKvId(created.stdout + created.stderr) : undefined;
	if (!id) {
		const why = (created.stderr || created.stdout).trim().split("\n").filter(Boolean).pop() ?? "no id in wrangler's output";
		const clash = /already exists/i.test(created.stdout + created.stderr);
		throw fail(`couldn't create the KV namespace "${title}": ${why.slice(0, 200)}`, createHint(clash ? `${title}-2` : title));
	}
	io.print(`   Created "${title}" and saved it to ${CONFIG} as the OAUTH_KV binding.`);
	return id;
}

/** whoami --json, or undefined when not logged in. */
async function whoami(ctx) {
	const res = await wrangler(ctx, ["whoami", "--json"]);
	const info = res.code === 0 ? parseJson(res.stdout) : undefined;
	return info?.loggedIn ? info : undefined;
}

/** Names of secrets already on the Worker; empty if the Worker doesn't exist yet. */
async function secretNames(ctx) {
	const res = await wrangler(ctx, ["secret", "list", "--format", "json"]);
	const list = res.code === 0 ? parseJson(res.stdout) : undefined;
	return new Set(Array.isArray(list) ? list.map((s) => s.name) : []);
}

/** Belt and braces: never echo a secret back, even inside an error. */
function redact(text, secrets) {
	let out = String(text);
	for (const v of Object.values(secrets)) if (v) out = out.split(v).join("[hidden]");
	return out;
}

async function main() {
	const cwd = process.cwd();
	const files = makeFiles(cwd);
	if (!files.exists(EXAMPLE)) {
		console.error(`Run this from the garmin-mcp repo folder (there's no ${EXAMPLE} here): cd garmin-mcp, then npm run setup.`);
		process.exit(1);
	}
	const io = makeIO();
	io.print("Setting up your cloud Garmin MCP server. Press Ctrl+C at any time; rerunning keeps what's done.");
	try {
		await runSetup({ run: makeRunner(cwd), io, files, fetch: globalThis.fetch });
	} catch (err) {
		if (err instanceof StepError) console.error(describeFailure(err));
		else {
			console.error(`\nSetup stopped: ${err instanceof Error ? err.message : String(err)}`);
			console.error("To fix it: run npm run setup again; if it stops at the same place, open an issue with this message.");
		}
		process.exitCode = 1;
	} finally {
		io.close();
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
