#!/usr/bin/env node
// Local entrypoint: the same tools and prompts as the Worker, over stdio.
// Published to npm as garmin-mcp (built to dist/stdio.js by `npm run build`):
//
//   GARMIN_API_KEY=... npx -y garmin-mcp
//
// From source, for development:
//
//   GARMIN_API_KEY=... npm run stdio
//
// There's no network listener, so no sign-in: only the process that started
// this one can talk to it. Never expose it over HTTP; use the Worker for that.
//
// stdout carries the MCP protocol. Log to stderr only.
//
// The npm package installs only "@modelcontextprotocol/server" and "zod", so
// don't import anything that pulls in agents, hono, the OAuth provider or
// "cloudflare:workers". test/pack.test.ts checks this.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createLocalKV } from "./file-kv.ts";
import { GarminClient } from "./garmin.ts";
import { detectInstall } from "./install.ts";
import { createGarminServer, SERVER_VERSION } from "./server.ts";
import { optedOut, UpdateCheck } from "./update.ts";

const apiKey = process.env.GARMIN_API_KEY ?? "";
if (!apiKey.trim()) {
	console.error(
		"garmin-mcp: GARMIN_API_KEY is not set. Tools will fail until it is; set it in your MCP client's config.",
	);
}

// Derived data (analyses, settled past-date responses) is cached on disk so it
// survives restarts; the bearer token is only ever held in memory.
const { kv, dir } = createLocalKV(process.env);

// Update notice: a daily, background download of a small version file from
// GitHub (see update.ts). Off with GARMIN_MCP_NO_UPDATE_CHECK=1, and skipped
// when running from a source checkout.
const install = await detectInstall(process.env, process.argv[1] ?? "", SERVER_VERSION).catch(() => undefined);
const update =
	install && !optedOut(process.env.GARMIN_MCP_NO_UPDATE_CHECK)
		? new UpdateCheck({ current: SERVER_VERSION, install, kv })
		: undefined;
await update?.load();

const server = createGarminServer(() => new GarminClient({ apiKey, kv, cacheResponses: true }), { update });
await server.connect(new StdioServerTransport());
void update?.refresh();
console.error(`garmin-mcp: running on stdio (${dir ? `cache: ${dir}` : "cache in memory only"})`);
