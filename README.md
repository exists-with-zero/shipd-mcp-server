# Shipd MCP server

An open-source, self-hosted [Model Context Protocol](https://modelcontextprotocol.io)
server that lets an AI assistant build and change real web apps by
conversation, with a team of five AI specialists who talk you through the
build. It powers **Shipd for Alexa+**, our entry for the Amazon Developer
Hackathon (Alexa+ track), and it also works in Claude as a custom connector.

It is a working reference for the newer parts of the MCP spec (2025-11-25)
in one server, on the official TypeScript SDK 1.31.0:

- **MCP Tasks** for tool calls that take minutes (call now, fetch the result later)
- **Elicitation** (form mode) for one clarifying question before a build
- **MCP Apps**: a live build card that becomes a "team room", with audio
- **OAuth 2.1** discovery so Claude can add it as a connector
- Streamable HTTP, hardened for public hosting (host checks, rate limits, no batches)

Each part came with a gap in the docs or the SDK; the workaround is in the code
and explained below (sessions for elicitation, a task store per request, a
global build of the MCP Apps client, content-hashed card addresses).

**Try it:** the hosted server is
`https://pretty-spirit-production-31d6.up.railway.app/mcp`. It talks to a
Shipd account (theshipd.com); during the preview, access is switched on per
account. You can run the tests without any account: `npm ci && npm test` runs
the real SDK client against this server and a fake Shipd backend.

**Licence:** MIT (see `LICENSE`).

---

## Overview

Lets an AI assistant (Claude, ChatGPT, the "Shipd for Alexa+" voice demo) build
and change real apps in a person's Shipd account.

- MCP spec **2025-11-25**, official TypeScript SDK (`@modelcontextprotocol/sdk` 1.31.0, pinned)
- Streamable HTTP, stateless by default; a session only for clients that initialize, because elicitation needs one
- Long builds run as **MCP Tasks** (call now, fetch later); a client without Tasks hears at once that the build started, with a build id to follow
- A **live build card** (MCP Apps, `ui://shipd/build-card.html`) follows a build on hosts that show one
- Every reply is written to be **spoken**: one or two short sentences

## Tools

| Tool | What it does | Kind |
| --- | --- | --- |
| `list_apps` | The person's apps, newest first | read only |
| `build_app` | New project + first build from a description; may ask one quick question first | task (optional) |
| `build_with_team` | New project built by the AI Team: Maya plans, Theo sets the look, Ren designs, Sam builds; each status message is a spoken line | task (optional) |
| `edit_app` | Change an existing app (latest saved version) | task (optional) |
| `check_build` | Where a build has got to, by build id | read only |
| `watch_build` | For a spoken conversation: waits up to 40 s for the team's next lines and returns them, so an assistant in voice mode can narrate a build without being asked (not offered to Shipd's own voice page, which speaks the team itself) | read only |
| `speak_line` | For the build card only (MCP Apps visibility `app`, never shown to the model): one team line as audio in that person's own Amazon Polly voice, through Shipd's `/voice/speak` with the caller's token (voice must be on for the account; not offered to the voice page) | read only |
| `tell_team` | While an AI Team build runs: pass what the person says to one team member by name ("Theo, make it darker"); the note joins every room that has not started, and that person answers in their own words (backend `POST /team/job/{id}/note`, behind `TEAM_NOTES_ENABLED`) | |
| `cancel_build` | Stop a running build; nothing is saved | |
| `get_app_link` | Link that opens the app in Shipd (for the owner, signed in) | read only |
| `share_app` | Public link anyone can open without an account (`/s/<token>`); says if files were held back as secrets, and if visitors use the app's real data | |
| `stop_sharing` | Turn off every share link to an app | |

`build_with_team` needs the backend's team job (`TEAM_JOB_ENABLED` plus the
org on `TEAM_JOB_ORG_IDS`, with Team Mode on). Without it the tool says so and
creates nothing.

A spoken conversation has no card, so the server's instructions and the first
`watch_build` of a team build tell the assistant to mention Shipd's `/live` page
once: signed in to Shipd, it shows the person's latest team build live (who is
working, the team chat, Listen in their voices) wherever the build was started.
It only reads (backend `GET /api/v1/team/live`), so watching never starts or
repeats a build.

If a build cannot start (a plan limit, a rate limit), the project the same call
just created is deleted again, so a refused build never leaves an empty app.

`share_app` needs the backend's share links (`SHARE_LINKS_ENABLED` plus the org
on `SHARE_LINKS_ORG_IDS`). A link is pinned to the version it was made for, runs
in the visitor's own browser, expires after 30 days and dies with the API token
that made it. Visitors cannot change the app, but an app with sign-in, a
database or uploads runs on its real data, like a deployed app, and the reply
says so. Apps imported from or connected to a repository can't be shared.

### One quick question before a build (elicitation)

When a description is short (under 30 words) and the assistant has not passed
`answers`, `build_app` and `build_with_team` ask one question with MCP
elicitation (form mode): who the app is for (pick one) and its must-haves
(pick any), with options Shipd tailors to that app (`POST /api/v1/clarify`),
plus an optional note. The answer goes into the build. A skip, no answer
within 50 s, a client without form support, or a failed questionnaire just
builds from the description; if the client gives up on the call while the
question is open, nothing is built at all, since nobody would hear about it.

### Sessions

Elicitation needs the answer to reach the same server, so a client that
initializes gets a session:
- bound to the token that opened it (a hash of it); any other token is told
  the session does not exist;
- only for a token Shipd accepts (one check at initialize);
- at most 5 per token (a client's new session pushes out only its own oldest)
  and 500 in all, idle ones first; one with a request open is never pushed out;
- ended by `DELETE /mcp`, or after 30 minutes idle.

Requests without a session are still served statelessly. Builds never depend
on a session (the build id carries the job), so a restart only loses an open
question. Sessions live in memory: run one copy.

### The live build card (MCP Apps)

`build_app`, `build_with_team` and `edit_app` point at one UI resource
(not `check_build`: each "is it done?" would draw another card polling the
same build), `ui://shipd/build-card.html` (`text/html;profile=mcp-app`). Hosts
that support MCP Apps (Claude, ChatGPT, the voice page) render it next to the
call; others never read it. The card:

- is one self-contained page: the official MCP Apps client
  (`@modelcontextprotocol/ext-apps`, pinned 1.7.5, the 1.x line that matches
  SDK 1.31) is inlined from its prebuilt bundle, with no external scripts,
  styles, fonts or images, so it needs no CSP exceptions;
- takes the build id from the tool result and, while the build runs, asks
  `check_build` (through the host) every 5 seconds for 3 minutes, then every
  10 to 15 minutes, then every 20, stopping after 40 (a team build with a
  backend takes about 16); a reply without a status is a miss, never a failure,
  and a build Shipd can no longer show is "unknown", never "failed": the AI Team's people as the job reports them (so
  hired and fired members show), the line they just said, or how much code a
  quick build has written; then "ready", the version and an Open button;
- for an AI Team build, shows the team room: a tile per person (colour, role,
  working or done, and what they last said), a team chat of every line as it
  comes, a clock, and a Listen button that reads the lines aloud in each
  person's own Polly voice (the voice page's voices, fetched with `speak_line` and
  played with Web Audio, so no audio URL and no CSP exception), or with the
  device's voices when Shipd's are not on for the account; Shipd's voice page says
  `shipdVoice` in its host context and gets neither the chat nor the button;
- tells the model when the build is done (`ui/update-model-context`), so the
  assistant need not poll;
- offers only `https://` links, opened by the host (`ui/open-link`), never
  around it;
- sets every piece of server text with `textContent`, never as HTML; follows
  the host's light or dark theme.

Coming next (see `docs/plan-alexa-hackathon.md`): the voice page, and
(stretch) `ask_kai`.

## How auth works

Each caller sends its **own** Shipd API token:

```
Authorization: Bearer shp_...
```

The server passes that token to the Shipd backend on every call and holds no
secret of its own. So the backend's rules apply exactly as they do in the
browser: org isolation, rate limits, the budget breaker, token limits and plan
rules. A token carries at most member rights. A request without a well-formed
`shp_` token is refused before anything reaches Shipd.

API tokens exist only when the backend has `API_TOKENS_ENABLED=true`, and only
for orgs listed in `API_TOKENS_ORG_IDS`. Both are off by default.

The voice page on theshipd.com is an MCP host in the browser. It calls this
server with a short-lived member token the backend mints for the signed-in
person (`POST /voice/token`, 2 hours), never with their full-power session.
The browser may call `/mcp` only from Shipd's own web app (`SHIPD_APP_URL`,
plus `MCP_CORS_ORIGINS`; http and https origins only, never "null"); auth is a
header, never a cookie.

### Sign in with Shipd (OAuth), for Claude

Claude (claude.ai, Claude Desktop and the mobile apps) adds a remote MCP
server only through OAuth. With `SHIPD_OAUTH_ISSUER` set to the backend's
public URL, this server says where a token comes from:

- `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728) names this
  server (`MCP_PUBLIC_URL`, else `https://$RAILWAY_PUBLIC_DOMAIN`) and Shipd's
  backend as its authorization server. Any origin may read it.
- Every 401 carries `WWW-Authenticate: Bearer ..., resource_metadata="..."`,
  with `error="invalid_token"` when a token was sent and refused.
- A token is re-checked with Shipd at most once a minute, so an access token
  past its hour gets a 401 (and the client refreshes it) rather than an error
  from inside a tool call.

The backend does the rest (`OAUTH_ENABLED`, `OAUTH_ISSUER`; see
`backend/app/services/oauth.py`): client registration for Claude's exact
connector callback (plus loopback), the approve page at theshipd.com/oauth/authorize, and
the token endpoint. What Claude ends up with is an ordinary 1-hour `shp_`
member token, renewed with a 30-day refresh token; both show in the person's
Settings, Integrations, API tokens, and revoking either there disconnects
Claude. Without `SHIPD_OAUTH_ISSUER` nothing here changes.

To connect: in Claude, Settings, Connectors, Add custom connector, with this
server's `/mcp` URL. Claude opens the Shipd page; sign in and Allow.

For an AI Team build, `check_build` also returns the team's own lines
(`voice`: who said it and what, in the first person, last 4) and
`voice_total`, so the voice page can speak each line once in that person's
voice.

## How builds map to MCP Tasks

A build id (the MCP task id) is an opaque encoding of the Shipd job it tracks:
the job id, the project, and the version the project had before the build.
`tasks/get`, `tasks/result` and `tasks/cancel` read Shipd **with the caller's
token** every time. That means:

- another org's build id is "task not found", because Shipd returns 404 for it;
- the server can restart, or run as several copies, without losing a build;
- a build is "completed" only once Shipd has **saved** a new version. "Done"
  with nothing saved is reported as a failure, never as ready;
- a job whose heartbeat stopped (Shipd restarted under it) is reported as
  failed with a retry hint, instead of "building" for an hour;
- a build that could not start (plan limit, rate limit) is a task that is born
  `failed` and carries Shipd's own sentence. The SDK would otherwise turn the
  error into a schema error;
- a client that calls a build tool **without** asking for a task gets a task
  that is born `completed`, whose result says the build has started and gives
  the build id to follow with `check_build` (and the card follows it live).
  Without this the SDK would hold that one HTTP call open for the whole build,
  4 to 8 minutes, past most clients' timeouts. Whether the client asked for a
  task is read from the raw request (`scope.ts`): the SDK does not tell the
  handler.

The SDK sends task requests straight to the task store with only a task id
(no auth). That is why `http.ts` builds a new server and task store for every
request, bound to that request's token.

## Run it locally

```bash
cd mcp-server
npm ci
SHIPD_API_URL=http://localhost:8000 SHIPD_APP_URL=http://localhost:3000 npm run dev
```

The server listens on `http://127.0.0.1:8787/mcp`, with a health check at
`/health`. The settings are listed in `.env.example`; set them in the
environment (they are not read from a file).

```bash
npm test          # end-to-end: the SDK client -> this server -> a fake Shipd
npm run typecheck
npm run build && npm start
```

### Try it with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose Streamable HTTP, URL `http://127.0.0.1:8787/mcp`, and add the header
`Authorization: Bearer shp_...`.

### Try it with Claude Code

```bash
claude mcp add --transport http shipd http://127.0.0.1:8787/mcp --header "Authorization: Bearer shp_..."
```

## Getting a token

A token comes from Shipd: **Settings > Integrations > API tokens** (shown once;
Shipd keeps only a hash; a token cannot create tokens). During the preview,
API tokens are switched on per account. In Claude you do not need a token: add
the server as a custom connector and sign in with Shipd.

## Deploying on Railway

Its own service in the Shipd Railway project, so
a deploy of this server never restarts the backend, and a long build call is
never cut short.

**Live:** service `pretty-spirit` in the Railway project, at
`https://pretty-spirit-production-31d6.up.railway.app/mcp` (set up and
verified 2026-10-01).

Railway's Config-as-code is deprecated, and services created after 2026-08-28
cannot opt in, so `railway.json` in this folder is NOT read by that service.
Railway detects the Node app from `package.json` on its own (`npm run build`,
then `npm start`). The file stays as a record of the intended settings; set
the two that matter by hand if wanted: **Watch Paths** `/mcp-server/**` (so
other merges do not redeploy it) and **Healthcheck Path** `/health`.

How it was set up (repeat for a new environment):

1. Railway project > **Create** > **GitHub Repository** > this repo.
2. The new service > **Settings > Root Directory**: `/mcp-server`.
3. **Variables**:
   - `SHIPD_API_URL` = the backend's public URL, no `/api/v1`
     (prod: `https://ai-builder-production-859e.up.railway.app`)
   - `SHIPD_APP_URL` = `https://theshipd.com`
   - `PORT` = `8080`
4. **Deploy**. Networking only becomes available after the first deploy.
5. **Settings > Networking > Generate Domain** (port `8080`), then add
   `MCP_ALLOWED_HOSTS` = that domain and deploy again. Without it the first
   deploy, which predates the domain, answers "Invalid Host" to everyone.

On Railway the server listens on every interface and accepts only its own
generated domain (Railway sets `RAILWAY_PUBLIC_DOMAIN`) and Railway's health
checker. A custom domain such as `mcp.theshipd.com` goes in
`MCP_ALLOWED_HOSTS`. It refuses to start without the two Shipd URLs, rather
than quietly calling localhost.

It holds no secrets and never touches the database: every call carries the
caller's own `shp_` token to the backend, which applies its usual rules.

Because it is public, it also turns away, before anything reaches Shipd:
JSON-RPC batches (one request, one call), more than `MCP_RATE_PER_MIN`
requests a minute from one token (default 120; ten times that from one
address, since a hosted client sends every user's calls from its own), and for a minute any token
Shipd has just refused. Bad bodies get a JSON-RPC error, never an HTML stack
trace. It refuses to start with a plain-http `SHIPD_API_URL` (callers' tokens
travel to it) unless that is localhost or Railway's private network, and
refuses to listen publicly without a host list.
