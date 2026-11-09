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

function npm(args: string[], cwd: string): string {
	return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("npm package", { timeout: 180_000 }, () => {
	let tmp: string;
	let project: string;
	let client: StdioClient;

	before(() => {
		tmp = mkdtempSync(join(tmpdir(), "garmin-mcp-pack-"));
		npm(["run", "build"], root);
		const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", tmp], root));
		const tarball = join(tmp, packed.filename);

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

	it("serves all 26 tools from the installed bin", async () => {
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
		assert.equal(res.result.tools.length, 26);
		assert.match(client.stderr, /garmin-mcp: running on stdio/);
	});
});
