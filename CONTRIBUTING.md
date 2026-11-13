# Contributing to garmin-mcp

How to work on garmin-mcp: running the tests, finding your way around the
code, reporting problems and cutting a release.

## Reporting issues

Open an issue on GitHub and include:

- what you asked your AI app (or which tool you called, with its arguments);
- what came back, and what you expected;
- whether asking again with `detail: "full"` shows the missing field. If it
  does, the compact shape is dropping it; if it doesn't, Garmin isn't sending
  it for your device.

Never paste your Garmin key, bearer tokens or `.dev.vars` into an issue. Found
a security problem? Report it privately through GitHub's
[**Security → Report a vulnerability**](https://github.com/colincooperio/garmin-mcp/security/advisories/new)
on this repo rather than opening an issue. See [SECURITY.md](SECURITY.md).

## Development

```sh
npm test           # unit tests, including the stdio server, the npm package and the Claude Desktop extension
npm run test:e2e   # the real Worker in Miniflare, full OAuth + MCP flow, GitHub and Garmin faked
npm run check      # type-check + both of the above; runs before every deploy and in CI
npm run stdio      # the local stdio server (needs GARMIN_API_KEY in the environment)
npm run build      # compile the stdio server to dist/ (what's published to npm as garmin-mcp)
npm run build:mcpb # bundle it into one file and pack the Claude Desktop extension, garmin-mcp.mcpb
npm run test:pack  # pack, install the tarball in a temp project and run its bin (also part of npm test)
npm run dev        # the Worker on :8788 (needs .dev.vars, see .dev.vars.example)
npm run setup      # interactive first-time cloud setup (scripts/setup.mjs)
npm run update     # update an existing cloud deployment (scripts/update.mjs)
```

`scripts/setup.mjs` and `scripts/update.mjs` share `scripts/lib.mjs`. They
take their command runner, prompts and files as arguments, so
`test/setup.test.ts` drives them with fake wrangler, git and npm output.

The tests and type-check use `wrangler.example.jsonc`, so they run without a
Cloudflare account or your own config.

The tools and prompts live in `src/server.ts`, shared by the Worker
(`src/index.ts`) and the local server (`src/stdio.ts`). Field names come from
Garmin's Personal API spec, but check formats against real responses: the
spec documents some epoch-millisecond fields as date strings, and Garmin's
"local" times are an hour out on DST nights. If a value comes back empty for
your device, compare with `detail: "full"`. The compact shapes live in
`src/compact.ts` and `src/activities.ts`; local-time handling is in
`src/times.ts`.

`npm audit` reports advisories in `undici` inside `miniflare@4`. That copy is
used only by the local test harness against fake servers and isn't part of
the deployed Worker. `npm audit --omit=dev` is clean.

## Releasing

1. Bump the version in `package.json`, `src/server.ts`, `server.json` (both
   places) and `mcpb/manifest.json`. The version-sync test fails if any of
   them disagree.
2. Commit and push.
3. Create a GitHub release with the tag `vX.Y.Z`. Start the release notes
   with a line for people running the cloud version, **Cloud: action
   needed?**, saying either exactly what to do (for example a new setting to
   copy from `wrangler.example.jsonc`, or a new secret to store) or "No: run
   `npm run update`." Cloud users get release emails when they watch the repo,
   so this line is what they act on.

Publishing the release runs `.github/workflows/release.yml`. It checks the tag
matches every version, runs `npm run check`, publishes to npm (with
provenance) and the MCP Registry, and attaches `garmin-mcp.mcpb`, with a signed build attestation, to the
release. It needs no tokens: npm and the MCP Registry both authenticate with
GitHub's OIDC token.

One-time setup: on npmjs.com, open the `garmin-mcp` package's settings and add
a trusted publisher for GitHub Actions with this repository and the workflow
filename `release.yml`.
