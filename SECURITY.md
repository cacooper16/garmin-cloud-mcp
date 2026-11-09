# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's private
vulnerability reporting: open the repo's **Security** tab and choose
**Report a vulnerability**, or go straight to
[security/advisories/new](https://github.com/colincooperio/garmin-mcp/security/advisories/new).
Don't open a public issue.

Include what you found, how to reproduce it and what an attacker could do with
it. I aim to reply within a few days.

## Supported versions

Only the latest release gets security fixes.

## Scope

In scope:

- the local stdio server (npm package and Claude Desktop extension);
- the Cloudflare Worker;
- the cloud OAuth flow: GitHub sign-in, the allowed-user check and MCP tokens;
- how the Garmin API key and bearer tokens are stored, cached and handled.

Out of scope:

- Garmin's own API and services. Report those to Garmin.
- Problems that need someone to already control your computer, your AI app's
  config or your Cloudflare account.

The README's [Security model](README.md#security-model) describes how it's
meant to work.
