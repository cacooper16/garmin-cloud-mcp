// Packaging smoke test: build, `npm pack`, install the tarball into an empty
// project and run its `garmin-mcp` bin. Proves the published package works
// without the repo, the TypeScript sources or any devDependency.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { StdioClient } from "./stdio-client.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
/** The manifest lists every tool (test/mcpb.test.ts checks it against the server). */
const TOOL_COUNT: number = JSON.parse(readFileSync(join(root, "mcpb/manifest.json"), "utf8")).tools.length;

function npm(args: string[], cwd: string): string {
	return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * The tarball name from `npm pack --json`. npm 11 and earlier print an array
 * of packed packages; npm 12 prints an object keyed by package name.
 */
function packedFilename(json: string): string {
	const parsed: unknown = JSON.parse(json);
	const entry = Array.isArray(parsed)
		? parsed[0]
		: parsed && typeof parsed === "object"
			? ((parsed as Record<string, unknown>)[pkg.name] ?? Object.values(parsed)[0])
			: undefined;
	const filename = (entry as { filename?: unknown } | undefined)?.filename;
	if (typeof filename !== "string") {
		throw new Error(`Unexpected \`npm pack --json\` output (expected an array or an object of packages with .filename): ${json.slice(0, 300)}`);
	}
	return filename;
}

describe("npm package", { timeout: 180_000 }, () => {
	let tmp: string;
	let project: string;
	let client: StdioClient;

	before(() => {
		tmp = mkdtempSync(join(tmpdir(), "garmin-mcp-pack-"));
		npm(["run", "build"], root);
		const tarball = join(tmp, packedFilename(npm(["pack", "--json", "--pack-destination", tmp], root)));

		project = join(tmp, "project");
		execFileSync("mkdir", [project]);
		writeFileSync(join(project, "package.json"), JSON.stringify({ name: "pack-test", private: true }));
		npm(["install", "--no-audit", "--no-fund", "--prefer-offline", tarball], project);
	});

	after(async () => {
		await client?.close();
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	it("installs only the runtime dependencies", () => {
		const nm = join(project, "node_modules");
		assert.ok(existsSync(join(nm, "@modelcontextprotocol/server")));
		assert.ok(existsSync(join(nm, "zod")));
		for (const dev of ["agents", "hono", "@cloudflare/workers-oauth-provider", "wrangler", "typescript"]) {
			assert.ok(!existsSync(join(nm, dev)), `${dev} should not be installed`);
		}
		const files = join(nm, "garmin-mcp/dist");
		for (const worker of ["index.js", "github-handler.js", "workers-oauth-utils.js"]) {
			assert.ok(!existsSync(join(files, worker)), `${worker} should not be published`);
		}
		assert.ok(!existsSync(join(nm, "garmin-mcp/src")), "sources should not be published");
	});

	it("serves every tool from the installed bin", async () => {
		client = new StdioClient(join(project, "node_modules/.bin/garmin-mcp"), [], project);
		const init = await client.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "pack-test", version: "1.0.0" },
		});
		assert.equal(init.result?.serverInfo?.name, "garmin");
		assert.equal(init.result?.serverInfo?.version, pkg.version);
		client.notify("notifications/initialized");

		const res = await client.request("tools/list");
		assert.equal(res.result.tools.length, TOOL_COUNT);
		assert.match(client.stderr, /garmin-mcp: running on stdio/);
	});
});
