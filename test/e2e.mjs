/**
 * End-to-end test: runs the real bundled Worker in Miniflare (the local
 * Cloudflare runtime) and walks the whole flow an MCP client takes (Claude's redirect URL is
 * used as the example client):
 *
 *   register client -> /authorize -> approve -> GitHub login -> /callback
 *   -> /token (PKCE) -> MCP initialize -> tools/list -> tools/call
 *
 * GitHub and Garmin are faked at the network layer (outboundService), so no
 * real credentials are needed. Also checks that a different GitHub account is
 * refused before any token is issued.
 *
 * Run: npm run test:e2e
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { Miniflare } from "miniflare";
import { buildFit, buildZip, steadyRun } from "./fit-fixture.ts";

const BASE = "http://localhost:8788";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const ALLOWED_ID = 1234567;

let githubUserId = ALLOWED_ID;
const garminCalls = [];

const jwt = (exp) => {
	const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${b({ alg: "RS256" })}.${b({ exp })}.sig`;
};

async function outbound(req) {
	const url = new URL(req.url);
	if (url.href === "https://github.com/login/oauth/access_token") {
		return Response.json({ access_token: "gho_fake", token_type: "bearer" });
	}
	if (url.href === "https://api.github.com/user") {
		assert.equal(req.headers.get("authorization"), "Bearer gho_fake");
		return Response.json({ id: githubUserId, login: githubUserId === ALLOWED_ID ? "allowed-user" : "stranger" });
	}
	if (url.host === "personal.connectapi.garmin.com") {
		garminCalls.push(url.pathname + url.search);
		if (url.pathname.endsWith("/personal-api-key/token")) {
			assert.equal(req.headers.get("authorization"), "ApiKey garmin-test-key");
			return new Response(jwt(Math.floor(Date.now() / 1000) + 86400));
		}
		assert.match(req.headers.get("authorization") ?? "", /^Bearer ey/);
		if (url.pathname === "/activitylist-service/activities/search/activities") {
			// 150 identical 5 km / 25 min runs on 2026-07-15, served in pages, with
			// bulky extra fields. Date filters are honoured like Garmin's.
			const from = url.searchParams.get("startDate") ?? "0000-00-00";
			const to = url.searchParams.get("endDate") ?? "9999-99-99";
			const total = from <= "2026-07-15" && "2026-07-15" <= to ? 150 : 0;
			const start = Number(url.searchParams.get("start"));
			const limit = Number(url.searchParams.get("limit"));
			const n = Math.max(0, Math.min(limit, total - start));
			const bulk = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, i]));
			return Response.json(
				Array.from({ length: n }, (_, i) => ({
					...bulk,
					activityId: start + i + 1,
					startTimeLocal: "2026-07-15 07:00:00",
					activityType: { typeKey: "running" },
					distance: 5000,
					movingDuration: 1500,
				})),
			);
		}
		const days = (a, b) => {
			const out = [];
			for (let d = new Date(`${a}T00:00:00Z`); d <= new Date(`${b}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
				out.push(d.toISOString().slice(0, 10));
			}
			return out;
		};
		if (url.pathname === "/sleep-service/sleep/dailySleepSummariesByDate") {
			// Garmin caps this endpoint at 31 days.
			const range = days(url.searchParams.get("startDate"), url.searchParams.get("endDate"));
			if (range.length > 31) return new Response("range too long", { status: 400 });
			return Response.json(
				range.map((d) => ({
					calendarDate: d,
					sleepTimeSeconds: 27000,
					deepSleepSeconds: 5400,
					sleepScores: { overall: { value: 80, qualifierKey: "GOOD" } },
					// Real shape: epoch ms, *Local being wall-clock time encoded as if UTC.
					// In bed at 23:00 the night before, for a UTC+1 user.
					sleepStartTimestampGMT: Date.parse(`${d}T00:00:00Z`) - 2 * 3600_000,
					sleepStartTimestampLocal: Date.parse(`${d}T00:00:00Z`) - 3600_000,
				})),
			);
		}
		if (url.pathname === "/userprofile-service/userprofile/settings") {
			return Response.json({ timeZone: "Pacific/Kiritimati", measurementSystem: "metric" }); // UTC+14
		}
		const download = url.pathname.match(/^\/download-service\/files\/activity\/(\d+)$/);
		if (download) {
			if (download[1] === "404") return new Response("not found", { status: 404 });
			// A synthetic 2.5 km run at 4 m/s (no GPS), zipped like Garmin's download.
			const zip = buildZip([{ name: `${download[1]}_ACTIVITY.fit`, data: buildFit({ records: steadyRun(625, 4) }) }]);
			return new Response(zip, { headers: { "content-type": "application/x-zip-compressed" } });
		}
		if (url.pathname === "/biometric-service/heartRateZones/v2") {
			return Response.json([{ sport: "DEFAULT", zone1Floor: 100, zone2Floor: 120, zone3Floor: 140, zone4Floor: 160, zone5Floor: 180, maxHeartRateUsed: 195 }]);
		}
		const detail = url.pathname.match(/^\/activity-service\/activity\/(\d+)$/);
		if (detail) {
			if (detail[1] === "404") return new Response("not found", { status: 404 });
			return Response.json({
				activityId: Number(detail[1]),
				activityName: `Run ${detail[1]}`,
				activityTypeDTO: { typeKey: "running" },
				metadataDTO: { bulk: "x".repeat(2000) },
				summaryDTO: { distance: 10000, movingDuration: 3000, averageMovingSpeed: 10000 / 3000, averageHR: 150 },
			});
		}
		const hrv = url.pathname.match(/^\/hrv-service\/hrv\/daily\/([\d-]+)\/([\d-]+)$/);
		if (hrv) {
			if (hrv[2] === "2026-10-15") return new Response("boom", { status: 500 });
			return Response.json({
				userProfilePk: 1,
				hrvSummaries: days(hrv[1], hrv[2]).map((d) => ({ calendarDate: d, lastNightAvg: 45, weeklyAvg: 44, status: "BALANCED" })),
			});
		}
		if (url.pathname === "/usersummary-service/v2/dailysummaries") {
			const range = days(url.searchParams.get("startDate"), url.searchParams.get("endDate"));
			return Response.json({
				data: range.map((d) => ({
					uuid: "u",
					calendarDate: d,
					movement: { steps: { value: 9876, goal: 8000 } },
					heartRate: { restingValue: 50 },
				})),
			});
		}
		return Response.json({ data: [{ calendarDate: "2026-11-05", totalSteps: 9876 }] });
	}
	return new Response(`unexpected outbound fetch: ${url.href}`, { status: 599 });
}

/**
 * Some steps make the Worker fail on purpose, and it logs those failures.
 * Label them so they don't read as problems. Anything not listed here is
 * printed as a plain worker log, so a genuine error still stands out.
 */
const EXPECTED_LOGS = [
	[/Rejected login attempt from GitHub user id/, "stranger's GitHub account is refused"],
	[/Range is \d+ days; max is \d+/, "bad input comes back as a tool error"],
	[/401 invalid_token/, "requests without a valid token are rejected"],
];

function labelWorkerLogs(stdout, stderr) {
	for (const stream of [stdout, stderr]) {
		createInterface({ input: stream }).on("line", (line) => {
			if (!line.trim()) return;
			const hit = EXPECTED_LOGS.find(([re]) => re.test(line));
			console.log(hit ? `     expected (${hit[1]}): ${line}` : `     worker log: ${line}`);
		});
	}
}

// Uses stable Miniflare 4 (wrangler bundles its own, newer copy for dev/deploy).
const mfOptions = {
	modules: true,
	scriptPath: ".wrangler/e2e-dist/index.js",
	compatibilityDate: "2026-07-30", // newest date Miniflare 4's runtime supports
	compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
	kvNamespaces: ["OAUTH_KV"],
	bindings: {
		MCP_RESOURCE: `${BASE}/mcp`,
		ALLOWED_GITHUB_USER_ID: String(ALLOWED_ID),
		GITHUB_CLIENT_ID: "gh-client",
		GITHUB_CLIENT_SECRET: "gh-secret",
		COOKIE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
		GARMIN_API_KEY: "garmin-test-key",
	},
	outboundService: outbound,
	handleRuntimeStdio: labelWorkerLogs,
};
console.log("Built the Worker locally for testing (the '--dry-run: exiting now' above is this build, not a deploy).");
const mf = new Miniflare(mfOptions);

const fetchW = (path, init = {}) =>
	mf.dispatchFetch(path.startsWith("http") ? path : BASE + path, { redirect: "manual", ...init });

/** Tiny cookie jar: keeps name=value from Set-Cookie, honours Max-Age=0. */
const jar = new Map();
function keepCookies(res) {
	for (const c of res.headers.getSetCookie()) {
		const [pair] = c.split(";");
		const i = pair.indexOf("=");
		const name = pair.slice(0, i);
		if (/max-age=0/i.test(c)) jar.delete(name);
		else jar.set(name, pair.slice(i + 1));
	}
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

/** Runs the browser part of the login, returns the /callback response. */
async function login(clientId, challenge) {
	jar.clear();
	const q = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "claude-state",
		resource: `${BASE}/mcp`,
	});
	const page = await fetchW(`/authorize?${q}`);
	assert.equal(page.status, 200, "approval page");
	keepCookies(page);
	const html = await page.text();
	const field = (n) => html.match(new RegExp(`name="${n}" value="([^"]+)"`))[1];

	const approve = await fetchW("/authorize", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader() },
		body: new URLSearchParams({ state: field("state"), csrf_token: field("csrf_token") }),
	});
	assert.equal(approve.status, 302, "approve redirects to GitHub");
	keepCookies(approve);
	assert.ok(!jar.has("__Host-CSRF_TOKEN"), "CSRF cookie cleared after use");
	const gh = new URL(approve.headers.get("location"));
	assert.equal(gh.origin + gh.pathname, "https://github.com/login/oauth/authorize");
	assert.equal(gh.searchParams.get("scope"), "", "asks GitHub for identity only");

	// GitHub sends the browser back with a code and our state token.
	return fetchW(`/callback?code=gh-code&state=${gh.searchParams.get("state")}`, {
		headers: { Cookie: cookieHeader() },
	});
}

let rpcId = 0;
async function mcp(token, method, params, sessionId) {
	const res = await fetchW("/mcp", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
			...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
	});
	const text = await res.text();
	assert.equal(res.status, 200, `${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
	// Response may be JSON or a single SSE event.
	const json = text.trim().startsWith("{")
		? JSON.parse(text)
		: JSON.parse(text.split("\n").find((l) => l.startsWith("data:")).slice(5));
	return { json, sessionId: res.headers.get("mcp-session-id") ?? sessionId };
}

const results = [];
async function step(name, fn) {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}\n     ${e.message}`);
		process.exitCode = 1;
	}
}

try {
	// The MCP client (here, Claude) registers itself as an OAuth client.
	const reg = await (
		await fetchW("/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "Claude",
				redirect_uris: [REDIRECT],
				token_endpoint_auth_method: "none",
			}),
		})
	).json();
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");

	await step("stranger's GitHub account is refused, no code issued", async () => {
		githubUserId = 999;
		const res = await login(reg.client_id, challenge);
		assert.equal(res.status, 403);
		assert.equal(res.headers.get("location"), null);
	});

	let accessToken;
	await step("allowed account completes login and gets a token via PKCE", async () => {
		githubUserId = ALLOWED_ID;
		const res = await login(reg.client_id, challenge);
		assert.equal(res.status, 302, `callback status ${res.status}: ${await res.clone().text()}`);
		const back = new URL(res.headers.get("location"));
		assert.equal(back.origin + back.pathname, REDIRECT);
		assert.equal(back.searchParams.get("state"), "claude-state");

		const tok = await fetchW("/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: back.searchParams.get("code"),
				redirect_uri: REDIRECT,
				client_id: reg.client_id,
				code_verifier: verifier,
				resource: `${BASE}/mcp`,
			}),
		});
		const body = await tok.json();
		assert.equal(tok.status, 200, JSON.stringify(body));
		assert.ok(body.access_token && body.refresh_token);
		accessToken = body.access_token;
	});

	let session;
	await step("MCP initialize + tools/list exposes the Garmin tools, all read-only", async () => {
		const init = await mcp(accessToken, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "e2e", version: "1" },
		});
		assert.equal(init.json.result.serverInfo.name, "garmin");
		session = init.sessionId;
		const { json } = await mcp(accessToken, "tools/list", {}, session);
		const tools = json.result.tools;
		const names = tools.map((t) => t.name);
		for (const n of ["get_daily_summaries", "get_sleep_summaries", "get_hrv_summaries", "search_activities", "get_activity", "summarize_activities", "get_readiness", "summarize_wellness", "compare_activities", "get_nutrition", "get_weight_goals", "get_menstrual_cycle"]) {
			assert.ok(names.includes(n), `missing ${n}`);
		}
		assert.ok(!names.includes("garmin_get"), "no raw-path tool: Claude must not guess endpoints");
		assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), "all tools read-only");
		results.push(`     (${names.length} tools)`);
	});

	await step("tools/call hits Garmin with a bearer token and returns data", async () => {
		const { json } = await mcp(
			accessToken,
			"tools/call",
			{ name: "get_daily_summaries", arguments: { start_date: "2026-11-01", end_date: "2026-11-05" } },
			session,
		);
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		assert.match(json.result.content[0].text, /9876/);
		assert.ok(
			garminCalls.includes("/usersummary-service/v2/dailysummaries?startDate=2026-11-01&endDate=2026-11-05"),
			garminCalls.join("\n"),
		);
	});

	await step("Garmin token is exchanged once and reused across calls", async () => {
		await mcp(accessToken, "tools/call", { name: "get_hrv_summaries", arguments: { start_date: "2026-11-01" } }, session);
		const tokenCalls = garminCalls.filter((c) => c.includes("personal-api-key/token")).length;
		assert.equal(tokenCalls, 1);
	});

	await step("bad input comes back as a tool error, not a crash", async () => {
		const { json } = await mcp(
			accessToken,
			"tools/call",
			{ name: "get_stress", arguments: { start_date: "2025-01-01", end_date: "2026-11-01" } },
			session,
		);
		assert.equal(json.result.isError, true);
		assert.match(json.result.content[0].text, /max is 92/);
	});

	await step("summarize_activities splits into 92-day chunks, pages within them, returns only aggregates", async () => {
		const before = garminCalls.length;
		const { json } = await mcp(
			accessToken,
			"tools/call",
			{
				name: "summarize_activities",
				arguments: { start_date: "2026-05-01", end_date: "2026-10-06", activity_type: "running" },
			},
			session,
		);
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		const text = json.result.content[0].text;
		const out = JSON.parse(text);
		assert.equal(out.activities, 150);
		assert.equal(out.groups[0].distance_km, 750);
		assert.equal(out.groups[0].avg_pace_per_km, "5:00");
		assert.ok(text.length < 1000, `summary is ${text.length} chars`);
		const pages = garminCalls.slice(before).filter((c) => c.includes("search/activities"));
		// 2026-05-01..07-31 holds all 150 runs (two pages); 08-01..10-06 is empty (one page).
		assert.equal(pages.length, 3, pages.join("\n"));
		const first = pages.filter((p) => p.includes("startDate=2026-05-01&endDate=2026-07-31"));
		assert.equal(first.length, 2, pages.join("\n"));
		assert.ok(first.every((p) => p.includes("activityType=running")), first[0]);
		assert.ok(pages.some((p) => p.includes("startDate=2026-08-01&endDate=2026-10-06")), pages.join("\n"));
	});

	await step("open-ended activity searches are never served from cache", async () => {
		const args = { name: "search_activities", arguments: { start_date: "2026-01-01", limit: 5 } };
		const before = garminCalls.length;
		await mcp(accessToken, "tools/call", args, session);
		await mcp(accessToken, "tools/call", args, session);
		const searches = garminCalls.slice(before).filter((c) => c.includes("search/activities"));
		assert.equal(searches.length, 2, "both calls reach Garmin");
	});

	await step("get_readiness pages past 100 activities for training load", async () => {
		const before = garminCalls.length;
		const { json } = await mcp(accessToken, "tools/call", { name: "get_readiness", arguments: { date: "2026-07-20" } }, session);
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		const r = JSON.parse(json.result.content[0].text);
		assert.equal(r.training_load.activities_counted, 150);
		assert.equal(garminCalls.slice(before).filter((c) => c.includes("search/activities")).length, 2);
	});

	await step("search_activities returns compact rows by default", async () => {
		const { json } = await mcp(
			accessToken,
			"tools/call",
			{ name: "search_activities", arguments: { activity_type: "running", limit: 5 } },
			session,
		);
		const rows = JSON.parse(json.result.content[0].text);
		assert.equal(rows.length, 5);
		assert.equal(rows[0].type, "running");
		assert.ok(!("field0" in rows[0]), "bulk fields stripped");
	});

	await step("long sleep ranges are split to Garmin's 31-day limit and come back compact", async () => {
		const before = garminCalls.length;
		const { json } = await mcp(
			accessToken,
			"tools/call",
			{ name: "get_sleep_summaries", arguments: { start_date: "2026-06-01", end_date: "2026-07-30" } },
			session,
		);
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		const nights = JSON.parse(json.result.content[0].text);
		assert.equal(nights.length, 60);
		assert.deepEqual(nights[0], {
			date: "2026-06-01",
			dow: "mon",
			start_local: "2026-05-31 23:00",
			sleep_h: 7.5,
			deep_h: 1.5,
			score: 80,
			score_quality: "GOOD",
		});
		assert.equal(garminCalls.slice(before).filter((c) => c.includes("dailySleepSummariesByDate")).length, 2);
	});

	await step("past-date responses are served from cache on repeat", async () => {
		const args = { name: "get_sleep_summaries", arguments: { start_date: "2026-06-01", end_date: "2026-07-30" } };
		const before = garminCalls.length;
		const { json } = await mcp(accessToken, "tools/call", args, session);
		assert.equal(JSON.parse(json.result.content[0].text).length, 60);
		assert.equal(garminCalls.length, before, "no Garmin calls on a cache hit");
	});

	await step("summarize_wellness returns a year of trends in one small response", async () => {
		const { json } = await mcp(
			accessToken,
			"tools/call",
			{ name: "summarize_wellness", arguments: { start_date: "2025-07-01", end_date: "2026-06-30" } },
			session,
		);
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		const text = json.result.content[0].text;
		const out = JSON.parse(text);
		assert.equal(out.groups.length, 12);
		assert.equal(out.groups[0].sleep_h, 7.5);
		assert.equal(out.groups[0].resting_hr, 50);
		assert.equal(out.groups[0].hrv_overnight, 45);
		assert.ok(text.length < 8000, `summary is ${text.length} chars`);
	});

	await step("get_readiness combines sleep, HRV, HR and recent training in one call", async () => {
		const { json } = await mcp(
			accessToken,
			"tools/call",
			{ name: "get_readiness", arguments: { date: "2026-11-05" } },
			session,
		);
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		const r = JSON.parse(json.result.content[0].text);
		assert.equal(r.sleep.score, 80);
		assert.equal(r.hrv.last_night, 45);
		assert.equal(r.resting_hr, 50);
		assert.equal(r.prior_days_compared, 7);
		assert.ok(Array.isArray(r.recent_activities) || r.recent_activities === "none in the last 3 days");
	});

	await step("get_readiness returns what it can when one source fails", async () => {
		const { json } = await mcp(accessToken, "tools/call", { name: "get_readiness", arguments: { date: "2026-10-15" } }, session);
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		const r = JSON.parse(json.result.content[0].text);
		assert.equal(r.sleep.score, 80);
		assert.equal(r.resting_hr, 50);
		assert.match(r.hrv, /no HRV/);
		assert.equal(r.unavailable.length, 1);
		assert.match(r.unavailable[0], /^hrv: .*HTTP 500/);
		assert.ok(r.training_load, "training load computed");
	});

	await step("named periods resolve in the user's Garmin time zone", async () => {
		const { json } = await mcp(
			accessToken,
			"tools/call",
			{ name: "get_daily_summaries", arguments: { period: "yesterday" } },
			session,
		);
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		const rows = JSON.parse(json.result.content[0].text);
		// Kiritimati is UTC+14, so its "yesterday" is UTC's today or yesterday depending on the hour.
		const kiri = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati" }).format(new Date());
		const d = new Date(`${kiri}T00:00:00Z`);
		d.setUTCDate(d.getUTCDate() - 1);
		assert.equal(rows[0].date, d.toISOString().slice(0, 10));
		// The zone comes from the profile settings (fetched once per session, and
		// possibly already by an earlier tool that formats local times).
		assert.ok(garminCalls.some((c) => c.startsWith("/userprofile-service/userprofile/settings")));
	});

	await step("summary tools read a bare start_date as 'since', ending today in the user's time zone", async () => {
		const kiri = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati" }).format(new Date());
		const d = new Date(`${kiri}T00:00:00Z`);
		d.setUTCDate(d.getUTCDate() - 20);
		const start = d.toISOString().slice(0, 10);
		for (const name of ["summarize_activities", "summarize_wellness"]) {
			const { json } = await mcp(accessToken, "tools/call", { name, arguments: { start_date: start } }, session);
			assert.ok(!json.result.isError, json.result.content?.[0]?.text);
			const out = JSON.parse(json.result.content[0].text);
			assert.equal(out.start_date, start, name);
			assert.equal(out.end_date, kiri, name);
		}
	});

	await step("compare_activities returns compact rows and notes the missing one", async () => {
		const { json } = await mcp(
			accessToken,
			"tools/call",
			{ name: "compare_activities", arguments: { activity_ids: ["11", "12", "404"] } },
			session,
		);
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		const text = json.result.content[0].text;
		const r = JSON.parse(text);
		assert.deepEqual(
			r.activities.map((a) => [a.activityId, a.pace_per_km]),
			[
				[11, "5:00"],
				[12, "5:00"],
			],
		);
		assert.match(r.unavailable[0], /activity 404/);
		assert.ok(!text.includes("metadataDTO"));
	});

	await step("activity details are cached, so a follow-up get_activity skips Garmin", async () => {
		const before = garminCalls.length;
		const { json } = await mcp(accessToken, "tools/call", { name: "get_activity", arguments: { activity_id: "11" } }, session);
		assert.equal(JSON.parse(json.result.content[0].text).activityId, 11);
		assert.equal(garminCalls.length, before, "served from the cache filled by compare_activities");
	});

	await step("search_activities passes name, duration, elevation and area filters in Garmin's units", async () => {
		const before = garminCalls.length;
		const { json } = await mcp(
			accessToken,
			"tools/call",
			{
				name: "search_activities",
				arguments: {
					name_contains: "park run",
					min_duration_min: 20,
					max_elevation_gain_m: 50,
					exclude_children: true,
					area: { north: 51.6, south: 51.4, west: -0.3, east: 0.1 },
					limit: 5,
				},
			},
			session,
		);
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		const call = new URL(`http://x${garminCalls.slice(before).find((c) => c.includes("search/activities"))}`);
		const p = Object.fromEntries(call.searchParams);
		assert.equal(p.search, "park run");
		assert.equal(p.minDuration, "1200");
		assert.equal(p.maxElevation, "50");
		assert.equal(p.excludeChildren, "true");
		assert.deepEqual([p.upperLatitude, p.lowerLatitude, p.leftLongitude, p.rightLongitude], ["51.6", "51.4", "-0.3", "0.1"]);
	});

	await step("get_activity_analysis unzips and decodes the FIT file in the Worker, then caches the result", async () => {
		const call = () =>
			mcp(accessToken, "tools/call", { name: "get_activity_analysis", arguments: { activity_id: "77" } }, session);
		const before = garminCalls.length;
		const { json } = await call();
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		const r = JSON.parse(json.result.content[0].text);
		assert.deepEqual(
			r.splits.map((s) => [s.split, s.time, s.pace]),
			[
				["1", "4:10", "4:10 /km"],
				["2", "4:10", "4:10 /km"],
				["last 0.5 km", "2:05", "4:10 /km"],
			],
		);
		assert.equal(r.best_efforts[0].time, "4:10");
		assert.equal(r.hr_zones.zones.find((z) => z.zone === 3).pct, 100); // HR 140-150 vs zone 3 = 140-159
		assert.ok(garminCalls.slice(before).some((c) => c.startsWith("/download-service/files/activity/77")));

		const mid = garminCalls.length;
		await call();
		assert.ok(
			!garminCalls.slice(mid).some((c) => c.startsWith("/download-service")),
			"second call is served from the cached analysis",
		);

		const missing = await mcp(accessToken, "tools/call", { name: "get_activity_analysis", arguments: { activity_id: "404" } }, session);
		assert.ok(!missing.json.result.isError);
		assert.match(JSON.parse(missing.json.result.content[0].text).unavailable, /no original file/);
	});

	await step("get_personal_bests in the Worker downloads at most 15 files per call and says the rest come next call", async () => {
		const before = garminCalls.length;
		const { json } = await mcp(
			accessToken,
			"tools/call",
			{ name: "get_personal_bests", arguments: { start_date: "2026-07-01", end_date: "2026-07-31", distances: ["1 km"] } },
			session,
		);
		assert.ok(!json.result.isError, json.result.content?.[0]?.text);
		const r = JSON.parse(json.result.content[0].text);
		const downloads = garminCalls.slice(before).filter((c) => c.startsWith("/download-service"));
		assert.equal(downloads.length, 15, "Cloudflare's free plan allows 50 outbound requests per request");
		// Activity 77 was analysed (and cached) by the previous step, so it comes free.
		assert.equal(r.activities_analysed, 16);
		assert.equal(r.personal_bests[0].time, "4:10");
		assert.ok(r.notes.some((n) => /134 of 150 activities weren't analysed yet/.test(n)), r.notes.join("\n"));
	});

	await step("prompt templates are listed", async () => {
		const { json } = await mcp(accessToken, "prompts/list", {}, session);
		const names = json.result.prompts.map((p) => p.name);
		for (const n of ["readiness_check", "sleep_report", "training_review", "weekly_checkin", "compare_recent"]) {
			assert.ok(names.includes(n), `missing prompt ${n}`);
		}
		const got = await mcp(accessToken, "prompts/get", { name: "training_review", arguments: { activity_type: "cycling" } }, session);
		assert.match(got.json.result.messages[0].content.text, /activity_type 'cycling'/);
	});

	await step("existing tokens stop working if ALLOWED_GITHUB_USER_ID changes", async () => {
		await mf.setOptions({ ...mfOptions, bindings: { ...mfOptions.bindings, ALLOWED_GITHUB_USER_ID: "42" } });
		const res = await fetchW("/mcp", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
		});
		// 403 from our check; 401 would mean storage was reset, which proves nothing.
		assert.equal(res.status, 403, `got ${res.status}`);
		await mf.setOptions(mfOptions);
	});

	await step("requests without a valid token are rejected", async () => {
		const res = await fetchW("/mcp", {
			method: "POST",
			headers: { Authorization: "Bearer nope:nope:nope", "Content-Type": "application/json" },
			body: "{}",
		});
		assert.equal(res.status, 401);
	});
} finally {
	await mf.dispose();
	console.log(results.join("\n"));
}
