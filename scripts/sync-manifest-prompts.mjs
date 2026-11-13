#!/usr/bin/env node
// Copies the prompts from src/prompts.ts (the single source of truth) into
// mcpb/manifest.json. Claude Desktop rejects any prompt whose served text
// doesn't exactly match the manifest's `text` after argument substitution,
// so the two must never be edited separately. Runs as part of build:mcpb;
// test/mcpb.test.ts fails if the committed manifest is out of date.
//
//   node --experimental-strip-types scripts/sync-manifest-prompts.mjs [--check]
//
// Only the "prompts" array is rewritten; the rest of the file is left as is.
import { readFileSync, writeFileSync } from "node:fs";
import { PROMPTS } from "../src/prompts.ts";

const path = new URL("../mcpb/manifest.json", import.meta.url);

/** The manifest's prompts array, generated from src/prompts.ts. */
export function manifestPrompts() {
	return PROMPTS.map((p) => ({
		name: p.name,
		description: p.description,
		...(p.arguments.length ? { arguments: p.arguments.map((a) => a.name) } : {}),
		text: p.template,
	}));
}

/** Index just past the value that starts at `i` (an array or object), skipping strings. */
function endOfValue(text, i) {
	let depth = 0;
	for (; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			for (i++; text[i] !== '"'; i++) if (text[i] === "\\") i++;
		} else if (c === "[" || c === "{") depth++;
		else if (c === "]" || c === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	throw new Error("unterminated value in mcpb/manifest.json");
}

export function syncedManifest(text) {
	const key = text.indexOf('\n\t"prompts": [');
	if (key < 0) throw new Error('mcpb/manifest.json has no top-level "prompts" array');
	const start = text.indexOf("[", key);
	const end = endOfValue(text, start);
	const block = JSON.stringify(manifestPrompts(), null, "\t")
		// Argument lists on one line, as hand-written manifests have them.
		.replace(/"arguments": \[([^\]]*)\]/g, (_, list) => `"arguments": [${list.trim().split(/,\s*/).join(", ")}]`)
		.replace(/\n/g, "\n\t");
	return text.slice(0, start) + block + text.slice(end);
}

const current = readFileSync(path, "utf8");
const next = syncedManifest(current);
if (process.argv.includes("--check")) {
	if (next !== current) {
		console.error("mcpb/manifest.json prompts are out of date: run npm run sync:prompts");
		process.exit(1);
	}
} else if (next !== current) {
	writeFileSync(path, next);
	console.log("Updated the prompts in mcpb/manifest.json from src/prompts.ts.");
}
