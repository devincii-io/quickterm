"""quickterm-mcp — a Model Context Protocol server (stdio) that exposes a
QuickTerm workspace's terminals to an AI client (Claude Code, Claude Desktop, …).

Design (see docs/MCP_PLAN.md):

- A separate process the client launches; speaks MCP over stdio, so it inherits
  the client's lifecycle — no daemon, no extra listener, no new auth handshake.
- It drives the running QuickTerm backend over the existing loopback REST API on
  127.0.0.1, presenting the per-install token as `X-QuickTerm-Token`.
- Scope is one workspace. Inside a QuickTerm pane, discovery is automatic:
  QuickTerm injects QUICKTERM_PORT / QUICKTERM_TOKEN / QUICKTERM_SESSION_ID /
  QUICKTERM_WORKSPACE into the environment, so a Claude pane sees exactly its
  own workspace's sibling sessions with zero configuration. Outside a pane, pass
  --port / --workspace / --session (the token falls back to the runtime.token
  file). If no workspace can be resolved, tools operate over all live sessions
  and say so.

The MCP protocol layer is hand-rolled (newline-delimited JSON-RPC 2.0) so the
bridge stays dependency-free, matching QuickTerm's no-extra-deps ethos. It talks
to the backend with stdlib urllib; nothing here is written to stdout except
protocol messages.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

PROTOCOL_VERSION = "2025-06-18"

# Surfaced to the model via the `initialize` result's `instructions` field (and
# returned verbatim by the `about` tool). This is the LLM's primer on what the
# bridge is and how to use it well — keep it accurate and concise.
INSTRUCTIONS = """\
QuickTerm MCP — see and drive a local terminal workspace.

QuickTerm is a local terminal app where the user arranges terminal panes into
"workspaces" (a named set of terminals open together — e.g. a dev server, a test
runner, and this agent). This bridge is scoped to ONE workspace: you can observe
and control its sibling terminals, but terminals in other workspaces are
invisible to you. Scope is automatic — it is the workspace that contains your own
session.

Start here:
  1. `whoami` — your own session id, the workspace you're scoped to, how many
     sessions are in scope. Call this first to get oriented.
  2. `list_sessions` — the terminals in scope: id, name, profile, alive, busy,
     and whether each has been typed into.

Read:
  - `read_terminal(session_id, lines?, strip_ansi?)` — a terminal's recent
     output as plain text. Use a session_id from list_sessions.
  - `get_focused_session` — which terminal the user is looking at right now.
  - `list_workspaces` — all workspace names (yours is marked).

Drive (writes are ENABLED by default, but capped and shown to the user):
  - `send_input(session_id, text)` — type into a terminal. Text is sent verbatim,
     so include a trailing "\\r" to submit a command: text="pytest -q\\r". You
     cannot type into your OWN session.
  - `spawn_session(profile)` — open a new background terminal from a saved
     profile (not an arbitrary command); it joins your workspace.
  - `kill_session(session_id)` — end a terminal you spawned (never the user's).

Etiquette: these are the user's real, live terminals. Prefer reading before
writing; read a terminal's recent output to see its state before sending keys.
Do not run destructive or unexpected commands unless asked — every keystroke you
send is surfaced to the user with an audit trail.
"""


# --- backend REST client ----------------------------------------------------


class BackendError(Exception):
    """A QuickTerm REST call failed (HTTP error or unreachable backend)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class RestBackend:
    """Thin urllib client for QuickTerm's loopback API, carrying the token."""

    def __init__(
        self,
        host: str,
        port: int,
        token: str,
        *,
        opener: Callable[..., Any] | None = None,
        timeout: float = 10.0,
    ) -> None:
        self.base = f"http://{host}:{port}"
        self.token = token
        self._timeout = timeout
        self._urlopen = opener or urllib.request.urlopen

    def _request(
        self, method: str, path: str, *, params: dict | None = None, body: Any = None
    ) -> Any:
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers: dict[str, str] = {}
        if self.token:
            headers["X-QuickTerm-Token"] = self.token
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with self._urlopen(req, timeout=self._timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            body_text = ""
            try:
                body_text = exc.read().decode("utf-8", "replace")
            except Exception:
                pass
            raise BackendError(exc.code, _detail(body_text) or exc.reason or "http error") from None
        except urllib.error.URLError as exc:
            raise BackendError(
                0, f"cannot reach QuickTerm at {self.base} ({exc.reason})"
            ) from None
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

    def list_sessions(self) -> list[dict]:
        return self._request("GET", "/api/sessions") or []

    def list_workspaces(self) -> list[str]:
        return self._request("GET", "/api/workspaces") or []

    def get_workspace(self, name: str) -> dict | None:
        try:
            return self._request("GET", "/api/workspaces/" + urllib.parse.quote(name, safe=""))
        except BackendError as exc:
            if exc.status == 404:
                return None
            raise

    def scrollback(self, sid: str, lines: int, strip_ansi: bool) -> dict:
        return self._request(
            "GET",
            "/api/sessions/" + urllib.parse.quote(sid, safe="") + "/scrollback",
            params={"lines": lines, "strip_ansi": "true" if strip_ansi else "false"},
        )

    def send_input(self, sid: str, text: str) -> dict:
        return self._request(
            "POST", "/api/sessions/" + urllib.parse.quote(sid, safe="") + "/input",
            body={"text": text},
        )

    def spawn(self, spec: dict) -> dict:
        return self._request("POST", "/api/sessions", body=spec)

    def kill(self, sid: str) -> None:
        self._request("DELETE", "/api/sessions/" + urllib.parse.quote(sid, safe=""))

    def focus(self) -> dict:
        return self._request("GET", "/api/focus") or {}


def _detail(body_text: str) -> str:
    try:
        payload = json.loads(body_text)
    except (ValueError, TypeError):
        return body_text.strip()
    if isinstance(payload, dict) and "detail" in payload:
        return str(payload["detail"])
    return body_text.strip()


# --- workspace scoping + tools ----------------------------------------------


class ToolError(Exception):
    """A tool refused or could not complete — surfaced as an MCP tool error."""


def _layout_ids(node: Any, out: set[str]) -> None:
    if not isinstance(node, dict):
        return
    if node.get("type") == "split":
        for child in node.get("children", []) or []:
            _layout_ids(child, out)
        return
    sid = node.get("session_id")
    if isinstance(sid, str) and sid:
        out.add(sid)


class QuickTerm:
    """Workspace-scoped view over the QuickTerm backend, and the MCP tools."""

    def __init__(
        self, backend: RestBackend, *, own_session: str | None = None, workspace: str | None = None
    ) -> None:
        self.backend = backend
        self.own_session = own_session or None
        self.workspace_override = workspace or None
        self._spawned: set[str] = set()

    # scope resolution -------------------------------------------------------

    def _member_ids(self, ws: dict) -> set[str]:
        ids = set(ws.get("session_ids") or [])
        _layout_ids(ws.get("layout") or {}, ids)
        return ids

    def _resolve_workspace(self, sessions: list[dict]) -> str | None:
        if self.workspace_override:
            return self.workspace_override
        # Live workspace-file membership is authoritative: it reflects a
        # scratch that has since been named, which the spawn-time tag would not.
        if self.own_session:
            for name in self.backend.list_workspaces():
                ws = self.backend.get_workspace(name)
                if ws and self.own_session in self._member_ids(ws):
                    return name
        # Fall back to the spawn-time tag (e.g. a not-yet-saved session).
        by_id = {s.get("id"): s for s in sessions}
        if self.own_session and self.own_session in by_id:
            tagged = by_id[self.own_session].get("workspace")
            if tagged:
                return tagged
        return None

    def scoped(self) -> tuple[str | None, list[dict], list[dict]]:
        """Return (workspace_name_or_None, sessions_in_scope, all_sessions).

        When no workspace resolves, scope is every live session (unscoped) and
        the name is None — tools make that explicit to the caller.
        """
        sessions = self.backend.list_sessions()
        name = self._resolve_workspace(sessions)
        if not name:
            return None, sessions, sessions
        members: set[str] = set()
        ws = self.backend.get_workspace(name)
        if ws:
            members |= self._member_ids(ws)
        members |= {s.get("id") for s in sessions if s.get("workspace") == name}
        members |= self._spawned
        if self.own_session:
            members.add(self.own_session)
        in_scope = [s for s in sessions if s.get("id") in members]
        return name, in_scope, sessions

    def _require_in_scope(self, sid: str) -> dict:
        name, in_scope, _ = self.scoped()
        for s in in_scope:
            if s.get("id") == sid:
                return s
        where = f"workspace '{name}'" if name else "the current scope"
        raise ToolError(f"session {sid} is not in {where}; call list_sessions to see valid ids")

    # tool dispatch ----------------------------------------------------------

    def call_tool(self, name: str, args: dict) -> str:
        handler = _TOOL_HANDLERS.get(name)
        if handler is None:
            raise ToolError(f"unknown tool: {name}")
        return handler(self, args or {})

    # tools ------------------------------------------------------------------

    def tool_about(self, args: dict) -> str:
        # The LLM's on-demand primer: the same guide surfaced at initialize,
        # plus a pointer to live orientation.
        return INSTRUCTIONS + "\nCall `whoami` for your live session and scope.\n"

    def tool_whoami(self, args: dict) -> str:
        name, in_scope, _all = self.scoped()
        return _json(
            {
                "own_session": self.own_session,
                "workspace": name,
                "scoped": name is not None,
                "sessions_in_scope": len(in_scope),
                "backend": self.backend.base,
                "note": (
                    "Scoped to one workspace; other workspaces are invisible."
                    if name
                    else "No workspace resolved — operating over ALL live sessions."
                ),
            }
        )

    def tool_list_sessions(self, args: dict) -> str:
        name, in_scope, _all = self.scoped()
        rows = [
            {
                "id": s.get("id"),
                "name": s.get("name"),
                "profile": s.get("profile"),
                "alive": s.get("alive"),
                "exit_code": s.get("exit_code"),
                "busy": s.get("busy", False),
                "touched": s.get("touched", False),
                "mcp_touched": s.get("mcp_touched", False),
                "cols": s.get("cols"),
                "rows": s.get("rows"),
                "is_self": s.get("id") == self.own_session,
            }
            for s in in_scope
        ]
        return _json({"workspace": name, "scoped": name is not None, "count": len(rows), "sessions": rows})

    def tool_read_terminal(self, args: dict) -> str:
        sid = _str_arg(args, "session_id")
        lines = _int_arg(args, "lines", default=200)
        strip_ansi = bool(args.get("strip_ansi", True))
        self._require_in_scope(sid)
        result = self.backend.scrollback(sid, lines, strip_ansi)
        text = result.get("text", "")
        header_bits = [f"session {sid}"]
        if not result.get("alive", True):
            header_bits.append(f"exited (code {result.get('exit_code')})")
        if result.get("truncated"):
            header_bits.append(f"last {lines} lines")
        header = "── " + ", ".join(header_bits) + " ──"
        return f"{header}\n{text}" if text else f"{header}\n(no output yet)"

    def tool_send_input(self, args: dict) -> str:
        sid = _str_arg(args, "session_id")
        text = args.get("text")
        if not isinstance(text, str) or text == "":
            raise ToolError("'text' must be a non-empty string (include \\r or \\n to submit)")
        if sid == self.own_session:
            raise ToolError("refusing to type into your own session")
        self._require_in_scope(sid)
        result = self.backend.send_input(sid, text)
        return f"sent {result.get('written', len(text.encode()))} bytes to session {sid}"

    def tool_spawn_session(self, args: dict) -> str:
        profile = _str_arg(args, "profile")
        name, _in_scope, _all = self.scoped()
        spec: dict = {"profile": profile}
        if args.get("name"):
            spec["name"] = str(args["name"])
        if args.get("cwd"):
            spec["cwd"] = str(args["cwd"])
        if name:
            spec["workspace"] = name  # join the caller's workspace
        info = self.backend.spawn(spec)
        sid = info.get("id")
        if isinstance(sid, str):
            self._spawned.add(sid)
        return _json({"spawned": info, "workspace": name, "note": "background session (not in the visible layout)"})

    def tool_kill_session(self, args: dict) -> str:
        sid = _str_arg(args, "session_id")
        if sid not in self._spawned:
            raise ToolError("kill is limited to sessions this MCP spawned (via spawn_session)")
        self.backend.kill(sid)
        self._spawned.discard(sid)
        return f"killed session {sid}"

    def tool_list_workspaces(self, args: dict) -> str:
        current, _in_scope, _all = self.scoped()
        names = self.backend.list_workspaces()
        return _json(
            {
                "current": current,
                "workspaces": [{"name": n, "is_current": n == current} for n in names],
            }
        )

    def tool_get_focused_session(self, args: dict) -> str:
        focused = self.backend.focus().get("session_id")
        _name, in_scope, _all = self.scoped()
        in_scope_ids = {s.get("id") for s in in_scope}
        match = next((s for s in in_scope if s.get("id") == focused), None)
        return _json(
            {
                "session_id": focused,
                "in_scope": focused in in_scope_ids if focused else False,
                "name": match.get("name") if match else None,
                "is_self": focused == self.own_session,
            }
        )


# Tool schemas advertised via tools/list. Kept beside the handlers so the two
# never drift.
TOOLS: list[dict] = [
    {
        "name": "about",
        "description": "Explain what this QuickTerm MCP bridge is and how to use its "
        "tools (workspace scope, reading vs. driving terminals, etiquette). Call it "
        "if you're unsure how the terminals here work.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "whoami",
        "description": "Report this MCP bridge's context: your own session id, the "
        "workspace it is scoped to (if any), and how many sessions are in scope.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_sessions",
        "description": "List the terminal sessions in the current workspace scope "
        "(id, name, profile, alive, busy, whether it has been typed into). Other "
        "workspaces are not shown.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "read_terminal",
        "description": "Read a session's recent output as plain text (ANSI stripped "
        "by default). Use list_sessions first to get a session_id in scope.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "id from list_sessions"},
                "lines": {"type": "integer", "description": "how many trailing lines (default 200)"},
                "strip_ansi": {"type": "boolean", "description": "strip color/escape codes (default true)"},
            },
            "required": ["session_id"],
        },
    },
    {
        "name": "send_input",
        "description": "Type text into a session in scope. Include a trailing \\r (or "
        "\\n) to submit a command. Cannot target your own session. Capped and "
        "audited by the backend.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "text": {"type": "string", "description": "bytes to send verbatim; add \\r to run"},
            },
            "required": ["session_id", "text"],
        },
    },
    {
        "name": "spawn_session",
        "description": "Start a new background terminal from a saved profile, joined "
        "to the current workspace. Arbitrary commands are not allowed — profiles only.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "profile": {"type": "string", "description": "a profile name (see /api/profiles)"},
                "name": {"type": "string"},
                "cwd": {"type": "string"},
            },
            "required": ["profile"],
        },
    },
    {
        "name": "kill_session",
        "description": "Kill a session that THIS bridge spawned via spawn_session. It "
        "cannot kill terminals the user opened.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": {"type": "string"}},
            "required": ["session_id"],
        },
    },
    {
        "name": "list_workspaces",
        "description": "List all workspace names and mark the one this bridge is scoped to.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_focused_session",
        "description": "Which session the user is currently looking at, and whether it "
        "is in your workspace scope.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]

_TOOL_HANDLERS: dict[str, Callable[["QuickTerm", dict], str]] = {
    "about": QuickTerm.tool_about,
    "whoami": QuickTerm.tool_whoami,
    "list_sessions": QuickTerm.tool_list_sessions,
    "read_terminal": QuickTerm.tool_read_terminal,
    "send_input": QuickTerm.tool_send_input,
    "spawn_session": QuickTerm.tool_spawn_session,
    "kill_session": QuickTerm.tool_kill_session,
    "list_workspaces": QuickTerm.tool_list_workspaces,
    "get_focused_session": QuickTerm.tool_get_focused_session,
}


def _json(obj: Any) -> str:
    return json.dumps(obj, indent=2)


def _str_arg(args: dict, key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value:
        raise ToolError(f"'{key}' is required and must be a non-empty string")
    return value


def _int_arg(args: dict, key: str, *, default: int) -> int:
    value = args.get(key, default)
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# --- JSON-RPC / MCP protocol layer ------------------------------------------


class Server:
    """MCP request handler over a QuickTerm scope. Pure (no I/O of its own)."""

    def __init__(self, quickterm: QuickTerm) -> None:
        self.qt = quickterm

    def handle(self, msg: dict) -> dict | None:
        """Process one JSON-RPC message; return a response, or None for a
        notification (no id)."""
        is_request = isinstance(msg, dict) and "id" in msg
        mid = msg.get("id") if isinstance(msg, dict) else None
        method = msg.get("method") if isinstance(msg, dict) else None
        if not method:
            return _error(mid, -32600, "invalid request") if is_request else None
        try:
            if method == "initialize":
                result: Any = self._initialize(msg.get("params") or {})
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                result = self._tools_call(msg.get("params") or {})
            elif method.startswith("notifications/"):
                return None  # initialized, cancelled, … — nothing to answer
            else:
                return _error(mid, -32601, f"method not found: {method}") if is_request else None
        except Exception as exc:  # protocol-level failure
            return _error(mid, -32603, str(exc)) if is_request else None
        if not is_request:
            return None
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    def _initialize(self, params: dict) -> dict:
        return {
            "protocolVersion": params.get("protocolVersion", PROTOCOL_VERSION),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "quickterm", "version": _version()},
            # Surfaced to the model by MCP hosts so it understands the bridge
            # before calling anything; also available on demand via the `about` tool.
            "instructions": INSTRUCTIONS,
        }

    def _tools_call(self, params: dict) -> dict:
        name = params.get("name")
        args = params.get("arguments") or {}
        try:
            text = self.qt.call_tool(name, args)
        except (ToolError, BackendError) as exc:
            return {"content": [{"type": "text", "text": f"error: {exc}"}], "isError": True}
        except Exception as exc:  # never crash the tool call over one bad request
            return {"content": [{"type": "text", "text": f"unexpected error: {exc}"}], "isError": True}
        return {"content": [{"type": "text", "text": text}], "isError": False}


def _error(mid: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def serve(server: Server, stdin: Any, stdout: Any) -> None:
    """Newline-delimited JSON-RPC loop over the given streams."""
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            _emit(stdout, _error(None, -32700, "parse error"))
            continue
        response = server.handle(msg)
        if response is not None:
            _emit(stdout, response)


def _emit(stdout: Any, obj: dict) -> None:
    stdout.write(json.dumps(obj) + "\n")
    stdout.flush()


# --- bootstrap --------------------------------------------------------------


def _version() -> str:
    try:
        from quickterm import __version__

        return __version__
    except Exception:
        return "0"


def _resolve_port(args: argparse.Namespace) -> int:
    if args.port:
        return int(args.port)
    env_port = os.environ.get("QUICKTERM_PORT")
    if env_port:
        try:
            return int(env_port)
        except ValueError:
            pass
    try:
        from quickterm.config import load_config

        return int(load_config().port)
    except Exception:
        return 8620


def _resolve_token(args: argparse.Namespace) -> str:
    if args.token:
        return str(args.token)
    env_token = os.environ.get("QUICKTERM_TOKEN")
    if env_token:
        return env_token
    path = args.token_file
    if not path:
        try:
            from quickterm import auth

            path = str(auth.token_path())
        except Exception:
            path = None
    if path:
        try:
            with open(path, encoding="utf-8") as handle:
                return handle.read().strip()
        except OSError:
            pass
    return ""


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="quickterm-mcp",
        description="MCP bridge exposing a QuickTerm workspace's terminals to an AI client.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="backend host (default 127.0.0.1)")
    parser.add_argument("--port", type=int, help="backend port (else $QUICKTERM_PORT, else config)")
    parser.add_argument("--token", help="auth token (else $QUICKTERM_TOKEN, else the runtime.token file)")
    parser.add_argument("--token-file", help="read the auth token from this file")
    parser.add_argument("--workspace", help="scope to this workspace (else $QUICKTERM_WORKSPACE, else auto)")
    parser.add_argument("--session", help="this client's own session id (else $QUICKTERM_SESSION_ID)")
    parser.add_argument(
        "--setup", action="store_true",
        help="print copy-paste setup for Claude Code / any MCP client, then exit",
    )
    return parser.parse_args(argv)


def mcp_invocation() -> tuple[str, list[str]]:
    """How to launch this bridge on this install: (command, args).

    A pip/uv install exposes the `quickterm-mcp` console script. A frozen build
    is one windowed exe, so it re-serves itself via the `mcp` subcommand
    (`QuickTerm.exe mcp`).
    """
    if getattr(sys, "frozen", False):
        return sys.executable, ["mcp"]
    return "quickterm-mcp", []


def setup_message(command: str | None = None, args: list[str] | None = None) -> str:
    """One-screen instructions to register this bridge with an MCP client."""
    if command is None:
        command, args = mcp_invocation()
    args = args or []
    quoted = f'"{command}"' if " " in command else command
    invocation = quoted if not args else quoted + " " + " ".join(args)
    server_entry: dict[str, Any] = {"command": command}
    if args:
        server_entry["args"] = args
    config = json.dumps({"mcpServers": {"quickterm": server_entry}}, indent=2)
    # ASCII only: this prints to a terminal that may be a Windows console (cp1252).
    return (
        "QuickTerm MCP - set up in one step\n"
        "==================================\n\n"
        "Claude Code - run once (registers a user-scoped server):\n\n"
        f"    claude mcp add quickterm -- {invocation}\n\n"
        "...or drop this into a project .mcp.json (or ~/.claude.json):\n\n"
        f"{config}\n\n"
        "No port/token/workspace needed: launched inside a QuickTerm pane, the\n"
        "bridge auto-discovers them from the environment and scopes to that pane's\n"
        "workspace. Outside a pane, add args, e.g.\n"
        '    "args": ["--port", "8620", "--workspace", "myproject"]\n\n'
        "Then in Claude Code: run /mcp to confirm it connected, and call the\n"
        "whoami tool to see the workspace it is scoped to.\n"
    )


def _bind_stdio():
    """Return (stdin, stdout) text streams bound to the process's real standard
    handles.

    A PyInstaller *windowed* build (console=False, as QuickTerm ships) sets
    sys.stdin/sys.stdout to None — so when `QuickTerm.exe mcp` is launched over
    pipes by an MCP client, we must reopen the OS standard handles ourselves.
    When sys.stdin/stdout already work (dev, console builds), use them as-is.
    """
    import io

    if sys.stdin is not None and sys.stdout is not None:
        return sys.stdin, sys.stdout
    binary = getattr(os, "O_BINARY", 0)
    try:  # Windows: rebuild from GetStdHandle so a windowed exe can talk stdio
        import ctypes
        import msvcrt

        kernel32 = ctypes.windll.kernel32
        kernel32.GetStdHandle.restype = ctypes.c_void_p
        fd_in = msvcrt.open_osfhandle(kernel32.GetStdHandle(-10), os.O_RDONLY | binary)
        fd_out = msvcrt.open_osfhandle(kernel32.GetStdHandle(-11), os.O_WRONLY | binary)
    except Exception:  # non-Windows or no handles: fall back to raw fds
        fd_in, fd_out = 0, 1
    stdin = io.TextIOWrapper(io.FileIO(fd_in, "r"), encoding="utf-8", newline="")
    stdout = io.TextIOWrapper(io.FileIO(fd_out, "w"), encoding="utf-8", newline="")
    return stdin, stdout


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)
    stdin, stdout = _bind_stdio()
    if args.setup:
        stdout.write(setup_message())
        stdout.flush()
        return
    backend = RestBackend(args.host, _resolve_port(args), _resolve_token(args))
    quickterm = QuickTerm(
        backend,
        own_session=args.session or os.environ.get("QUICKTERM_SESSION_ID"),
        workspace=args.workspace or os.environ.get("QUICKTERM_WORKSPACE"),
    )
    serve(Server(quickterm), stdin, stdout)


if __name__ == "__main__":
    main()
