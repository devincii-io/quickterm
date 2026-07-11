# QuickTerm MCP Server

Goal: let an AI coworker (Claude Code, Claude Desktop, any MCP client) see and
optionally drive QuickTerm terminals, scoped to one workspace, with the user in
control.

> **Status: implemented.** See `quickterm/mcp_server.py` (the `quickterm-mcp`
> console script), the REST additions in `server.py`
> (`/api/sessions/{id}/scrollback`, `/api/sessions/{id}/input`, `GET /api/focus`,
> `/api/mcp/activity`, `/api/mcp/setup`), env injection in `session_manager.py`,
> and `McpConfig` in `config.py`. The binding surface lives in `CONTRACTS.md`;
> this file is the rationale. What actually shipped differs from the original
> sketch below in three ways: (1) no `mcp` SDK dependency — the JSON-RPC layer is
> hand-rolled to keep the bridge dependency-free; (2) auth reuses the existing
> `X-QuickTerm-Token` header rather than a separate `Bearer` scheme; (3) write
> tools ship **enabled** by default (`mcp.allow_input=true`), still capped and
> audited, with `send_input` refusing to target the caller's own session and
> `kill_session` limited to sessions the bridge itself spawned.

## Setup (the easy path)

Two steps, both one-time:

1. In QuickTerm Settings → Terminals, turn on **Allow AI tools (MCP)** for the
   profile you run your agent in (e.g. a "Claude" profile). Only that profile's
   terminals receive the QuickTerm token — it is not injected into every shell.
   (Or set `mcp.inject_all` in Advanced for the old blanket behavior.)
2. Register the bridge with your client:

```
claude mcp add quickterm -- quickterm-mcp     # Claude Code, once
quickterm-mcp --setup                          # prints this + a .mcp.json block
```

`GET /api/mcp/setup` returns the same config as JSON for the app UI to surface.
Inside such a pane, port/token/workspace are auto-discovered — no args needed.

## Original design sketch

(Kept for context; the shipped surface is authoritative in CONTRACTS.md.)

## Shape

A separate process, `quickterm-mcp`, speaking MCP over **stdio** (the client
launches it; no extra network listener). It talks to the running QuickTerm
server over the existing local REST/WS API on `127.0.0.1:<port>`.

Why a separate process instead of an endpoint inside the server:

- The web app's security model stays "browser window only" (Host/Origin
  allowlist, see server.py). No MCP surface is reachable from a browser.
- stdio MCP inherits the client's lifecycle: no daemon, no port, no auth
  handshake to invent. The trust boundary is "programs the user already runs".
- The server needs only one small addition: a loopback-only auth token file
  (`%APPDATA%/quickterm/mcp.token`, chmod 600 equivalent) that `quickterm-mcp`
  reads and sends as `Authorization: Bearer` — so a random local process that
  is *not* running as the user cannot use the API through the MCP path.

## Tools (v1)

Read-only by default:

| Tool | Maps to | Notes |
| --- | --- | --- |
| `list_sessions` | `GET /api/sessions` | id, name, profile, alive, size, touched |
| `read_terminal` | `GET /ws` replay or new `GET /api/sessions/{id}/scrollback` | returns plain text (ANSI stripped server-side), capped (default last 200 lines, `lines` param) |
| `list_workspaces` | `GET /api/workspaces` | names + pane counts |
| `get_focused_session` | `GET /api/focus` (new, trivial) | "what is the user looking at" |

Write tools, **disabled unless the user opts in** (config flag
`mcp.allow_input`, default false):

| Tool | Maps to | Guardrails |
| --- | --- | --- |
| `send_input` | WS write or new `POST /api/sessions/{id}/input` | max 4 KB per call; never allowed to a session whose `touched` is false and profile unknown; every use logged to the status bar |
| `spawn_session` | `POST /api/sessions` | profiles only, no arbitrary cmd |
| `kill_session` | `DELETE /api/sessions/{id}` | only sessions spawned via MCP |

Resources (optional, nice for Claude Desktop):
`terminal://{session_id}` → live scrollback text, subscribable.

## Consent & visibility model

- First MCP connection triggers a visible banner in the app ("An AI tool is
  connected — read-only"), with a one-click disconnect.
- Write access is a settings toggle plus per-session: a small badge on any
  pane an MCP client has written to.
- Everything the MCP server does is appended to a session-visible audit line
  (command palette: "mcp activity").

## Server-side additions needed (small, safe)

1. `GET /api/sessions/{id}/scrollback?lines=N&strip_ansi=1` — read the ring
   buffer without opening a WS (also useful for the dashboard later).
2. Bearer-token check middleware: token requests bypass the Origin rule
   (non-browser client) but must present the token file's value.
3. `POST /api/sessions/{id}/input` guarded by the same token + config flag.

## Packaging

- `quickterm-mcp` console script in pyproject (extra: `pip install quickterm[mcp]`,
  dep: `mcp` python SDK).
- Example client config:

```json
{
  "mcpServers": {
    "quickterm": { "command": "quickterm-mcp" }
  }
}
```

## Open questions

- Should `read_terminal` redact obvious secrets (password prompts) before
  returning text? Leaning yes: a regex pass for `password:`-style prompt lines.
- Rate limiting reads to keep an over-eager agent from hammering the ring
  buffer (probably 4 req/s is plenty).
- Whether `send_input` should require a per-call confirmation in the app UI
  ("Claude wants to run: `pytest -x`") — strongest option, adds friction.
  Default plan: banner + badge + audit, confirmation as an optional strict mode.
