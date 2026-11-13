/// <reference types="node" />
/**
 * How the local server was started, for the update notice (see update.ts).
 *
 * - Claude Desktop extension: its manifest sets GARMIN_MCP_INSTALL=mcpb.
 * - npx: the script lives in npm's npx cache, ~/.npm/_npx/<hash>/node_modules/.
 *   npm names that folder after the first 16 hex characters of the SHA-512 of
 *   the package spec typed (libnpmexec), so hashing "garmin-mcp@<version>"
 *   recognises a run pinned to this version. Anything else there counts as
 *   unpinned.
 * - A global or other npm install: any other node_modules/garmin-mcp path.
 * - A source checkout (running src/*.ts or the repo's own dist/): no check.
 */
import type { Install } from "./update.ts";

const PKG = "garmin-mcp";

export async function npxHash(spec: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(spec));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/**
 * The install type, or undefined for a source checkout (which skips the check).
 *
 * npx is only treated as pinned when the cache folder's hash positively
 * matches "garmin-mcp@<this version>", the usual way to pin. Anything else
 * under npm's npx cache (a range such as @^1.3, several packages in one npx
 * call, a cache layout or hashing npm changes later, or an error working it
 * out) is treated as unpinned: counted, never shown a notice.
 */
export async function detectInstall(env: Record<string, string | undefined>, scriptPath: string, current: string): Promise<Install | undefined> {
	if (env.GARMIN_MCP_INSTALL === "mcpb") return { type: "mcpb" };
	const path = scriptPath.replace(/\\/g, "/");
	if (/\/_npx\//.test(path)) {
		const exact = `${PKG}@${current}`;
		const hash = path.match(/\/_npx\/([0-9a-f]+)\//)?.[1];
		try {
			if (hash && (await npxHash(exact)) === hash) return { type: "npx", pinned: true, spec: exact };
		} catch {
			// Can't tell: fall through to unpinned.
		}
		return { type: "npx", pinned: false };
	}
	if (path.includes("/node_modules/garmin-mcp/")) return { type: "global" };
	return undefined;
}
