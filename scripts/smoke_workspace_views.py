"""Native Windows integration check with disposable config, workspaces, and PTYs.

Run with uv run --no-sync python scripts/smoke_workspace_views.py. The backend
runs as its own process (`--serve`), as in the app; this process is the
window process. A test window appears briefly for capture, then closes, and
the backend must still hold every terminal.

The window's document is the shell and hosts no workspace; its stage shows
one workspace view at a time. The check opens two workspaces, finds only one
shown and the other hidden with its full box, drives real terminals in both,
switches between them, closes the shown one (a failed save first, which must
keep it open) and finds the other shown, opens the window's one scratch view
and sends it a folder, then closes the last view and finds the empty stage.
"""

import argparse
import base64
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.request
from pathlib import Path

import webview

ROOT = Path(__file__).resolve().parents[1]

# Runs in the shell document. Each view is an iframe whose document has its
# own panes, so the per-terminal checks run against the view's window.
SMOKE_JS = r"""
(async () => {
const checks = [];
const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
const wait = async (predicate, label) => {
  const end = Date.now() + 12000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};
const pause = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
const api = await import('/js/api.js');
const { normalizeWindows } = await import('/js/windows.js');
const views = window.quicktermViews;
check(!window.quicktermView, 'the shell hosts no workspace of its own');
const primary = views.viewForWorkspace('Primary');
check(primary && views.views().length === 1, 'the window opened its workspace as a view');
const companion = await views.open('Companion');
check(companion && views.appFor(companion), 'open companion');
const first = primary.frame.contentWindow;
const child = companion.frame.contentWindow;
check(first.quicktermView.workspace() === 'Primary', 'primary workspace boot');
check(child.quicktermView.workspace() === 'Companion', 'companion workspace boot');
check(normalizeWindows(await api.listWindows()).length === 3, 'the shell and both views registered');
// One workspace on the stage: the newest is shown, the other keeps its box
// but is invisible and inert. No header, no frame, no divider.
check(views.active === companion, 'the opened workspace is the shown one');
check(getComputedStyle(primary.el).visibility === 'hidden' && primary.el.inert, 'the other view is hidden and inert');
check(getComputedStyle(companion.el).visibility === 'visible' && !companion.el.inert, 'the shown view is visible');
const stageBox = views.stage.getBoundingClientRect();
for (const view of [primary, companion]) {
  const box = view.el.getBoundingClientRect();
  check(Math.abs(box.width - stageBox.width) <= 1 && Math.abs(box.height - stageBox.height) <= 1, 'every view covers the whole stage');
}
check(!views.stage.querySelector('header, .workspace-view-divider')
  && views.views().every(view => view.el.children.length === 1 && view.el.firstElementChild === view.frame), 'no view chrome at all');
await child.eval("import('/js/workspace.js').then(module => { window.smokeWorkspace = module; })");
const measure = doc => [...doc.querySelectorAll('.xterm-screen')].map(el => {
  const rect = el.getBoundingClientRect();
  return {width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
    viewportWidth: doc.defaultView.innerWidth, viewportHeight: doc.defaultView.innerHeight};
});
await pause(400);
const sizes = {primary: measure(first.document), companion: measure(child.document)};
check(sizes.primary.every(r => r.width > 100 && r.height > 100), 'a hidden view keeps usable terminal dimensions');
check(sizes.companion.every(r => r.width > 100 && r.height > 100), 'companion terminal has usable dimensions');
check(sizes.companion.every(r => r.right <= r.viewportWidth + 1 && r.bottom <= r.viewportHeight + 1), 'companion terminal fits viewport');
for (const [view, label] of [[primary, 'PRIMARY'], [companion, 'COMPANION']]) {
  views.focusView(view);
  await pause();
  check(views.active === view, `showing ${label} from the shell`);
  const win = view.frame.contentWindow;
  const doc = win.document;
  await win.eval("import('/js/pane.js').then(({Pane}) => { const original = Pane.prototype.focusSoon; Pane.prototype.focusSoon = function() { window.smokePane = this; return original.call(this); }; })");
  const area = doc.querySelector('.xterm-helper-textarea');
  area.dispatchEvent(new win.PointerEvent('pointerdown', {bubbles: true}));
  area.dispatchEvent(new win.MouseEvent('mousedown', {bubbles: true}));
  area.focus();
  const pane = win.smokePane;
  await wait(() => pane._phase === 'live', `live ${label}`);
  const data = new win.DataTransfer();
  data.setData('text/plain', `echo NATIVE_${label}_OK\r`);
  area.dispatchEvent(new win.ClipboardEvent('paste', {clipboardData: data, bubbles: true}));
  await wait(() => Array.from({length: pane.term.buffer.active.length}, (_, i) => pane.term.buffer.active.getLine(i)?.translateToString()).join('\n').split(`NATIVE_${label}_OK`).length >= 3,
    `input/output ${label}`);
  checks.push(`real terminal input/output ${label}`);
  doc.querySelector('[data-action="split-h"]').click();
  await wait(() => doc.querySelectorAll('.pane').length === 2, `split ${label}`);
  await pause();
  doc.querySelector('[data-action="zoom"]').click();
  check(doc.body.classList.contains('zoomed'), `zoom ${label}`);
  const zoomedTab = doc.querySelector('#zoom-host .pane > .pane-tab');
  check(zoomedTab && win.getComputedStyle(zoomedTab).display !== 'none', `zoomed pane keeps its header ${label}`);
  check(doc.querySelector('#zoom-host [data-action="zoom"]').title.startsWith('Show all panes'), `zoom control offers the way back ${label}`);
  await pause();
  check(doc.activeElement?.classList.contains('xterm-helper-textarea'), `zoom keeps the keyboard in the terminal ${label}`);
  doc.querySelector('#zoom-host [data-action="zoom"]').click();
  check(!doc.body.classList.contains('zoomed'), `unzoom ${label}`);
  // Closing the first pane hands its space to the survivor, which is a lone
  // pane again: direct child of #grid, no splitter and no header left behind.
  doc.querySelector('#grid .split > .pane [data-action="detach"]').click();
  await wait(() => doc.querySelector('#grid > .pane') && !doc.querySelector('#grid .splitter'), `closed pane hands its space over ${label}`);
  const survivor = doc.querySelector('#grid > .pane').getBoundingClientRect();
  const grid = doc.getElementById('grid').getBoundingClientRect();
  check(Math.abs(survivor.width - grid.width) <= 2 && Math.abs(survivor.height - grid.height) <= 2, `survivor fills the grid ${label}`);
}
// Switching: one gesture shows the other workspace, the walk wraps, and the
// shown row is the highlighted one in the sidebar.
views.focusView(primary);
await pause();
check(views.active === primary && getComputedStyle(companion.el).visibility === 'hidden', 'showing a workspace hides the other');
const activeHead = () => document.querySelector('.session-group.active .session-group-name')?.textContent;
await wait(() => activeHead() === 'Primary', 'the shown workspace is the highlighted sidebar row');
check(views.cycle(1) && views.active === companion, 'next workspace');
check(views.cycle(1) && views.active === primary, 'the walk wraps');
const sessions = await api.getSessions({metrics: false});
check(sessions.length === 4 && sessions.every(s => s.alive), 'all real PTYs remain alive after splits');
views.focusView(companion);
const savedFetch = child.fetch;
child.fetch = (url, options) => options?.method === 'PUT' && String(url).includes('/api/workspaces/')
  ? Promise.reject(new Error('smoke: injected save failure')) : savedFetch.call(child, url, options);
await views.close(companion);
check(views.views().includes(companion) && views.active === companion, 'failed save keeps view open and shown');
child.fetch = savedFetch;
await views.close(companion);
check(!views.views().includes(companion) && normalizeWindows(await api.listWindows()).length === 2, 'successful close removes view and claim');
check(views.active === primary && getComputedStyle(primary.el).visibility === 'visible', 'closing the shown view shows the one shown before it');
check(first.quicktermView.workspace() === 'Primary', 'the other view keeps running');
check((await api.getSessions({metrics: false})).every(s => s.alive), 'closing view preserves PTYs');
const retained = (await api.getSessions({metrics: false})).filter(s => s.workspace === 'Companion');
check(retained.length === 2 && retained.every(s => s.retained), 'closed companion terminals are retained');
const reopened = await views.open('Companion');
check(reopened && views.appFor(reopened), 'reopen saved companion');
const reloaded = reopened.frame.contentWindow;
await reloaded.eval("import('/js/workspace.js').then(module => { window.smokeWorkspace = module; })");
await pause(700);
const originalFetch = reloaded.fetch;
let releaseFirst;
let firstSave = true;
reloaded.fetch = async (url, options) => {
  if (firstSave && options?.method === 'PUT') {
    firstSave = false;
    await new Promise(resolve => { releaseFirst = resolve; });
  }
  return originalFetch.call(reloaded, url, options);
};
const detail = await api.getWorkspace('Companion');
const old = reloaded.smokeWorkspace.save('Companion', {...detail.layout, title: 'stale save'}, null, detail.session_ids);
await wait(() => releaseFirst, 'first save blocked');
const queued = reloaded.smokeWorkspace.save('Companion', {...detail.layout, title: 'queued stale save'}, null, detail.session_ids);
reloaded.dispatchEvent(new reloaded.PageTransitionEvent('pagehide'));
await pause();
releaseFirst();
await Promise.all([old, queued]);
await pause();
check((await api.getWorkspace('Companion')).layout.title !== 'queued stale save', 'pagehide final snapshot follows queued saves');
reloaded.fetch = originalFetch;
check(await views.close(reopened), 'close the reopened companion');
// One scratch view per window, labelled scratch, shown again rather than
// opened twice; Explorer's folder lands in it as a new terminal.
const scratch = await views.open(null);
check(scratch && views.appFor(scratch) && views.nameOf(scratch) === 'scratch', 'the scratch view is labelled scratch');
check(await views.open(null) === scratch && views.views().length === 2, 'scratch opens once per window');
const scratchApp = views.appFor(scratch);
const before = scratchApp.attachedSessionIds().length;
check(await views.open(null, {cwd: primary.frame.contentWindow.quicktermView.app.workspacePath()}) === scratch, 'a folder goes to the scratch view');
await wait(() => scratchApp.attachedSessionIds().length === before + 1, 'the folder starts a terminal in scratch');
check(await views.close(scratch), 'close the scratch view');
check(await views.close(primary), 'the last view closes like any other');
check(views.views().length === 0 && !views.empty.hidden, 'an empty stage offers the scratch workspace');
check((await api.getSessions({metrics: false})).every(s => s.alive), 'closing every view kills nothing');
document.querySelector('#app-error-close').click();
return {checks, sizes};
})()
"""


def _backend_call(port, token, path, *, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"X-QuickTerm-Token": token, "Origin": f"http://127.0.0.1:{port}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, headers=headers, method=method
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=15) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def _start_backend(port, isolated):
    from quickterm import cli

    env = os.environ.copy()
    env["QUICKTERM_HOST_DIR"] = str(Path(isolated) / "host")
    env["PYTHONPATH"] = os.pathsep.join(
        [str(ROOT), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
    )
    process = subprocess.Popen(
        cli.app_command(["--serve", "--port", str(port)]),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    deadline = time.monotonic() + 30
    while cli.probe(cli.base_url(port)) != cli.QUICKTERM:
        if process.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError("the backend did not start")
        time.sleep(0.2)
    return process


def _stop_backend(process, port, token):
    try:
        _backend_call(port, token, "/api/host/retire", method="POST", payload={"force": True})
        process.wait(timeout=20)
    except Exception:
        process.kill()
        process.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0, help="the backend's port (default: free)")
    port = parser.parse_args().port
    with tempfile.TemporaryDirectory(
        prefix="quickterm-native-review-", ignore_cleanup_errors=True
    ) as isolated:
        os.environ["APPDATA"] = isolated
        from quickterm import app, auth, config, workspace

        if not port:
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
        cfg = config.AppConfig(
            port=port,
            update_check=False,
            scratch_dir=isolated,
            shell="cmd",
            summon_hotkey="",
            profiles=[config.Profile("Smoke cmd", "cmd.exe", args=["/q", "/k"], terminal_type="custom")],
        )
        cfg.voice.enabled = False
        config.save_config(cfg)
        for name in ["Primary", "Companion"]:
            workspace.save_workspace(
                workspace.Workspace(
                    name=name, path=isolated, layout={"type": "pane", "profile": "Smoke cmd"}
                )
            )
        start = webview.start
        create = webview.create_window
        failures = []

        def create_test_window(title, url, **kwargs):
            # A window asked for one workspace opens it as its only view and
            # neither restores nor stores the list of open workspaces.
            url = url.replace("?", "?workspace=Primary&", 1)
            kwargs["hidden"] = True
            return create("QuickTerm release smoke", url, **kwargs)

        def verify():
            window = webview.windows[0]

            def js(source):
                result = []
                ready = threading.Event()
                window.evaluate_js(
                    "(" + source + ").then(value => ({value}), "
                    "error => ({error: String(error), stack: error.stack}))",
                    lambda value: (result.append(value), ready.set()),
                )
                if not ready.wait(60):
                    raise TimeoutError(source[:160])
                if "error" in result[0]:
                    raise AssertionError(result[0])
                return result[0].get("value")

            try:
                deadline = time.monotonic() + 30
                booted = (
                    "Boolean(window.quicktermViews && window.quicktermViews.views()"
                    ".some(view => window.quicktermViews.appFor(view)))"
                )
                while not window.evaluate_js(booted):
                    if time.monotonic() > deadline:
                        raise TimeoutError("first view boot")
                    time.sleep(0.1)
                result = js(SMOKE_JS)
                print(json.dumps(result, indent=2), flush=True)
                window.show()
                time.sleep(0.5)
                from System import Func, Object

                capture = window.native.Invoke(
                    Func[Object](
                        lambda: (
                            window.native.browser.webview.CoreWebView2.CallDevToolsProtocolMethodAsync(
                                "Page.captureScreenshot", '{"format":"png"}'
                            )
                        )
                    )
                )
                deadline = time.monotonic() + 10
                while not capture.IsCompleted:
                    if time.monotonic() > deadline:
                        raise TimeoutError("native screenshot")
                    time.sleep(0.1)
                screenshot = json.loads(str(capture.Result))
                output = Path(__file__).resolve().parents[1] / ".release-tools"
                output.mkdir(exist_ok=True)
                (output / "native-workspaces.png").write_bytes(base64.b64decode(screenshot["data"]))
            except BaseException:
                failures.append(traceback.format_exc())
                print(failures[-1], flush=True)
            finally:
                # The last window closes for real: the window process ends and
                # the backend keeps the terminals.
                window.destroy()

        webview.create_window = create_test_window
        webview.start = lambda *_args, **kwargs: start(verify, **kwargs)
        backend = _start_backend(port, isolated)
        token = auth.get_or_create_token()
        try:
            app._run_viewer(cfg, control=False)
            if not failures:
                sessions = _backend_call(port, token, "/api/sessions?metrics=false")
                if not sessions or not all(s.get("alive") for s in sessions):
                    failures.append(f"closing the window process killed terminals: {sessions!r}")
                else:
                    print(
                        f"Window process closed; the backend still runs {len(sessions)} terminals",
                        flush=True,
                    )
        finally:
            webview.create_window = create
            webview.start = start
            _stop_backend(backend, port, token)
        if failures:
            raise RuntimeError("native workspace smoke failed")


if __name__ == "__main__":
    main()
