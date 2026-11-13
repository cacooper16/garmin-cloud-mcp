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

/** A connected in-memory client for createGarminServer; `request` sends one JSON-RPC call. */
async function connect() {
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
	return { request, close: () => server.close() };
}

/** Lists the tools and prompts createGarminServer registers. */
async function listRegistered() {
	const c = await connect();
	const tools = (await c.request("tools/list")).result.tools;
	const prompts = (await c.request("prompts/list")).result.prompts;
	await c.close();
	return { tools, prompts };
}

/**
 * Claude Desktop's prompt check, written out independently of src/prompts.ts:
 * ${arguments.x} becomes the supplied value ("" if undefined), or stays as it
 * is when x wasn't supplied; the served messages' text, joined with "\n" and
 * trimmed, must equal the result exactly.
 */
function desktopExpected(text: string, args: Record<string, unknown>): string {
	return text.replace(/\$\{arguments\.(\w+)\}/g, (m, n) => (n in args ? (args[n] === undefined ? "" : String(args[n])) : m));
}
const served = (result: { messages: { content: { type: string; text?: string } }[] }) =>
	result.messages
		.map((m) => (m.content?.type === "text" ? m.content.text : null))
		.filter((t) => t !== null)
		.join("\n")
		.trim();

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

describe("mcpb prompts (Claude Desktop rejects any mismatch)", () => {
	const samples = [
		{ period: "last 30 days", activity_type: "running" },
		{ period: "this_year", activity_type: "cycling" },
		{ period: "", activity_type: "" },
		{ period: "${arguments.period} 'quoted' $& $1", activity_type: "trail running" },
	];

	for (const p of manifest.prompts as { name: string; text: string; arguments?: string[] }[]) {
		it(`${p.name}: the server's text equals the manifest text after substitution`, async () => {
			const c = await connect();
			try {
				for (const sample of samples) {
					const args = Object.fromEntries((p.arguments ?? []).map((a) => [a, (sample as Record<string, string>)[a]]));
					const res = await c.request("prompts/get", { name: p.name, arguments: args });
					assert.ok(res.result, `${p.name}: ${JSON.stringify(res.error)}`);
					assert.equal(served(res.result), desktopExpected(p.text, args), `${p.name} with ${JSON.stringify(args)}`);
				}
			} finally {
				await c.close();
			}
		});
	}

	it("every manifest prompt uses all its declared arguments and no others, with no surrounding whitespace", () => {
		for (const p of manifest.prompts as { name: string; text: string; arguments?: string[] }[]) {
			const used = [...p.text.matchAll(/\$\{arguments\.(\w+)\}/g)].map((m) => m[1]).sort();
			assert.deepEqual([...new Set(used)], [...(p.arguments ?? [])].sort(), p.name);
			assert.equal(p.text, p.text.trim(), `${p.name} text must not start or end with whitespace`);
		}
	});

	it("declares every prompt argument as required, so the placeholder is always filled", async () => {
		const { prompts } = await listRegistered();
		for (const p of prompts as { name: string; arguments?: { name: string; required?: boolean }[] }[]) {
			for (const a of p.arguments ?? []) assert.equal(a.required, true, `${p.name}.${a.name}`);
		}
	});

	it("the committed manifest matches src/prompts.ts (run npm run sync:prompts)", () => {
		execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/sync-manifest-prompts.mjs", "--check"], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
		});
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

	it("serves every tool and prompt from the single bundled file", async () => {
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

		assert.equal((await client.request("tools/list")).result.tools.length, manifest.tools.length);
		assert.equal((await client.request("prompts/list")).result.prompts.length, manifest.prompts.length);
	});
});
