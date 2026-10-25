"""Every Claude Code and Codex sign-in on this computer and its limits.

QuickTerm used to know Claude's limits only from the status line of a Claude
it started, so a fresh backend, or Claude run anywhere else, showed nothing.
This module finds the sign-ins themselves, on this PC and in every running
WSL distribution, and groups them by account, so one login used from two
places is one entry:

- Claude Code keeps its account in ``.claude.json`` (``oauthAccount``, plus a
  ``cachedUsageUtilization`` it refreshes only when ``/usage`` runs) and its
  sign-in in ``.credentials.json``. With a sign-in that has not expired, the
  current limits come from the usage route Claude Code itself calls on
  api.anthropic.com. The token is read for that one request, sent nowhere
  else, never stored, never logged, and never refreshed: renewing it is
  Claude Code's job, and a second refresher would rotate it under Claude.
  ``AppConfig.usage_online`` turns the request off; the status line and
  Claude Code's own cache still answer then.
- Codex keeps its account in ``auth.json`` (the claims of its ``id_token``,
  read without the tokens themselves) and its limits in every session
  rollout, read as ``usage.CodexReader`` does.

An SSH host's sign-ins stay on that host. Limits are per account, so an
account also signed in here covers its use there; a status-line report from
a place with no sign-in found here becomes an entry of its own.

Every read here is blocking and runs in a background thread; ``GET
/api/usage`` answers from what the last refresh found.
"""

from __future__ import annotations

import base64
import concurrent.futures
import http.client
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from quickterm import usage

log = logging.getLogger(__name__)

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
OAUTH_BETA = "oauth-2025-04-20"
# How often the backend asks Anthropic per account while someone looks, and
# how long it waits after a refusal (an expired or revoked sign-in, a limit).
LIVE_TTL_S = 120.0
FAILED_TTL_S = 600.0
DISCOVER_TTL_S = 60.0
REQUEST_TIMEOUT_S = 10.0
# .claude.json grows with project history; anything larger is not one.
CONFIG_MAX_BYTES = 32 * 1024 * 1024
AUTH_MAX_BYTES = 1024 * 1024
# A sign-in that ends within this many seconds is left to Claude Code.
EXPIRY_MARGIN_S = 60
_EXTRA_HOME = re.compile(r"^\.(claude|codex)[-_.][A-Za-z0-9._-]{1,40}$")
_WSL_USER = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


# --- where sign-ins live ----------------------------------------------------------


@dataclass(frozen=True)
class Home:
    """One agent's files in one place: ``config`` (Claude's ``.claude.json``,
    Codex's home folder), ``auth`` (Claude's ``.credentials.json``, Codex's
    ``auth.json``), and ``where`` as the popover names it."""

    agent: str
    where: str
    origin: str
    config: Path
    auth: Path


def _claude_homes(base: Path, where: str, origin: str, extra: list[Path]) -> list[Home]:
    """The default layout under the home folder ``base``, then each
    ``CLAUDE_CONFIG_DIR``-style folder (``extra`` and ``~/.claude-*``)."""
    homes = [Home("claude", where, origin, base / ".claude.json", base / ".claude" / ".credentials.json")]
    folders = list(extra)
    try:
        folders += [
            Path(entry.path) for entry in os.scandir(base)
            if entry.is_dir() and _EXTRA_HOME.match(entry.name) and entry.name.startswith(".claude")
        ]
    except OSError:
        pass
    for folder in folders:
        homes.append(Home("claude", f"{where} · {folder.name}", origin,
                          folder / ".claude.json", folder / ".credentials.json"))
    return homes


def _codex_homes(base: Path, where: str, origin: str, extra: list[Path]) -> list[Home]:
    folders = [base / ".codex", *extra]
    try:
        folders += [
            Path(entry.path) for entry in os.scandir(base)
            if entry.is_dir() and _EXTRA_HOME.match(entry.name) and entry.name.startswith(".codex")
        ]
    except OSError:
        pass
    homes = []
    for folder in folders:
        label = where if folder.name == ".codex" and folder.parent == base else f"{where} · {folder.name}"
        homes.append(Home("codex", label, origin, folder, folder / "auth.json"))
    return homes


def _wsl_bases(distro: str) -> list[tuple[Path, str]]:
    """Home folders of a running distribution, through its UNC share."""
    root = Path(f"\\\\wsl.localhost\\{distro}")
    bases = [(root / "root", "root")]
    try:
        for entry in os.scandir(root / "home"):
            if entry.is_dir() and _WSL_USER.match(entry.name):
                bases.append((Path(entry.path), entry.name))
    except OSError:
        pass
    return bases


def discover(env_dirs: dict[str, list[str]] | None = None, *, running_distros: Callable[[], Any] | None = None) -> list[Home]:
    """Every place a Claude Code or Codex sign-in may live on this computer.

    ``env_dirs`` adds folders named by settings (``{"claude": [...],
    "codex": [...]}``, from ``CLAUDE_CONFIG_DIR`` and ``CODEX_HOME``). WSL
    distributions are read only while running: reading a stopped one would
    start it. Blocking."""
    extra = {agent: [Path(p) for p in (env_dirs or {}).get(agent, []) if p] for agent in ("claude", "codex")}
    for name, agent in (("CLAUDE_CONFIG_DIR", "claude"), ("CODEX_HOME", "codex")):
        value = os.environ.get(name)
        if value:
            extra[agent].append(Path(value))
    home = Path.home()
    homes = [
        *_claude_homes(home, "This PC", "local", extra["claude"]),
        *_codex_homes(home, "This PC", "local", extra["codex"]),
    ]
    if os.name == "nt":
        if running_distros is None:
            from quickterm import ws_exec

            running_distros = ws_exec._running_distros
        try:
            distros = sorted(running_distros())
        except Exception:
            distros = []
        for distro in distros:
            for base, user in _wsl_bases(distro):
                where = f"WSL: {distro} ({user})"
                homes += _claude_homes(base, where, f"wsl:{distro}", [])
                homes += _codex_homes(base, where, f"wsl:{distro}", [])
    # One folder named twice (a setting and the default) is read once.
    seen: set[tuple[str, str]] = set()
    unique = []
    for entry in homes:
        key = (entry.agent, os.path.normcase(str(entry.config)))
        if key not in seen:
            seen.add(key)
            unique.append(entry)
    return unique


# --- reading one place ------------------------------------------------------------


def _read_json(path: Path, limit: int) -> Any:
    try:
        if path.stat().st_size > limit:
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError, UnicodeError):
        return None


def _text(value: Any, limit: int = 200) -> str | None:
    return value.strip()[:limit] if isinstance(value, str) and value.strip() else None


CLAUDE_KIND_LABELS = {"session": "5 hours", "weekly_all": "7 days"}
CLAUDE_FIELD_LABELS = {
    "five_hour": "5 hours", "seven_day": "7 days",
    "seven_day_opus": "7 days · Opus", "seven_day_sonnet": "7 days · Sonnet",
}


def claude_windows(utilization: Any) -> list[dict[str, Any]]:
    """The windows of Claude's usage answer (the route's body, or Claude
    Code's ``cachedUsageUtilization.utilization``). The ``limits`` list is
    newer and names model-scoped weeks; the fixed fields are the fallback."""
    if not isinstance(utilization, dict):
        return []
    windows: list[dict[str, Any]] = []
    limits = utilization.get("limits")
    if isinstance(limits, list):
        for item in limits:
            if not isinstance(item, dict):
                continue
            kind = _text(item.get("kind"), 40)
            used = usage._percent(item.get("percent"))
            if kind is None or used is None:
                continue
            label = CLAUDE_KIND_LABELS.get(kind)
            model = None
            scope = item.get("scope")
            if isinstance(scope, dict) and isinstance(scope.get("model"), dict):
                model = _text(scope["model"].get("display_name"), 40)
            if label is None:
                label = f"7 days · {model}" if model and kind.startswith("weekly") else kind.replace("_", " ")
            windows.append({
                "id": f"{kind}:{model}" if model else kind,
                "label": label,
                "used_percent": used,
                "resets_at": usage._epoch(item.get("resets_at")),
            })
    if windows:
        return windows
    for key, label in CLAUDE_FIELD_LABELS.items():
        window = utilization.get(key)
        if not isinstance(window, dict):
            continue
        used = usage._percent(window.get("utilization"))
        if used is None:
            continue
        windows.append({"id": key, "label": label, "used_percent": used,
                        "resets_at": usage._epoch(window.get("resets_at"))})
    return windows


@dataclass
class ClaudeSignIn:
    """What one Claude home says: the account, Claude Code's cached usage,
    and whether a usable sign-in is there (the token itself is not kept)."""

    home: Home
    account: str | None = None
    email: str | None = None
    organization: str | None = None
    plan: str | None = None
    cached: list[dict[str, Any]] = field(default_factory=list)
    cached_at: int | None = None
    signed_in: bool = False
    expires_at: int | None = None


def read_claude(home: Home) -> ClaudeSignIn | None:
    """The account in ``home``, or None when no one is signed in there."""
    config = _read_json(home.config, CONFIG_MAX_BYTES)
    credentials = _read_json(home.auth, AUTH_MAX_BYTES)
    oauth = credentials.get("claudeAiOauth") if isinstance(credentials, dict) else None
    account = config.get("oauthAccount") if isinstance(config, dict) else None
    if not isinstance(account, dict) and not isinstance(oauth, dict):
        return None
    found = ClaudeSignIn(home)
    if isinstance(account, dict):
        found.account = _text(account.get("accountUuid"), 80)
        found.email = _text(account.get("emailAddress"))
        found.organization = _text(account.get("organizationName"))
        found.plan = _text(account.get("organizationType"), 60)
    if isinstance(oauth, dict):
        found.plan = found.plan or _text(oauth.get("subscriptionType"), 60)
        expires = usage._number(oauth.get("expiresAt"))
        found.expires_at = int(expires / 1000) if expires else None
        found.signed_in = isinstance(oauth.get("accessToken"), str) and bool(oauth.get("accessToken"))
    cached = config.get("cachedUsageUtilization") if isinstance(config, dict) else None
    if isinstance(cached, dict) and (found.account is None or cached.get("accountUuid") in (None, found.account)):
        found.cached = claude_windows(cached.get("utilization"))
        fetched = usage._number(cached.get("fetchedAtMs"))
        found.cached_at = int(fetched / 1000) if fetched else None
    return found


def _token(home: Home) -> str | None:
    """The access token, read for one request and dropped with it."""
    credentials = _read_json(home.auth, AUTH_MAX_BYTES)
    oauth = credentials.get("claudeAiOauth") if isinstance(credentials, dict) else None
    token = oauth.get("accessToken") if isinstance(oauth, dict) else None
    return token if isinstance(token, str) and token else None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """The token goes to api.anthropic.com and nowhere a redirect points."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def fetch_claude(home: Home, *, opener: Callable[..., Any] = _OPENER.open) -> tuple[list[dict[str, Any]], str | None]:
    """The current windows from Anthropic, or ``([], reason)``."""
    token = _token(home)
    if token is None:
        return [], "not signed in"
    from quickterm import __version__

    request = urllib.request.Request(USAGE_URL, headers={
        "Authorization": f"Bearer {token}",
        "anthropic-beta": OAUTH_BETA,
        "Accept": "application/json",
        "User-Agent": f"QuickTerm/{__version__}",
    })
    del token
    try:
        with opener(request, timeout=REQUEST_TIMEOUT_S) as response:
            body = response.read(AUTH_MAX_BYTES + 1)
        if len(body) > AUTH_MAX_BYTES:
            return [], "answer too large"
        windows = claude_windows(json.loads(body))
    except urllib.error.HTTPError as exc:
        reason = "sign-in expired; open Claude Code to renew it" if exc.code in (401, 403) else f"HTTP {exc.code}"
        return [], reason
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError, RecursionError) as exc:
        return [], f"unreachable ({type(exc).__name__})"
    return windows, None if windows else "no limits in the answer"


@dataclass
class CodexSignIn:
    home: Home
    account: str | None = None
    email: str | None = None
    plan: str | None = None


def _jwt_claims(token: Any) -> dict:
    """The claims of a JWT, unverified: only names and ids are read."""
    if not isinstance(token, str) or token.count(".") != 2:
        return {}
    part = token.split(".")[1]
    try:
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (ValueError, RecursionError):
        return {}
    return claims if isinstance(claims, dict) else {}


def read_codex(home: Home) -> CodexSignIn | None:
    auth = _read_json(home.auth, AUTH_MAX_BYTES)
    if not isinstance(auth, dict):
        return None
    tokens = auth.get("tokens") if isinstance(auth.get("tokens"), dict) else {}
    claims = _jwt_claims(tokens.get("id_token"))
    openai = claims.get("https://api.openai.com/auth") if isinstance(claims.get("https://api.openai.com/auth"), dict) else {}
    found = CodexSignIn(home)
    found.account = _text(openai.get("chatgpt_account_id"), 80) or _text(tokens.get("account_id"), 80)
    found.email = _text(claims.get("email"))
    found.plan = _text(openai.get("chatgpt_plan_type"), 40)
    if found.account is None and found.email is None:
        # An API-key sign-in has no account and no plan limits.
        return None
    return found


# --- the accounts -------------------------------------------------------------------


@dataclass
class _Live:
    at: float  # when the windows were current
    windows: list[dict[str, Any]]
    error: str | None
    asked: float = 0.0  # when Anthropic was last asked; decides the next ask


class Accounts:
    """The grouped accounts and their limits, refreshed in the background.

    ``snapshot()`` never waits: it returns what the last refresh found and
    starts the next one when that is older than its TTL."""

    def __init__(
        self,
        *,
        claude_limits: usage.ClaudeLimits | None = None,
        online: Callable[[], bool] = lambda: True,
        env_dirs: Callable[[], dict[str, list[str]]] = lambda: {},
        clock: Callable[[], float] = time.time,
        fetch: Callable[[Home], tuple[list[dict[str, Any]], str | None]] = fetch_claude,
        homes: Callable[[], list[Home]] | None = None,
        submit: Callable[..., Any] | None = None,
        running_distros: Callable[[], Any] | None = None,
    ) -> None:
        self._claude_limits = claude_limits
        self._online = online
        self._env_dirs = env_dirs
        self._clock = clock
        self._fetch = fetch
        self._homes = homes or (lambda: discover(self._env_dirs()))
        self._submit = submit
        self._running = running_distros or _running_distros
        self._lock = threading.Lock()
        self._running = False
        self._refreshed_at = 0.0
        self._discovered_at = 0.0
        self._found: list[Home] = []
        self._live: dict[str, _Live] = {}
        self._codex: dict[str, usage.CodexReader] = {}
        self._accounts: list[dict[str, Any]] = []
        # Off until the real backend turns it on (app.py), so app tests never
        # read this computer's sign-ins or reach the network.
        self.enabled = False

    # The refresh ----------------------------------------------------------------

    def refresh(self) -> None:
        """Blocking: discover, read, ask Anthropic where due, group."""
        now = self._clock()
        if not self._found or now - self._discovered_at >= DISCOVER_TTL_S:
            self._found = self._homes()
            self._discovered_at = now
        homes = self._awake(self._found)
        claude = [found for home in homes if home.agent == "claude" and (found := read_claude(home))]
        codex = [found for home in homes if home.agent == "codex" and (found := read_codex(home))]
        accounts = self._group_claude(claude, now) + self._group_codex(codex)
        with self._lock:
            self._accounts = accounts
            self._refreshed_at = self._clock()

    def _awake(self, homes: list[Home]) -> list[Home]:
        """Without the homes of WSL distributions stopped since discovery:
        opening a stopped distribution's share starts it."""
        if not any(home.origin.startswith("wsl:") for home in homes):
            return homes
        try:
            running = self._running()
        except Exception:
            running = frozenset()
        return [home for home in homes if not home.origin.startswith("wsl:") or home.origin[4:] in running]

    def _key(self, account: str | None, email: str | None, home: Home) -> str:
        return account or (f"email:{email.lower()}" if email else f"home:{home.config}")

    def _group_claude(self, found: list[ClaudeSignIn], now: float) -> list[dict[str, Any]]:
        groups: dict[str, list[ClaudeSignIn]] = {}
        for sign_in in found:
            groups.setdefault(self._key(sign_in.account, sign_in.email, sign_in.home), []).append(sign_in)
        reports = self._claude_limits.snapshots() if self._claude_limits is not None else {}
        used_origins: set[str] = set()
        out = []
        for key, members in groups.items():
            first = members[0]
            entry = self._entry("claude", key, members, first.email, first.organization,
                                next((m.plan for m in members if m.plan), None))
            sources: list[tuple[int, str, list[dict[str, Any]]]] = []
            live = self._live_for(key, members, now)
            if live is not None and live.windows:
                sources.append((int(live.at), "live", live.windows))
            if live is not None and live.error:
                entry["note"] = live.error
            for member in members:
                if member.cached and member.cached_at:
                    sources.append((member.cached_at, "Claude Code", member.cached))
            # A status line reported from where this account is signed in.
            for origin in {key for m in members for key in _report_keys(m.home)}:
                report = reports.get(origin)
                if report and origin not in used_origins:
                    used_origins.add(origin)
                    sources.append((report["updated_at"], "status line", _report_windows(report)))
            self._fill(entry, sources)
            out.append(entry)
        # Status lines from places with no sign-in found here (an SSH host).
        for origin, report in reports.items():
            if origin in used_origins:
                continue
            where = f"on {origin[4:]}" if origin.startswith("ssh:") else ("This PC" if origin == "local" else origin)
            entry = {"agent": "claude", "key": f"origin:{origin}", "email": None, "organization": None,
                     "plan": None, "where": [where]}
            self._fill(entry, [(report["updated_at"], "status line", _report_windows(report))])
            out.append(entry)
        return out

    def _group_codex(self, found: list[CodexSignIn]) -> list[dict[str, Any]]:
        groups: dict[str, list[CodexSignIn]] = {}
        for sign_in in found:
            groups.setdefault(self._key(sign_in.account, sign_in.email, sign_in.home), []).append(sign_in)
        out = []
        for key, members in groups.items():
            first = members[0]
            entry = self._entry("codex", key, members, first.email, None,
                                next((m.plan for m in members if m.plan), None))
            sources = []
            for member in members:
                reader = self._codex.setdefault(
                    str(member.home.config),
                    usage.CodexReader(root=lambda folder=member.home.config: folder / "sessions"),
                )
                answer = reader.read()
                if answer is not None:
                    windows = [{
                        "id": w["id"],
                        "label": _minutes_label(w.get("window_minutes")) or w["id"],
                        "used_percent": w["used_percent"],
                        "resets_at": w.get("resets_at"),
                    } for w in answer["windows"]]
                    sources.append((answer["updated_at"], "session log", windows))
                    entry["plan"] = entry["plan"] or answer.get("plan")
            self._fill(entry, sources)
            out.append(entry)
        return out

    def _entry(self, agent: str, key: str, members: list[Any], email: str | None,
               organization: str | None, plan: str | None) -> dict[str, Any]:
        where = []
        for member in members:
            if member.home.where not in where:
                where.append(member.home.where)
        return {"agent": agent, "key": key, "email": email, "organization": organization,
                "plan": plan, "where": where}

    @staticmethod
    def _fill(entry: dict[str, Any], sources: list[tuple[int, str, list[dict[str, Any]]]]) -> None:
        """The newest source's windows, with its time and name."""
        sources = [source for source in sources if source[2]]
        if not sources:
            entry.update(windows=[], updated_at=None, source=None)
            return
        updated_at, name, windows = max(sources, key=lambda source: source[0])
        entry.update(windows=[dict(w) for w in windows], updated_at=updated_at, source=name)

    def _live_for(self, key: str, members: list[ClaudeSignIn], now: float) -> _Live | None:
        """The live answer for one account, asking again when it is due."""
        previous = self._live.get(key)
        if not self._online():
            return previous if previous is not None and previous.windows else None
        due = previous is None or now - previous.asked >= (FAILED_TTL_S if previous.error else LIVE_TTL_S)
        if not due:
            return previous
        usable = [m for m in members if m.signed_in and (m.expires_at is None or m.expires_at > now + EXPIRY_MARGIN_S)]
        if not usable:
            if any(m.signed_in for m in members):
                # Old numbers keep their own time, so a newer cache wins.
                live = _Live(previous.at if previous else now, previous.windows if previous else [],
                             "sign-in expired; open Claude Code to renew it", now)
                self._live[key] = live
                return live
            return previous
        windows, error = self._fetch(usable[0].home)
        if not windows and previous is not None and previous.windows:
            # Keep the last numbers; the note says why they are not newer.
            live = _Live(previous.at, previous.windows, error, now)
        else:
            live = _Live(self._clock(), windows, error, now)
        self._live[key] = live
        return live

    # The handler's side -----------------------------------------------------------

    def snapshot(self, ttl: float = 30.0) -> list[dict[str, Any]]:
        """What the last refresh found; starts one when it is older than ``ttl``."""
        with self._lock:
            stale = self._clock() - self._refreshed_at >= ttl
            start = self.enabled and stale and not self._running
            if start:
                self._running = True
            accounts = [dict(entry, windows=[dict(w) for w in entry["windows"]], where=list(entry["where"]))
                        for entry in self._accounts]
        if start:
            self._kick()
        return accounts

    def _kick(self) -> None:
        def run() -> None:
            try:
                self.refresh()
            except Exception:
                log.warning("usage refresh failed", exc_info=True)
            finally:
                with self._lock:
                    self._running = False
                    # A failed refresh waits its turn too, rather than
                    # starting again on every request.
                    self._refreshed_at = max(self._refreshed_at, self._clock())

        if self._submit is None:
            self._submit = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="usage").submit
        try:
            self._submit(run)
        except RuntimeError:
            with self._lock:
                self._running = False


def _report_keys(home: Home) -> list[str]:
    """The status-line origins that belong to ``home``: its config folder on
    this PC (and plain "local" for the default one, as 4.5 reported), or its
    WSL distribution."""
    if home.origin != "local":
        return [home.origin]
    folder = usage.config_key(str(home.auth.parent))
    keys = [f"local:{folder}"] if folder else []
    if home.where == "This PC":
        keys.append("local")
    return keys


def _running_distros() -> Any:
    if os.name != "nt":
        return frozenset()
    from quickterm import ws_exec

    return ws_exec._running_distros()


def _report_windows(report: dict[str, Any]) -> list[dict[str, Any]]:
    return [{
        "id": w["id"],
        "label": CLAUDE_FIELD_LABELS.get(w["id"], w["id"]),
        "used_percent": w["used_percent"],
        "resets_at": w.get("resets_at"),
    } for w in report.get("windows", [])]


def _minutes_label(minutes: Any) -> str | None:
    if not isinstance(minutes, int) or minutes <= 0:
        return None
    if minutes % 1440 == 0:
        days = minutes // 1440
        return f"{days} day{'s' if days != 1 else ''}"
    if minutes % 60 == 0:
        hours = minutes // 60
        return f"{hours} hour{'s' if hours != 1 else ''}"
    return f"{minutes} minutes"
