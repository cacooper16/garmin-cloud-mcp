import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MemoryKV } from "../src/memory-kv.ts";
import { StdioClient } from "./stdio-client.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("MemoryKV", () => {
	it("stores, returns and deletes values", async () => {
		const kv = new MemoryKV();
		assert.equal(await kv.get("a"), null);
		await kv.put("a", "1");
		assert.equal(await kv.get("a"), "1");
		await kv.put("a", "2");
		assert.equal(await kv.get("a"), "2");
		await kv.delete("a");
		assert.equal(await kv.get("a"), null);
		await kv.delete("missing"); // no-op
	});

	it("expires entries after expirationTtl seconds", async () => {
		let now = 1_000;
		const kv = new MemoryKV(() => now);
		await kv.put("ttl", "x", { expirationTtl: 60 });
		await kv.put("forever", "y");
		now += 59;
		assert.equal(await kv.get("ttl"), "x");
		now += 1;
		assert.equal(await kv.get("ttl"), null);
		now += 1_000_000;
		assert.equal(await kv.get("forever"), "y");
	});

	it("re-putting a key resets its TTL", async () => {
		let now = 0;
		const kv = new MemoryKV(() => now);
		await kv.put("k", "a", { expirationTtl: 10 });
		now = 8;
		await kv.put("k", "b", { expirationTtl: 10 });
		now = 15;
		assert.equal(await kv.get("k"), "b");
		await kv.put("k", "c");
		now = 1_000;
		assert.equal(await kv.get("k"), "c");
	});
});

describe("stdio server", () => {
	let client: StdioClient;

	before(async () => {
		client = new StdioClient(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/stdio.ts"], root);
		const init = await client.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "stdio-test", version: "1.0.0" },
		});
		assert.equal(init.result?.serverInfo?.name, "garmin");
		assert.equal(init.result?.serverInfo?.version, pkg.version);
		assert.ok(init.result?.instructions?.includes("Garmin"));
		client.notify("notifications/initialized");
	});

	after(() => client.close());

	it("lists 26 read-only tools", async () => {
		const res = await client.request("tools/list");
		const tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] = res.result.tools;
		assert.equal(tools.length, 26);
		for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, `${t.name} should be read-only`);
	});

	it("lists the prompts", async () => {
		const res = await client.request("prompts/list");
		assert.ok(res.result.prompts.length >= 5, `got ${res.result.prompts.length} prompts`);
	});

	it("returns a tool error for an over-long range and keeps serving", async () => {
		const res = await client.request("tools/call", {
			name: "get_stress",
			arguments: { start_date: "2025-01-01", end_date: "2026-11-01" },
		});
		assert.equal(res.result?.isError, true);

		const again = await client.request("tools/list");
		assert.equal(again.result.tools.length, 26);
	});
});
