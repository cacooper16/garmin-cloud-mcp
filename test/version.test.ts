import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { SERVER_VERSION } from "../src/server.ts";

it("server version matches package.json", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(SERVER_VERSION, pkg.version, "bump SERVER_VERSION in src/server.ts along with package.json");
});
