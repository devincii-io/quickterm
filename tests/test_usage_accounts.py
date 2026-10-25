"""Every sign-in on this computer and its limits (usage_accounts.py)."""

from __future__ import annotations

import base64
import io
import json
import urllib.error
from pathlib import Path

import pytest

from quickterm import usage, usage_accounts as ua

TOKEN = "sk-ant-oat01-SECRET"
LIVE = {
    "five_hour": {"utilization": 61.0, "resets_at": "2026-10-25T20:50:00+00:00"},
    "seven_day": {"utilization": 79.0, "resets_at": "2026-10-29T22:00:00+00:00"},
    "limits": [
        {"kind": "session", "percent": 61, "resets_at": "2026-10-25T20:50:00+00:00"},
        {"kind": "weekly_all", "percent": 79, "resets_at": "2026-10-29T22:00:00+00:00"},
        {"kind": "weekly_scoped", "percent": 46, "resets_at": "2026-10-29T22:00:00+00:00",
         "scope": {"model": {"display_name": "Fable"}}},
    ],
}


def claude_home(base: Path, account: str = "acc-1", email: str = "me@example.com", *,
                expires_ms: int = 4_102_444_800_000, cached: dict | None = None, folder: Path | None = None) -> None:
    config_dir = folder or base
    credentials = (folder or base / ".claude") / ".credentials.json"
    config_file = config_dir / ".claude.json"
    credentials.parent.mkdir(parents=True, exist_ok=True)
    config_dir.mkdir(parents=True, exist_ok=True)
    config = {"oauthAccount": {"accountUuid": account, "emailAddress": email,
                               "organizationName": "Org", "organizationType": "claude_max"}}
    if cached is not None:
        config["cachedUsageUtilization"] = {"fetchedAtMs": 1_000_000, "accountUuid": account, "utilization": cached}
    config_file.write_text(json.dumps(config), encoding="utf-8")
    credentials.write_text(json.dumps({"claudeAiOauth": {
        "accessToken": TOKEN, "refreshToken": "r", "expiresAt": expires_ms, "subscriptionType": "max",
    }}), encoding="utf-8")


def jwt(claims: dict) -> str:
    part = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"h.{part}.s"


def codex_home(folder: Path, account: str = "cx-1", email: str = "me@example.com") -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "auth.json").write_text(json.dumps({"tokens": {
        "id_token": jwt({"email": email, "https://api.openai.com/auth": {
            "chatgpt_account_id": account, "chatgpt_plan_type": "plus"}}),
        "access_token": "SECRET-ACCESS", "refresh_token": "SECRET-REFRESH", "account_id": account,
    }}), encoding="utf-8")
    sessions = folder / "sessions" / "2026" / "10" / "25"
    sessions.mkdir(parents=True)
    (sessions / "rollout-1.jsonl").write_text(json.dumps({
        "timestamp": "2026-10-25T10:00:00Z",
        "payload": {"type": "token_count", "rate_limits": {
            "primary": {"used_percent": 12.0, "window_minutes": 300, "resets_at": 1792960000}}},
    }) + "\n", encoding="utf-8")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(ua.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    return tmp_path


def homes_of(base: Path, **kwargs) -> list[ua.Home]:
    return ua.discover(running_distros=lambda: [], **kwargs)


def test_discovery_finds_the_default_and_extra_folders(home):
    claude_home(home)
    claude_home(home, "acc-2", "work@example.com", folder=home / ".claude-work")
    codex_home(home / ".codex")
    found = homes_of(home)
    places = [(h.agent, h.where) for h in found]
    assert ("claude", "This PC") in places
    assert ("claude", "This PC · .claude-work") in places
    assert ("codex", "This PC") in places
    named = homes_of(home, env_dirs={"claude": [str(home / ".claude-work")]})
    assert len([h for h in named if h.agent == "claude"]) == len([h for h in found if h.agent == "claude"]), \
        "a folder named twice is read once"


def test_windows_from_the_limits_list_and_from_the_fixed_fields():
    windows = ua.claude_windows(LIVE)
    assert [(w["label"], w["used_percent"]) for w in windows] == [
        ("5 hours", 61.0), ("7 days", 79.0), ("7 days · Fable", 46.0)]
    fallback = ua.claude_windows({key: value for key, value in LIVE.items() if key != "limits"})
    assert [w["id"] for w in fallback] == ["five_hour", "seven_day"]
    assert ua.claude_windows(None) == [] and ua.claude_windows({"limits": [{"kind": 3}]}) == []


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_the_live_request_carries_the_sign_in_only_to_anthropic(home):
    claude_home(home)
    seen = []

    def opener(request, timeout):
        seen.append(request)
        return Answer(json.dumps(LIVE).encode())

    windows, error = ua.fetch_claude(homes_of(home)[0], opener=opener)
    assert error is None and len(windows) == 3
    request = seen[0]
    assert request.full_url == "https://api.anthropic.com/api/oauth/usage"
    assert request.get_header("Authorization") == f"Bearer {TOKEN}"


@pytest.mark.parametrize("code, reason", [(401, "sign-in expired"), (429, "HTTP 429")])
def test_a_refused_request_says_why(home, code, reason):
    claude_home(home)

    def opener(request, timeout):
        raise urllib.error.HTTPError(request.full_url, code, "no", {}, None)

    windows, error = ua.fetch_claude(homes_of(home)[0], opener=opener)
    assert windows == [] and reason in error and TOKEN not in error


def accounts(home, fetch, **kwargs) -> ua.Accounts:
    return ua.Accounts(fetch=fetch, homes=lambda: homes_of(home), clock=lambda: 2_000_000_000.0, **kwargs)


def test_one_account_in_two_places_is_one_entry_with_live_numbers(home):
    claude_home(home)
    claude_home(home, folder=home / ".claude-again")
    calls = []

    def fetch(where):
        calls.append(where)
        return ua.claude_windows(LIVE), None

    found = accounts(home, fetch)
    found.refresh()
    claude = [entry for entry in found._accounts if entry["agent"] == "claude"]
    assert len(claude) == 1
    assert claude[0]["where"] == ["This PC", "This PC · .claude-again"]
    assert claude[0]["source"] == "live" and claude[0]["plan"] == "claude_max"
    assert len(calls) == 1, "one request per account"
    found.refresh()
    assert len(calls) == 1, "not again before the TTL"
    assert TOKEN not in json.dumps(found._accounts)


def test_two_accounts_stay_apart_and_an_expired_sign_in_is_left_to_claude(home):
    claude_home(home, cached={"five_hour": {"utilization": 20, "resets_at": None}})
    claude_home(home, "acc-2", "work@example.com", expires_ms=1000, folder=home / ".claude-work",
                cached={"seven_day": {"utilization": 5, "resets_at": None}})
    calls = []

    def fetch(where):
        calls.append(where.where)
        return ua.claude_windows(LIVE), None

    found = accounts(home, fetch)
    found.refresh()
    by_email = {entry["email"]: entry for entry in found._accounts}
    assert calls == ["This PC"]
    assert by_email["me@example.com"]["source"] == "live"
    work = by_email["work@example.com"]
    assert work["source"] == "Claude Code" and work["windows"][0]["used_percent"] == 5
    assert "expired" in work["note"]


def test_turned_off_it_asks_no_one_and_uses_the_cache(home):
    claude_home(home, cached={"five_hour": {"utilization": 20, "resets_at": None}})
    found = accounts(home, lambda where: pytest.fail("asked Anthropic"), online=lambda: False)
    found.refresh()
    assert found._accounts[0]["source"] == "Claude Code"


def test_status_lines_join_their_account_or_stand_alone(home):
    claude_home(home)
    limits = usage.ClaudeLimits(clock=lambda: 2_000_000_100.0)
    report = {"five_hour": {"used_percentage": 70, "resets_at": 1792961400}}
    assert limits.record(report, "local")
    assert limits.record(report, "ssh:me@box")
    found = accounts(home, lambda where: ([], "unreachable"), claude_limits=limits)
    found.refresh()
    mine = next(entry for entry in found._accounts if entry["email"] == "me@example.com")
    assert mine["source"] == "status line" and mine["windows"][0]["used_percent"] == 70
    box = next(entry for entry in found._accounts if entry["key"] == "origin:ssh:me@box")
    assert box["where"] == ["on me@box"]


def test_codex_accounts_come_from_auth_and_the_newest_rollout(home):
    codex_home(home / ".codex")
    codex_home(home / ".codex-work", "cx-2", "work@example.com")
    found = accounts(home, lambda where: ([], None))
    found.refresh()
    codex = {entry["email"]: entry for entry in found._accounts if entry["agent"] == "codex"}
    assert set(codex) == {"me@example.com", "work@example.com"}
    entry = codex["me@example.com"]
    assert entry["plan"] == "plus" and entry["windows"][0]["label"] == "5 hours"
    assert "SECRET" not in json.dumps(found._accounts)


def test_an_api_key_codex_sign_in_is_no_account(home):
    folder = home / ".codex"
    folder.mkdir()
    (folder / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "sk-x", "tokens": None}), encoding="utf-8")
    assert ua.read_codex(homes_of(home)[-1]) is None


def test_snapshot_never_waits_and_stays_off_until_enabled(home):
    started = []
    found = ua.Accounts(homes=lambda: [], submit=lambda fn: started.append(fn))
    assert found.snapshot() == [] and started == []
    found.enabled = True
    found.snapshot()
    found.snapshot()
    assert len(started) == 1, "one refresh at a time"
    started[0]()
    assert found.snapshot(ttl=3600) == []


def test_status_line_reports_are_kept_per_place(tmp_path):
    limits = usage.ClaudeLimits(clock=lambda: 1000.0)
    limits.attach_file(tmp_path / "claude-usage.json")
    limits.record({"five_hour": {"used_percentage": 1}}, "local")
    limits.record({"five_hour": {"used_percentage": 2}}, "wsl:Ubuntu")
    assert not limits.record({"five_hour": {"used_percentage": 3}}, "nowhere special")
    limits.save()
    again = usage.ClaudeLimits()
    again.attach_file(tmp_path / "claude-usage.json")
    assert set(again.snapshots()) == {"local", "wsl:Ubuntu"}


def test_report_origin_names_the_place():
    class Info:
        host = None
        agent_shell = None

    info = Info()
    assert usage.report_origin(info) == "local"
    info.agent_shell = "wsl:Ubuntu"
    assert usage.report_origin(info) == "wsl:Ubuntu"
    info.host = "me@box"
    assert usage.report_origin(info) == "ssh:me@box"


def test_a_failure_after_a_success_waits_the_backoff(home):
    claude_home(home)
    clock = [2_000_000_000.0]
    calls = []

    def fetch(where):
        calls.append(clock[0])
        return (ua.claude_windows(LIVE), None) if len(calls) == 1 else ([], "HTTP 429")

    found = ua.Accounts(fetch=fetch, homes=lambda: homes_of(home), clock=lambda: clock[0])
    for _ in range(25):  # 12 minutes of refreshes, one every 30 s
        found.refresh()
        clock[0] += 30
    # One success, then one failure at 120 s, then again only after 600 s.
    assert len(calls) == 3, calls
    entry = found._accounts[0]
    assert entry["source"] == "live" and entry["note"] == "HTTP 429"
    assert entry["updated_at"] == 2_000_000_000, "the numbers keep the time they were current"


def test_an_expired_sign_in_never_dresses_old_numbers_as_new(home):
    claude_home(home)
    clock = [2_000_000_000.0]
    found = ua.Accounts(fetch=lambda where: (ua.claude_windows(LIVE), None), homes=lambda: homes_of(home),
                        clock=lambda: clock[0])
    found.refresh()
    # Hours later the token has expired and Claude Code's cache is newer.
    clock[0] += 4 * 3600
    claude_home(home, expires_ms=1000, cached={"five_hour": {"utilization": 5, "resets_at": None}})
    config = json.loads((home / ".claude.json").read_text(encoding="utf-8"))
    config["cachedUsageUtilization"]["fetchedAtMs"] = int(clock[0] * 1000) - 60_000
    (home / ".claude.json").write_text(json.dumps(config), encoding="utf-8")
    found.refresh()
    entry = found._accounts[0]
    assert entry["source"] == "Claude Code" and entry["windows"][0]["used_percent"] == 5
    assert "expired" in entry["note"]


def test_two_accounts_on_this_pc_get_their_own_status_lines(home):
    claude_home(home)
    claude_home(home, "acc-2", "work@example.com", folder=home / ".claude-work")
    limits = usage.ClaudeLimits(clock=lambda: 2_000_000_100.0)
    report = {"five_hour": {"used_percentage": 77, "resets_at": 1792961400}}

    class Info:
        host = None
        agent_shell = None

    work = str(home / ".claude-work")
    assert limits.record(report, usage.report_origin(Info(), work.replace("\\", "/")))
    found = accounts(home, lambda where: ([], "unreachable"), claude_limits=limits)
    found.refresh()
    by_email = {entry["email"]: entry for entry in found._accounts}
    assert by_email["work@example.com"]["windows"][0]["used_percent"] == 77
    assert by_email["me@example.com"]["windows"] == []


def test_a_distribution_stopped_since_discovery_is_not_read(home, monkeypatch):
    stopped = ua.Home("claude", "WSL: Ubuntu (me)", "wsl:Ubuntu", home / "nope" / ".claude.json",
                      home / "nope" / ".credentials.json")
    read = []
    monkeypatch.setattr(ua, "read_claude", lambda h: read.append(h) or None)
    found = ua.Accounts(fetch=lambda where: ([], None), homes=lambda: [stopped],
                        running_distros=lambda: frozenset())
    found.refresh()
    assert read == []


def test_a_redirect_never_carries_the_token(home):
    claude_home(home)
    import http.server
    import threading as threads

    hits = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.headers.get("Authorization"))
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/elsewhere")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threads.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/usage"
        opener = ua._OPENER.open

        def to_local(request, timeout):
            request.full_url = url
            return opener(request, timeout=timeout)

        windows, error = ua.fetch_claude(homes_of(home)[0], opener=to_local)
    finally:
        server.shutdown()
    assert windows == [] and error == "HTTP 302"
    assert len(hits) == 1, "the redirect was not followed"


def test_a_malformed_answer_is_a_reason_not_a_crash(home):
    claude_home(home)
    import http.client

    def opener(request, timeout):
        raise http.client.BadStatusLine("garbage")

    windows, error = ua.fetch_claude(homes_of(home)[0], opener=opener)
    assert windows == [] and "BadStatusLine" in error
