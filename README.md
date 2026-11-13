# garmin-mcp

[![CI](https://github.com/colincooperio/garmin-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/colincooperio/garmin-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/garmin-mcp.svg)](https://www.npmjs.com/package/garmin-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Ask your AI assistant about your training, sleep and recovery, using your own
Garmin data. It's an [MCP](https://modelcontextprotocol.io) server that gives
Claude, ChatGPT and other assistants read-only access to your Garmin Connect
data through Garmin's official
[Personal API](https://developer.garmin.com/gc-developer-program/personal/).

Run it whichever way suits you. The tools are identical:

- **Local.** Runs on your computer, started by your AI app. About a minute to
  set up, and all you need is your Garmin key. In Claude Desktop it's a
  one-click install.
- **Cloud.** Runs on your own Cloudflare account (the free plan is plenty),
  behind GitHub sign-in. About 10 minutes to set up with `npm run setup`, and
  it then works on all your devices: web, desktop and phone.

It works with Claude, ChatGPT, Claude Code, Codex, Gemini CLI, Cursor, VS Code
and other MCP clients. See [Local or cloud?](#local-or-cloud) for which apps each option
covers.

Either way, you get:

- **Insight, not another chart.** Ask a question and get an answer based on
  your own data.
- **No password.** It uses Garmin's official API key, which you can revoke at
  any time, not your Garmin login.
- **No middleman.** Data goes straight from Garmin to your computer or your own
  Cloudflare account. No third-party service stores it.
- **Always current.** It fetches from Garmin when you ask, so there's no sync to
  remember.
- **No extra cost.** It uses the AI subscription you already have, and the cloud
  option fits Cloudflare's free plan.

Ask things like:

- _"Am I ready to train hard today?"_
- _"How has my resting heart rate and HRV changed since May?"_
- _"What were my running totals and average pace each month this year?"_
- _"How much of my running is easy vs hard?"_
- _"Which day of the week do I sleep worst?"_
- _"Compare my last two long runs."_
- _"Give me my km splits for Sunday's race. Did I negative split?"_
- _"What are my 5k and 10k PBs this year, and what could I run a half in?"_
- _"Am I building my mileage too fast?"_
- _"Do I run worse after a bad night's sleep?"_

Here it is in Claude on a phone (cloud version), projecting a 10k time from
recent runs:

<p align="center">
  <img src="https://raw.githubusercontent.com/colincooperio/garmin-mcp/main/docs/demo.gif" width="320" alt="Claude on a phone answering 'how quickly could I run a 10k in April?' from Garmin running data">
</p>

> Not affiliated with or endorsed by Garmin. "Garmin" and "Garmin Connect" are
> trademarks of Garmin Ltd. or its subsidiaries.

## Local or cloud?

|                                                         | Local | Cloud |
| ------------------------------------------------------- | :---: | :---: |
| Claude Desktop (one-click install), Claude Code         |  ✅   |  ✅   |
| Codex (CLI, and in the ChatGPT desktop app)             |  ✅   |  ✅   |
| Gemini CLI, Cursor, VS Code                             |  ✅   |  ✅   |
| The ChatGPT app: web, desktop chat and phone            |       |  ✅   |
| Claude on the web                                       |       |  ✅   |
| AI apps on your phone or tablet                         |       |  ✅   |
| Works when your computer is off                         |       |  ✅   |
| Set up in about 1 minute                                |  ✅   |       |
| No Cloudflare or GitHub account needed                  |  ✅   |       |
| Garmin key stored only on your computer                 |  ✅   |       |
| Nothing listening on the network                        |  ✅   |       |
| Free to run                                             |  ✅   |  ✅   |
| All 28 tools and 5 prompts                              |  ✅   |  ✅   |

### Still deciding?

<details>
<summary><b>I use Claude Desktop or Claude Code on one computer</b></summary>

Go local. You get everything, in about a minute. In Claude Desktop it's a
single download: no Node, no config file.

</details>
<details>
<summary><b>I want to ask from my phone, say right after a run</b></summary>

Go cloud. Phone apps can't start a local process, so they need a server they
can reach over the internet.

</details>
<details>
<summary><b>I use ChatGPT</b></summary>

Go cloud. The ChatGPT app itself (web, desktop chat and phone) connects to
remote MCP servers only. Codex is the exception: the Codex CLI, and Codex in
the ChatGPT desktop app, can run it locally.

</details>
<details>
<summary><b>I use more than one computer</b></summary>

Go cloud. Local means installing it on each computer; cloud means setting it up
once and adding the URL to each app.

</details>
<details>
<summary><b>I'm not sure yet</b></summary>

Start local. If you later want it on your phone, set up cloud. There's nothing
to migrate, because your data stays in Garmin.

</details>
<details>
<summary><b>Can I run both?</b></summary>

Yes. They can share a Garmin key.

</details>
<details>
<summary><b>Which is more secure?</b></summary>

Both are locked down, in different ways. Local has no sign-in because there's
nothing to sign in to: only the app that started it can talk to it, and your
key sits in that app's config on your computer. Cloud is reachable from the
internet, so it's locked to your GitHub account, and your key sits in
Cloudflare secrets. See [Security model](#security-model).

</details>
<details>
<summary><b>How comfortable with a terminal do I need to be?</b></summary>

Local: you paste one command or one config snippet. Cloud: four commands
(`git clone`, `cd`, `npm install`, `npm run setup`), then the setup script asks
you questions and does the rest. You fill in one form on GitHub and create a
key in Garmin Connect along the way.

</details>

## Running locally

Your AI app starts the server as a local process and talks to it directly.
There's no Cloudflare or GitHub setup.

All you need is a Garmin Personal API key (see
[Create a Garmin Personal API key](#create-a-garmin-personal-api-key)).

### Claude Desktop: one click

1. Download
   [garmin-mcp.mcpb](https://github.com/colincooperio/garmin-mcp/releases/latest/download/garmin-mcp.mcpb).
2. Double-click it, paste your Garmin key when asked, done.

Claude Desktop runs the extension itself, so you don't need Node or a config
file, and your key is stored in your system keychain.

Claude Desktop warns before installing it. It shows that warning for every
extension that isn't installed from Anthropic's directory, not because of
anything in this one. This extension only connects to Garmin's API, and its
source is all in this repo. To check that your download was built from this
repo by its release workflow, and not changed since, run this with the
[GitHub CLI](https://cli.github.com):

```sh
gh attestation verify garmin-mcp.mcpb --repo colincooperio/garmin-mcp
```

### Claude Code, Cursor, VS Code and other apps

These need Node 22 or newer. There's nothing to install separately: your app
runs the [`garmin-mcp`](https://www.npmjs.com/package/garmin-mcp) package with
`npx`.

**Claude Code:**

```sh
claude mcp add garmin --env GARMIN_API_KEY=<your key> -- npx -y garmin-mcp
```

**Cursor, VS Code and other apps** (or Claude Desktop, if you'd rather not
use the extension): add this to the app's MCP config:

```json
{
	"mcpServers": {
		"garmin": {
			"command": "npx",
			"args": ["-y", "garmin-mcp"],
			"env": {
				"GARMIN_API_KEY": "<your key>"
			}
		}
	}
}
```

VS Code's `mcp.json` uses `"servers"` instead of `"mcpServers"`.

### Codex

For the Codex CLI and Codex in the ChatGPT desktop app, which share one
config. Add this to `~/.codex/config.toml` (needs Node 22 or newer):

```toml
[mcp_servers.garmin]
command = "npx"
args = ["-y", "garmin-mcp"]
env = { GARMIN_API_KEY = "<your key>" }
```

### Gemini CLI

Add this under `"mcpServers"` in `~/.gemini/settings.json` (needs Node 22 or
newer):

```json
"garmin": {
	"command": "npx",
	"args": ["-y", "garmin-mcp"],
	"env": { "GARMIN_API_KEY": "<your key>" }
}
```

Restart the app, then try _"Am I ready to train today?"_.

## Running in the cloud

```
MCP client ──OAuth──▶ Worker (/mcp) ──Bearer JWT──▶ Garmin Personal API
                         │
                         └─ /authorize ──▶ GitHub sign-in ──▶ allowed user ID? ──▶ token
```

Each person deploys their own copy to their own Cloudflare account. It's
locked to a single GitHub account, so your Garmin data is only ever reachable
by you.

### What you need

- A Garmin Connect account and a Garmin device
- A Cloudflare account (free plan)
- A GitHub account
- Node 22 or newer
- About 10 minutes

### Quick setup

```sh
git clone https://github.com/colincooperio/garmin-mcp.git
cd garmin-mcp
npm install
npm run setup
```

`npm run setup` walks you through the rest and does most of it itself. It
logs you in to Cloudflare in your browser, asks what to call the Worker
(`garmin-cloud-mcp` unless you choose otherwise; it's part of the URL, and it
warns you if your account already has a Worker by that name), creates the
storage the server needs, locks it to your GitHub account, stores your secrets in Cloudflare and
deploys. Along the way you do two things in your browser:

1. **Create a GitHub OAuth app**, which is how sign-in works. The script
   prints a link to GitHub's form and the exact Homepage and callback URLs to
   paste into it, then asks for the client ID and secret.
2. **Create a Garmin Personal API key** (see
   [below](#create-a-garmin-personal-api-key)) and paste it in.

What you type for secrets isn't shown on screen. It goes straight to
Cloudflare and is never written to disk. If a step fails, the script says
which one and how to fix it. Run `npm run setup` again and it skips the steps
that are done, and asks before replacing anything.

When it's done it prints your server URL. Then
[connect your AI apps](#connect-your-ai-apps).

### Create a Garmin Personal API key

Go to [Garmin Connect → Personal API Token](https://connect.garmin.com/app/settings/personalApiToken)
→ Create Key. Pick 1 year and copy the key; Garmin shows it only once.

### Connect your AI apps

Your server URL is `https://garmin-cloud-mcp.<your-subdomain>.workers.dev/mcp`
(`npm run setup` prints it). Every app opens a GitHub sign-in the first time;
sign in and approve.

- **Claude**: Settings → Connectors → Add custom connector, and paste the URL.
  The connector follows your Claude account onto every device.
- **ChatGPT**: add it as a custom connector (MCP server) with OAuth
  authentication. Custom connectors need developer mode and depend on your
  plan; see OpenAI's help pages for the current steps.
- **Claude Code**: `claude mcp add --transport http garmin <url>`, then run
  `/mcp` to sign in.
- **Cursor, VS Code and other MCP apps**: add a remote (HTTP) MCP server
  with the URL. Apps that support MCP OAuth handle the sign-in themselves.

Try _"Am I ready to train today?"_. In apps that show MCP prompts, such as
Claude's connector menu, you can also pick a ready-made prompt.

<details>
<summary><b>Setting it up by hand instead</b></summary>

Run all commands from the repo folder.

#### 1. Install and log in to Cloudflare

```sh
git clone https://github.com/colincooperio/garmin-mcp.git
cd garmin-mcp
npm install
npx wrangler login
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc` is git-ignored, so your settings never get committed.

#### 2. Create the KV namespace

```sh
npx wrangler kv namespace create garmin-cloud-mcp-OAUTH_KV
```

Paste the `id` it prints into `wrangler.jsonc`, replacing `YOUR_KV_NAMESPACE_ID`.
The binding stays `OAUTH_KV`; the title just names the namespace after the
Worker, so it can't clash with another deployment's in the same account.

#### 3. Lock it to your GitHub account

Open `https://api.github.com/users/<your-github-username>` and copy the numeric
`id`. Put it in `wrangler.jsonc` as `ALLOWED_GITHUB_USER_ID`.

It uses the numeric ID rather than your username because usernames can be
changed and then claimed by someone else.

#### 4. Work out your Worker's URL

It will be `https://garmin-cloud-mcp.<your-subdomain>.workers.dev`. Your
`workers.dev` subdomain is on the Workers & Pages overview in the Cloudflare
dashboard. The server works its URL out by itself, so there's nothing to set;
you need it for the next step. (Serving it on a custom domain as well? Set
`MCP_RESOURCE` in `wrangler.jsonc` to the URL clients should use, with `/mcp`
on the end.)

#### 5. Create a GitHub OAuth app

Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App and
fill in:

- **Homepage URL:** `https://garmin-cloud-mcp.<your-subdomain>.workers.dev`
- **Authorization callback URL:** `https://garmin-cloud-mcp.<your-subdomain>.workers.dev/callback`

Then generate a client secret.

#### 6. Create a Garmin Personal API key

See [Create a Garmin Personal API key](#create-a-garmin-personal-api-key).

#### 7. Store the secrets

Each command prompts you to paste the value.

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # paste output of: openssl rand -hex 32
npx wrangler secret put GARMIN_API_KEY
```

If wrangler asks to create the Worker first, say yes.

#### 8. Deploy

```sh
npm run deploy
```

This type-checks and runs the full test suite before it deploys. If anything
fails, nothing ships. The test output includes a few labelled `expected` error
lines: those come from tests that check the Worker refuses bad requests.

Then [connect your AI apps](#connect-your-ai-apps).

</details>

## Why this one

### Compared with password-based Garmin MCP servers

Most Garmin MCP servers predate the Personal API. They log in with your Garmin
email and password and call Garmin Connect's private web endpoints, running on
your own machine.

|                                             | Password-based                                | This, local                                                       | This, cloud                                                            |
| ------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Garmin access                               | Your email + password, session tokens on disk | Official Personal API key: revocable, expires (30 days to 1 year) | Same as local                                                          |
| Breaks when Garmin changes its login or MFA | Yes, regularly                                | No, it uses the documented API                                    | No                                                                     |
| Works in web and phone apps                 | No                                            | No                                                                | Yes                                                                    |
| If the credential leaks                     | Your whole Garmin account                     | Read-only health data, until you delete the key                   | Same as local, and the key sits in Cloudflare secrets, not on a laptop |

The trade-off: the Personal API covers less. It has no golf scorecards,
training plans, Garmin Training Status, Garmin's race predictor or personal
records, gear, courses or write access. (This server computes its own personal
bests and race estimates from your activity files.) The server tells the model this up front, so it says it isn't
available instead of hunting for it.

### Compared with a basic wrapper of the API

A one-tool-per-endpoint wrapper works, but it's slow and expensive in tokens:
Garmin returns 100+ fields per activity and a reading every two minutes for
heart rate. This server does the heavy lifting itself:

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
- **Times in your local time, even on DST nights.** Garmin sends times as raw
  epochs, GMT strings and "local" values, and its local values are an hour out
  on the nights the clocks change. Every time comes back as your local
  `YYYY-MM-DD HH:MM`, worked out from the exact moment and your profile's time
  zone, or from your watch's time zone when you're travelling.
- **Partial results.** If one source fails (say HRV for a night), the rest still
  comes back with a short note, so the model doesn't retry everything.
- **Caching.** Data at least 3 days old has settled, so it's cached for 7 days,
  and activity details for a day. Activity analyses never change, so they're
  cached indefinitely (only the derived tables, never the file). Follow-up questions skip Garmin. Locally,
  the cache is kept on disk, so it survives restarts (see
  [Security model](#local)).
- **Things Garmin's API doesn't give you directly:** per-km/mile splits and
  best efforts (computed from the activity's FIT file in the server, so a
  two-hour run comes back as a few KB of tables, not 7,000 samples), training
  load (acute:chronic ratio, and its trend week by week), personal bests across
  runs with race time estimates, how sleep, HRV and Body Battery relate to your
  running, time in heart-rate zones (for one activity, the
  watch's own figures with the zones you had then, so they match Garmin
  Connect), weekday patterns, distance-weighted pace, side-by-side activity
  comparison.
- **Prompt templates** for apps that support MCP prompts (such as Claude's
  connector menu): _Am I ready to train today?_, _Sleep report_, _Training
  review_, _Weekly check-in_, _Compare recent sessions_.

## Tools

All tools are read-only. Ranges can be up to 92 days (366 for the
`summarize_*` tools). Every range tool also takes `period`, and single-day
tools take `today` or `yesterday`. For the `summarize_*` tools, a `start_date`
on its own means "since then": the range ends today.

**Start here.** These answer common questions in one call with a small response:

| Tool                    | Answers                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_readiness`         | "How recovered am I?", "How did I sleep?": that night's sleep, HRV vs baseline, resting HR, Body Battery, each against your previous 7 days; training load; the last 3 days of training                        |
| `summarize_wellness`    | Sleep, resting HR, HRV, stress, steps and Body Battery trends: by week, month, weekday or overall                                                                                                              |
| `summarize_activities`  | Training totals: distance, time, pace, HR, training load and time in HR zones, by week, month, weekday or overall. By week or month, also the load trend: change on the previous period, acute:chronic ratio and flags for a fast build |
| `compare_activities`    | 2–5 activities side by side                                                                                                                                                                                    |
| `get_activity_analysis` | One activity from its original FIT file: per-km or per-mile splits, the watch's laps and workout reps, best efforts (1 km to marathon), time in HR zones as the watch recorded it, first- vs second-half drift |
| `get_personal_bests`    | Your fastest 1 km, 1 mile, 5 km, 10 km, half and marathon across many activities, with the next two best, plus race time estimates (Riegel). Computed from your activity files, not Garmin's official records |
| `analyze_recovery_impact` | Whether sleep, HRV or Body Battery relate to how you run: runs after your best third of nights against your worst third, compared at the same heart rate (against your own speed-for-HR line), with each group's HR, a correlation, and an honest "not enough data" |

**Detail.** Compact by default; pass `detail: "full"` for Garmin's raw data.

| Tool                                                                                 | Data                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_daily_summaries`                                                                | One row per day: steps, calories, HR, intensity minutes, stress, Body Battery                                                              |
| `get_sleep_summaries` / `get_sleep`                                                  | Sleep hours by stage, score, HR, respiration, SpO2, sleep need and what drove it, over a range or for one night                            |
| `get_hrv_summaries` / `get_hrv`                                                      | HRV over a range, or one night's readings                                                                                                  |
| `get_body_battery`, `get_stress`, `get_steps`                                        | Daily series over a range (Body Battery includes the day's key readings)                                                                   |
| `get_heart_rate`                                                                     | One day, as hourly min/avg/max, plus every reading in a `from`/`to` window if given                                                        |
| `get_spo2`, `get_fitness_age`                                                        | Single-day detail                                                                                                                          |
| `get_weight`, `get_weight_goals`, `get_hydration`, `get_wellness_activity_summaries` | Ranges                                                                                                                                     |
| `search_activities`                                                                  | Individual activities, filterable by type, subtype, race, distance, duration, elevation gain, name and area, sortable by distance or speed |
| `get_activity`, `get_activity_workouts`                                              | One activity in detail                                                                                                                     |
| `get_nutrition`, `get_menstrual_cycle`                                               | Single-day detail                                                                                                                          |
| `get_profile`                                                                        | Units, time zone and heart-rate zones                                                                                                      |

Together these cover every endpoint in
[Garmin's Personal API spec](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/),
including the activity file download that `get_activity_analysis` reads.
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

`summarize_activities` by week or month shows the same ratio at the end of each
period, with the load's change on the previous period. It flags a ratio above
1.3 or a rise of more than 30%, and fetches the 28 days before your range so
the first period's ratio is real.

### Personal bests and race estimates

The Personal API has no personal records, so `get_personal_bests` works them
out from your activity files: the fastest continuous stretch of each distance
within each run, then the fastest across runs. It reads the newest 150 matching
activities per call and skips manual entries and imports, which have no file.

The first call over a long range is slow, because each activity's file is
downloaded once (later calls use the cache). If it runs out of time, or Garmin
rate-limits it, the result starts with `"complete": false` and a status line,
and the bests are labelled provisional, so your AI app knows to call again (it
carries on where it stopped) rather than present them as final. The cloud
version downloads at most 15 files per call to stay within Cloudflare's
free-plan limits, so filling the cache for a full year takes several calls.

Race estimates look at the last 90 days of the range. If you ran the race
distance itself, your best time there is shown, since an actual result beats
any formula. Otherwise the estimate uses Riegel's formula (T2 = T1 ×
(D2/D1)^1.06) from your fastest effort at the closest distance you ran (5 km
or more), because it's most accurate over short jumps. When two distances are
about equally close, the more recent effort is used. It never projects more
than 4× up or down. They're estimates, not Garmin's race predictor.

### Recovery and performance

`analyze_recovery_impact` pairs each run with the night before it and asks
whether you run differently after your best nights than after your worst.
Comparing raw pace or "metres per heartbeat" would mostly measure what kind of
run you chose: easy days after good nights look "less efficient" simply
because both speed and heart rate are lower. So it fits your own line of speed
against heart rate across the runs and compares how far above or below that
line each group was: the difference in s/km at the same heart rate. It
reports each group's average heart rate, warns when they differ by more than
about 8 bpm, needs about 8 runs per group, and only calls a relationship
meaningful from a correlation of 0.3. It's still correlation, not proof.

## Looking after it

**Rotating the Garmin key.** Garmin emails you before the key expires. Create a
new key, then:

- Local: replace `GARMIN_API_KEY` in your AI app's MCP config and restart the
  app. For Claude Code, run `claude mcp remove garmin` and add it again. For
  the Claude Desktop extension, paste the new key into the extension's
  settings in Claude Desktop.
- Cloud: run `npx wrangler secret put GARMIN_API_KEY` (or rerun
  `npm run setup` and say yes when it asks to replace the Garmin key). It
  takes effect immediately, and cached data is tied to the key that fetched
  it.

Then delete the old key in Garmin Connect.

**Updating.**

- Claude Desktop extension: download the new
  [garmin-mcp.mcpb](https://github.com/colincooperio/garmin-mcp/releases/latest/download/garmin-mcp.mcpb)
  from the latest release and double-click it.
- Local with `npx`: `npx` fetches the latest version each time your AI app
  starts the server, so just restart the app. To stay on a fixed version, use
  `garmin-mcp@1.4.0` in place of `garmin-mcp` in your config.
- Cloud: run `npm run update` in the repo folder. It pulls the latest version,
  reinstalls, lists any new settings in `wrangler.example.jsonc` that your
  `wrangler.jsonc` lacks (it never edits your file), runs the tests and
  deploys, then prints the old and new version. If a deploy goes wrong,
  `npx wrangler rollback` returns to the previous one. Set up before 1.4.0?
  Run `git pull` and `npm install` once to get `npm run update`.

Watch the repo (Watch → Custom → Releases) to get an email when there's a new
version.

<details>
<summary><b>Updating the cloud server by hand</b></summary>

From the repo folder: `git pull`, then `npm install` and `npm run deploy`.
Your `wrangler.jsonc` isn't touched by updates. If `wrangler.example.jsonc`
gains a new setting, copy it across.

</details>

**Logs.** Locally, the server logs to your AI app's MCP log. In the cloud, run
`npm run tail`, or use Workers → garmin-cloud-mcp → Logs in the Cloudflare
dashboard. Logs record errors and rejected logins, never your Garmin data.

**Cutting off all access at once.** Delete the Garmin key in Garmin Connect;
that stops both local and cloud. For cloud, you can also set
`ALLOWED_GITHUB_USER_ID` to `"0"` and run `npx wrangler deploy`: every
connected app is refused on its next request.

**Rolling back a bad cloud deploy.** `npx wrangler rollback`.

**A value is empty?** Some fields depend on your device. Ask again with
`detail: "full"` to see everything Garmin sent. If the field is there, the
compact answer is missing it: please [open an issue](CONTRIBUTING.md#reporting-issues).

## Security model

### Both

- **Read-only, fixed paths.** Every tool calls a fixed Garmin path with GET.
  There's no tool that writes to Garmin or fetches an arbitrary URL.
- **Your data's path.** Garmin → your computer or your Worker → your AI app. It
  ends up in whichever chats you use the tools in, under that provider's data
  policies.

### Local

- **No network listener.** The server talks over stdin and stdout to the app
  that started it, and nothing else can connect. That's why there's no
  sign-in. Never wrap it in an HTTP proxy or expose it on a network; use the
  cloud version for remote access.
- **Garmin credentials.** The key lives in your AI app's MCP config on your
  computer. The bearer token is held in memory only and gone when the process
  exits; neither the key nor the token is ever written to disk.
- **Cache on disk.** Derived data (cached past-date responses such as daily
  summaries, and activity analyses: split and lap tables, never the FIT file or
  GPS positions) is cached so it survives restarts, in a folder only your user
  can read: `~/.cache/garmin-mcp` on macOS and Linux (or
  `$XDG_CACHE_HOME/garmin-mcp`), `%LOCALAPPDATA%\garmin-mcp\cache` on
  Windows. It's capped at 200 MB, oldest first out. To clear it, delete that
  folder. To use a different folder, set `GARMIN_MCP_CACHE_DIR`; to keep
  everything in memory only, set `GARMIN_MCP_NO_CACHE=1` (both go in the same
  `env` block as `GARMIN_API_KEY`).

### Cloud

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
  account only, and expire after 7 days. Activity analyses (split and lap
  tables, never the FIT file or GPS positions) are kept there indefinitely,
  since an activity's file never changes.
- **No private addresses.** `global_fetch_strictly_public` blocks the Worker
  from fetching private addresses.

Found a security problem? Please report it privately through GitHub's
**Security → Report a vulnerability** on this repo rather than opening an issue.

## Contributing

Bug reports and pull requests are welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to report issues, run the tests and
cut a release.

## Known limits

- **One Garmin account per cloud deployment or local install.** To share with
  family, each person sets up their own copy with their own Garmin key.
- **Personal API coverage only.** No golf, training plans, Garmin Training
  Status, Garmin's race predictor, VO2 max history, gear, courses, badges or
  social. Garmin's official personal records aren't available either, but
  `get_personal_bests` computes them from your activity files.
- **Read-only.** It can't log activities, weight, hydration or food, or change
  goals, settings or workouts. The Personal API has no write access, so your
  AI app can read your Garmin data but never change it.
- **No raw activity files or GPS tracks.** `get_activity_analysis` reads the
  FIT file in the server and returns only derived tables; the file, samples and
  positions never reach the model. Manual entries and GPX/TCX imports have no
  FIT data, so the tool says so instead.
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
