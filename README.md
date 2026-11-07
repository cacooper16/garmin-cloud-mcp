# garmin-cloud-mcp

[![CI](https://github.com/cacooper16/garmin-cloud-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cacooper16/garmin-cloud-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A remote [MCP](https://modelcontextprotocol.io) server that gives your AI
assistant read-only access to your Garmin Connect data, using Garmin's official
[Personal API](https://developer.garmin.com/gc-developer-program/personal/).
It runs on your own Cloudflare account (the free plan is plenty) and sits
behind GitHub sign-in.

It's a standard MCP server with standard OAuth, so it works with any client
that supports remote MCP servers: Claude (web, desktop and phone), ChatGPT,
Claude Code, Cursor, VS Code and others.

Compared with a local MCP server or a third-party service, you get:

- **Insight, not another chart.** Ask a question and get an answer based on
  your own data.
- **Every device.** Works in your AI app on your phone, tablet and computer.
- **No middleman.** Data comes straight from Garmin's official API to a server
  on your own Cloudflare account. No third-party service stores it.
- **Always current, nothing to keep running.** It fetches from Garmin when you
  ask, so you don't need a computer left on or a sync to remember.
- **No extra cost.** Cloudflare's free plan covers the hosting, and it uses the
  AI subscription you already have.

Only use one computer, or want to try it first? It also runs as a local
process in Claude Code, Claude Desktop, Cursor or VS Code, with no Cloudflare
or GitHub setup. It takes about two minutes and needs just your Garmin key.
See [Running locally](#running-locally).

Ask things like:

- *"Am I ready to train hard today?"*
- *"How has my resting heart rate and HRV changed since May?"*
- *"What were my running totals and average pace each month this year?"*
- *"How much of my running is easy vs hard?"*
- *"Which day of the week do I sleep worst?"*
- *"Compare my last two long runs."*

> Not affiliated with or endorsed by Garmin. "Garmin" and "Garmin Connect" are
> trademarks of Garmin Ltd. or its subsidiaries.

## Why this one

### Compared with password-based Garmin MCP servers

Most Garmin MCP servers predate the Personal API. They log in with your Garmin
email and password and call Garmin Connect's private web endpoints, running on
your own machine.

| | Password-based, local | garmin-cloud-mcp |
|---|---|---|
| Garmin access | Your email + password, session tokens on disk | Official Personal API key, revocable, expires (30 days to 1 year) |
| Breaks when Garmin changes its login or MFA | Yes, regularly | No, it uses the documented API |
| Works in web and phone apps (Claude, ChatGPT) | No, only where the local process runs | Yes, it's a remote server |
| Who can use it | Anyone with access to your machine | Only your GitHub account |

The trade-off: the Personal API covers less. It has no golf scorecards,
training plans, Garmin Training Status, race predictions, gear, courses or
write access. The server tells the model this up front, so it says it isn't
available instead of hunting for it.

### Compared with a basic wrapper of the API

A one-tool-per-endpoint wrapper works, but it's slow and expensive in tokens:
Garmin returns 100+ fields per activity and a reading every two minutes for
heart rate. This server does the heavy lifting in the Worker:

- **Questions answered in one call.** `get_readiness`, `summarize_wellness` and
  `summarize_activities` fetch, join and aggregate in the server. Five months of
  runs comes back as about 1,000 characters instead of about 190,000.
- **Compact by default.** Readable units, flattened rows, hourly heart rate
  instead of every reading. Every tool has `detail: "full"` for the raw data.
- **Garmin's per-call limits handled.** Some endpoints only allow 28 or 31 days
  per request. Longer ranges are split and fetched in parallel, so the model
  makes one call, not four plus a failure.
- **Named periods in your time zone.** `last_30_days`, `this_week`, `last_month`,
  `today`, `yesterday` resolve using the time zone in your Garmin profile.
- **Partial results.** If one source fails (say HRV for a night), the rest still
  comes back with a short note, so the model doesn't retry everything.
- **Caching.** Data at least 3 days old has settled, so it's cached for 7 days,
  and activity details for a day. Follow-up questions skip Garmin.
- **Things Garmin's API doesn't give you directly:** training load
  (acute:chronic ratio), time in heart-rate zones, weekday patterns,
  distance-weighted pace, side-by-side activity comparison.
- **Prompt templates** for clients that support MCP prompts (such as Claude's
  connector menu): *Am I ready to train today?*, *Sleep report*, *Training
  review*, *Weekly check-in*, *Compare recent sessions*.

## How it works

```
MCP client ──OAuth──▶ Worker (/mcp) ──Bearer JWT──▶ Garmin Personal API
                         │
                         └─ /authorize ──▶ GitHub sign-in ──▶ allowed user ID? ──▶ token
```

Each person deploys their own copy to their own Cloudflare account. It's
locked to a single GitHub account, so your Garmin data is only ever reachable
by you.

## Two ways to run it

| | Cloud (recommended) | Local |
|---|---|---|
| Works on | Every device: web, desktop, phone | Desktop apps on one computer |
| Computer needs to be on | No | Yes |
| Setup | About 20 minutes: Cloudflare, GitHub OAuth app, four secrets | About 2 minutes: one Garmin key |
| Sign-in | GitHub OAuth, locked to your account | None needed; nothing listens on the network |
| Garmin key stored in | Cloudflare secrets | Your MCP client's config on that computer |
| Caching | Kept between sessions | Lasts only while the process runs |

Start local to try it, and move to cloud when you want it on your phone. The
tools are identical.

## Cloud setup

### What you need

- A Garmin Connect account and a Garmin device
- A Cloudflare account (free plan)
- A GitHub account
- Node 22 or newer
- About 20 minutes

Run all commands from the repo folder.

### 1. Install and log in to Cloudflare

```sh
git clone https://github.com/cacooper16/garmin-cloud-mcp.git
cd garmin-cloud-mcp
npm install
npx wrangler login
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc` is git-ignored, so your settings never get committed.

### 2. Create the KV namespace

```sh
npx wrangler kv namespace create OAUTH_KV
```

Paste the `id` it prints into `wrangler.jsonc`, replacing `YOUR_KV_NAMESPACE_ID`.

### 3. Lock it to your GitHub account

Open `https://api.github.com/users/<your-github-username>` and copy the numeric
`id`. Put it in `wrangler.jsonc` as `ALLOWED_GITHUB_USER_ID`.

It uses the numeric ID rather than your username because usernames can be
changed and then claimed by someone else.

### 4. Work out your Worker's URL

It will be `https://garmin-cloud-mcp.<your-subdomain>.workers.dev`. Your
`workers.dev` subdomain is on the Workers & Pages overview in the Cloudflare
dashboard.

Set `MCP_RESOURCE` in `wrangler.jsonc` to that URL with `/mcp` on the end.

### 5. Create a GitHub OAuth app

Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App and
fill in:

- **Homepage URL:** `https://garmin-cloud-mcp.<your-subdomain>.workers.dev`
- **Authorization callback URL:** `https://garmin-cloud-mcp.<your-subdomain>.workers.dev/callback`

Then generate a client secret.

### 6. Create a Garmin Personal API key

Go to [Garmin Connect → Personal API Token](https://connect.garmin.com/app/settings/personalApiToken)
→ Create Key. Pick 1 year and copy the key; Garmin shows it only once.

### 7. Store the secrets

Each command prompts you to paste the value.

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # paste output of: openssl rand -hex 32
npx wrangler secret put GARMIN_API_KEY
```

If wrangler asks to create the Worker first, say yes.

### 8. Deploy

```sh
npm run deploy
```

This type-checks and runs the full test suite before it deploys. If anything
fails, nothing ships. The test output includes a few labelled `expected` error
lines: those come from tests that check the Worker refuses bad requests.

### 9. Connect your AI client

Your server URL is `https://garmin-cloud-mcp.<your-subdomain>.workers.dev/mcp`.
Every client opens a GitHub sign-in the first time; sign in and approve.

- **Claude** (web, desktop, phone): Settings → Connectors → Add custom
  connector, and paste the URL. The connector follows your Claude account
  onto every device.
- **ChatGPT**: add it as a custom connector (MCP server) with OAuth
  authentication. Custom connectors need developer mode and depend on your
  plan; see OpenAI's help pages for the current steps.
- **Claude Code**: `claude mcp add --transport http garmin <url>`, then run
  `/mcp` to sign in.
- **Cursor, VS Code and other MCP clients**: add a remote (HTTP) MCP server
  with the URL. Clients that support MCP OAuth handle the sign-in themselves.

Try *"Am I ready to train today?"*. In clients that show MCP prompts, such
as Claude's connector menu, you can also pick a ready-made prompt.

## Running locally

The same server runs as a local process that your AI app starts and talks to
directly. There's no Cloudflare or GitHub setup.

### What you need

- Node 22 or newer
- A Garmin Personal API key (see
  [Create a Garmin Personal API key](#6-create-a-garmin-personal-api-key))

### Install

```sh
git clone https://github.com/cacooper16/garmin-cloud-mcp.git
cd garmin-cloud-mcp
npm ci --omit=dev
```

### Connect your AI client

**Claude Code** (run from the repo folder):

```sh
claude mcp add garmin --env GARMIN_API_KEY=<your key> -- node --experimental-strip-types --no-warnings "$(pwd)/src/stdio.ts"
```

**Claude Desktop, Cursor, VS Code and other clients:** add this to the
client's MCP config, using the full path to your copy of the repo:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "--no-warnings",
        "/absolute/path/to/garmin-cloud-mcp/src/stdio.ts"
      ],
      "env": {
        "GARMIN_API_KEY": "<your key>"
      }
    }
  }
}
```

VS Code's `mcp.json` uses `"servers"` instead of `"mcpServers"`.

Then try *"Am I ready to train today?"*.

**Security.** There's no sign-in because the process has no network listener:
only the app that started it can talk to it. Never wrap it in an HTTP proxy or
expose it on a network. For remote access, use the cloud version.

**Updating.** `git pull && npm ci --omit=dev`, then restart your AI app.

## Tools

All tools are read-only. Ranges can be up to 92 days (366 for the
`summarize_*` tools). Every range tool also takes `period`, and single-day
tools take `today` or `yesterday`. For the `summarize_*` tools, a `start_date`
on its own means "since then": the range ends today.

**Start here.** These answer common questions in one call with a small response:

| Tool | Answers |
|---|---|
| `get_readiness` | "How recovered am I?", "How did I sleep?": that night's sleep, HRV vs baseline, resting HR, Body Battery, each against your previous 7 days; training load; the last 3 days of training |
| `summarize_wellness` | Sleep, resting HR, HRV, stress, steps and Body Battery trends: by week, month, weekday or overall |
| `summarize_activities` | Training totals: distance, time, pace, HR, training load and time in HR zones, by week, month, weekday or overall |
| `compare_activities` | 2–5 activities side by side |

**Detail.** Compact by default; pass `detail: "full"` for Garmin's raw data.

| Tool | Data |
|---|---|
| `get_daily_summaries` | One row per day: steps, calories, HR, intensity minutes, stress, Body Battery |
| `get_sleep_summaries` / `get_sleep` | Sleep hours by stage, score, HR, respiration, SpO2, over a range or for one night |
| `get_hrv_summaries` / `get_hrv` | HRV over a range, or one night's readings |
| `get_body_battery`, `get_stress`, `get_steps` | Daily series over a range |
| `get_heart_rate` | One day, as hourly min/avg/max |
| `get_spo2`, `get_fitness_age` | Single-day detail |
| `get_weight`, `get_weight_goals`, `get_hydration`, `get_wellness_activity_summaries` | Ranges |
| `search_activities` | Individual activities, filterable by type, subtype, race and distance, sortable by distance or speed |
| `get_activity`, `get_activity_workouts` | One activity in detail |
| `get_nutrition`, `get_menstrual_cycle` | Single-day detail |
| `get_profile` | Units, time zone and heart-rate zones |

Together these cover every JSON endpoint in
[Garmin's Personal API spec](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/).
There's deliberately no "GET any path" tool: with one, the model guessed at
endpoints that don't exist and wasted calls.

### Training load

The acute:chronic ratio compares the last 7 days with the average week of the
last 28. Garmin's own Training Status isn't in the Personal API, so the server
computes it from the best measure every activity in the window has, and says
which it used:

1. Garmin's per-activity training load, on watches that record it
2. Heart-rate zone load (minutes in each zone × zone number), on any watch or strap with heart rate
3. Moving minutes, when there's no heart-rate data

It uses one measure for the whole window, because mixing them would make the
ratio meaningless. Treat it as a guide, not Garmin's figure.

## Running it

**Logs.** Run `npm run tail`, or use Workers → garmin-cloud-mcp → Logs in the
Cloudflare dashboard. Logs record errors and rejected logins, never your
Garmin data.

**Rotating the Garmin key.** Garmin emails you before the key expires. Create a
new key, run `npx wrangler secret put GARMIN_API_KEY`, then delete the old key
in Garmin Connect. It takes effect immediately, and cached data is tied to the
key that fetched it.

**Cutting off all access at once.** Set `ALLOWED_GITHUB_USER_ID` to `"0"` and
run `npx wrangler deploy`. Every connected client is refused on its next request.
To lock it down harder, also delete the Garmin key in Garmin Connect.

**Rolling back a bad deploy.** `npx wrangler rollback`.

**Updating.** `git pull`, then `npm install` and `npm run deploy`. Your
`wrangler.jsonc` isn't touched by updates. If `wrangler.example.jsonc` gains a
new setting, copy it across.

## Security model

- **Only you can get a token.** After GitHub sign-in, the callback compares
  GitHub's numeric user ID with `ALLOWED_GITHUB_USER_ID`. Anyone else gets a
  403 before an MCP token exists. Every `/mcp` request re-checks the ID, so
  changing it revokes existing sessions.
- **Fails closed.** An unset, `"0"` or non-numeric allowed ID lets nobody in.
- **Minimal GitHub access.** The GitHub token is requested with no scopes,
  used once to read your user ID, and discarded.
- **Standard OAuth.** OAuth 2.1 with PKCE (S256), CSRF-protected consent, and
  tokens bound to the `/mcp` resource, via `@cloudflare/workers-oauth-provider`.
- **Garmin credentials.** The key lives only in Cloudflare secrets. The 24-hour
  bearer token is cached in KV under a hash of the key, never the key itself.
  Cached past-date responses live in the same KV namespace, in your Cloudflare
  account only, and expire after 7 days.
- **Read-only, fixed paths.** Every tool calls a fixed Garmin path with GET.
  `global_fetch_strictly_public` blocks fetches to private addresses.
- **Your data's path.** Garmin → your Worker → your AI client. It ends up in
  whichever chats you use the tools in, under that provider's data policies.

Found a security problem? Please report it privately through GitHub's
**Security → Report a vulnerability** on this repo rather than opening an issue.

## Development

```sh
npm test           # unit tests
npm run test:e2e   # the real Worker in Miniflare, full OAuth + MCP flow, GitHub and Garmin faked
npm run check      # type-check + both of the above; runs before every deploy and in CI
npm run dev        # local server on :8788 (needs .dev.vars, see .dev.vars.example)
npm run stdio      # the local stdio server (needs GARMIN_API_KEY in the environment)
```

The tests and type-check use `wrangler.example.jsonc`, so they run without a
Cloudflare account or your own config.

Field names come from Garmin's Personal API spec. If a value comes back empty
for your device, compare with `detail: "full"`. The compact shapes live in
`src/compact.ts` and `src/activities.ts`.

`npm audit` reports advisories in `undici` inside `miniflare@4`. That copy is
used only by the local test harness against fake servers and isn't part of
the deployed Worker. `npm audit --omit=dev` is clean.

## Known limits

- **One Garmin account per cloud deployment or local install.** To share with
  family, each person sets up their own copy with their own Garmin key.
- **Personal API coverage only.** No golf, training plans, Garmin Training
  Status, race predictions, VO2 max history, personal records, gear, courses,
  badges, social, or writes.
- **No activity file downloads.** FIT files aren't exposed, since a chat model can't
  do much with the binary.
- **Rate limits unpublished.** Garmin hasn't published Personal API rate
  limits. A 429 comes back as a clear tool error.

## Credits

The OAuth flow is adapted from Cloudflare's
[remote-mcp-github-oauth](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth)
demo. `src/workers-oauth-utils.ts` is vendored from it under its MIT licence.

## Author

Built by [Colin Cooper](https://colincooper.io).

## License

[MIT](LICENSE)
