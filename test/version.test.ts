import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { SERVER_VERSION } from "../src/server.ts";

const read = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));

it("versions match across package.json, server.json, mcpb/manifest.json and src/server.ts", () => {
	const pkg = read("package.json");
	const registry = read("server.json");
	const manifest = read("mcpb/manifest.json");
	assert.equal(SERVER_VERSION, pkg.version, "bump SERVER_VERSION in src/server.ts along with package.json");
	assert.equal(registry.version, pkg.version, "bump server.json version along with package.json");
	assert.equal(registry.packages[0].version, pkg.version, "bump server.json packages[0].version along with package.json");
	assert.equal(manifest.version, pkg.version, "bump mcpb/manifest.json version along with package.json");
});

it("server.json matches the npm package and the registry's limits", () => {
	const pkg = read("package.json");
	const registry = read("server.json");
	assert.equal(registry.name, pkg.mcpName, "server.json name must equal package.json mcpName");
	assert.equal(registry.packages[0].identifier, pkg.name);
	assert.ok(registry.description.length <= 100, `description is ${registry.description.length} chars; max 100`);
});
