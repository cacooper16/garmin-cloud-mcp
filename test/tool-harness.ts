import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { _resetCachesForTests, GarminClient, type KVLike } from "../src/garmin.ts";
import { MemoryKV } from "../src/memory-kv.ts";
import { createGarminServer } from "../src/server.ts";
import type { ToolOptions } from "../src/tools.ts";

/**
 * Calls one tool on an in-process server whose Garmin is faked at the fetch
 * layer (the token exchange and profile settings are answered here: UTC,
 * metric). Returns the parsed JSON result; fails the test on a tool error.
 */
export async function callGarminTool(
	name: string,
	fetch: (url: URL) => Response | Promise<Response>,
	args: object,
	options: ToolOptions = {},
	/** Pass the same KV to several calls to keep the cache between them, as a real server does. */
	kv: KVLike = new MemoryKV(),
): Promise<any> {
	_resetCachesForTests();
	const jwt = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url")}.s`;
	const client = new GarminClient({
		apiKey: "k",
		kv,
		fetch: async (input) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/token")) return new Response(jwt);
			if (url.pathname === "/userprofile-service/userprofile/settings") {
				return Response.json({ timeZone: "UTC", measurementSystem: "metric" });
			}
			return fetch(url);
		},
	});
	const server = createGarminServer(() => client, options);
	const [c, s] = InMemoryTransport.createLinkedPair();
	const pending = new Map<number, (m: any) => void>();
	c.onmessage = (m: any) => pending.get(m.id)?.(m);
	await server.connect(s);
	await c.start();
	let id = 0;
	const req = (method: string, params: object) =>
		new Promise<any>((resolve) => {
			pending.set(++id, resolve);
			void c.send({ jsonrpc: "2.0", id, method, params });
		});
	await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
	const res = await req("tools/call", { name, arguments: args });
	await server.close();
	assert.ok(!res.result.isError, res.result.content[0].text);
	return JSON.parse(res.result.content[0].text);
}
