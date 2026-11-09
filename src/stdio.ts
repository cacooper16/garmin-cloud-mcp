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
import { GarminClient } from "./garmin.ts";
import { MemoryKV } from "./memory-kv.ts";
import { createGarminServer } from "./server.ts";

// tsconfig loads Worker types only; this is all we need from Node.
declare const process: { env: Record<string, string | undefined> };

const apiKey = process.env.GARMIN_API_KEY ?? "";
if (!apiKey.trim()) {
	console.error(
		"garmin-mcp: GARMIN_API_KEY is not set. Tools will fail until it is; set it in your MCP client's config.",
	);
}

const kv = new MemoryKV();
const server = createGarminServer(() => new GarminClient({ apiKey, kv, cacheResponses: true }));
await server.connect(new StdioServerTransport());
console.error("garmin-mcp: running on stdio");
