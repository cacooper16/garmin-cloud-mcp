/**
 * The public URL MCP clients connect to, which every OAuth token is bound to
 * (RFC 9728 resource): MCP_RESOURCE when set (an override, e.g. to pin a
 * custom domain), else this request's own origin + /mcp. Cloudflare only
 * routes hostnames configured for this Worker to it, so a client can't point
 * the origin somewhere else.
 */
export function mcpResource(request: Request, bindings: { MCP_RESOURCE?: string }): string {
	const configured = bindings.MCP_RESOURCE?.trim();
	return configured || `${new URL(request.url).origin}/mcp`;
}
