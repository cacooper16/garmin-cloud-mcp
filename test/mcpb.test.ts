// Claude Desktop extension (mcpb/): the manifest must advertise exactly what
// the server registers, and the bundled server must run on its own.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createGarminServer } from "../src/server.ts";
import { StdioClient } from "./stdio-client.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "mcpb/manifest.json"), "utf8"));

const names = (items: { name: string }[]) => items.map((i) => i.name).sort();

/** Lists the tools and prompts createGarminServer registers, over an in-memory transport. */
async function listRegistered() {
	const server = createGarminServer(() => {
		throw new Error("listing must not need a Garmin client");
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const pending = new Map<number, (msg: any) => void>();
	clientSide.onmessage = (msg: any) => pending.get(msg.id)?.(msg);
	await server.connect(serverSide);
	await clientSide.start();

	let nextId = 1;
	const request = (method: string, params: object = {}) =>
		new Promise<any>((resolve) => {
			const id = nextId++;
			pending.set(id, resolve);
			void clientSide.send({ jsonrpc: "2.0", id, method, params });
		});

	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "mcpb-test", version: "1.0.0" },
	});
	await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	const tools = (await request("tools/list")).result.tools;
	const prompts = (await request("prompts/list")).result.prompts;
	await server.close();
	return { tools, prompts };
}

describe("mcpb manifest", () => {
	it("lists exactly the tools and prompts the server registers", async () => {
		const { tools, prompts } = await listRegistered();
		assert.deepEqual(names(manifest.tools), names(tools), "mcpb/manifest.json tools are out of sync with src/tools.ts");
		assert.deepEqual(names(manifest.prompts), names(prompts), "mcpb/manifest.json prompts are out of sync with src/prompts.ts");

		// Prompt arguments too, since the manifest's prompt text refers to them.
		for (const p of prompts as { name: string; arguments?: { name: string }[] }[]) {
			const listed = manifest.prompts.find((m: { name: string }) => m.name === p.name);
			assert.deepEqual(
				[...(listed.arguments ?? [])].sort(),
				names(p.arguments ?? []),
				`mcpb/manifest.json arguments for prompt ${p.name}`,
			);
		}
	});
});

describe("mcpb bundle", { timeout: 120_000 }, () => {
	let client: StdioClient;

	before(() => {
		execFileSync("npm", ["run", "build:mcpb"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
	});

	after(() => client?.close());

	it("packs garmin-mcp.mcpb", () => {
		assert.ok(statSync(join(root, "garmin-mcp.mcpb")).size > 0);
		assert.ok(existsSync(join(root, "mcpb/server/index.js")));
	});

	it("serves 26 tools and 5 prompts from the single bundled file", async () => {
		// StdioClient passes only PATH and GARMIN_API_KEY=dummy, and the bundle
		// sits outside node_modules: proves nothing else is needed at runtime.
		client = new StdioClient(process.execPath, ["mcpb/server/index.js"], root);
		const init = await client.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "mcpb-test", version: "1.0.0" },
		});
		assert.equal(init.result?.serverInfo?.version, manifest.version);
		client.notify("notifications/initialized");

		assert.equal((await client.request("tools/list")).result.tools.length, 26);
		assert.equal((await client.request("prompts/list")).result.prompts.length, 5);
	});
});
