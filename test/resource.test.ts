import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpResource } from "../src/resource.ts";

describe("mcpResource", () => {
	const req = (url: string) => new Request(url);

	it("is the request's origin + /mcp when MCP_RESOURCE is unset", () => {
		assert.equal(mcpResource(req("https://garmin-cloud-mcp.someone.workers.dev/mcp"), {}), "https://garmin-cloud-mcp.someone.workers.dev/mcp");
		assert.equal(mcpResource(req("https://Garmin-Cloud-MCP.Someone.workers.dev/authorize?x=1"), {}), "https://garmin-cloud-mcp.someone.workers.dev/mcp");
		assert.equal(mcpResource(req("http://localhost:8788/.well-known/oauth-protected-resource"), { MCP_RESOURCE: "" }), "http://localhost:8788/mcp");
		assert.equal(mcpResource(req("https://garmin.example.com/mcp"), { MCP_RESOURCE: "  " }), "https://garmin.example.com/mcp");
	});

	it("uses MCP_RESOURCE as an override whatever host the request came in on", () => {
		const bindings = { MCP_RESOURCE: "https://garmin.example.com/mcp" };
		assert.equal(mcpResource(req("https://garmin-cloud-mcp.someone.workers.dev/mcp"), bindings), "https://garmin.example.com/mcp");
		assert.equal(mcpResource(req("https://garmin.example.com/token"), bindings), "https://garmin.example.com/mcp");
	});
});
