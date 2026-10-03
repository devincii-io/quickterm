"""Native Windows integration check with disposable config, workspaces, and PTYs.

Run with uv run --no-sync python scripts/smoke_workspace_views.py. A test
window appears briefly for capture, then verifies close-to-tray and exits.

The window's document is the shell and hosts no workspace. The check opens
two workspace views, drives real terminals in both, closes one (a failed save
first, which must keep it open) while the other keeps running, then closes
the last one and finds the empty stage.
"""

import base64
import json
import os
import socket
import tempfile
import threading
import time
import traceback
from pathlib import Path

import webview

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
check(views.stage.classList.contains('multiple'), 'two views draw borders and headers');
check(views.root.type === 'split' && views.root.dir === 'h', 'a wide view is split side by side');
check(primary.closeButton && companion.closeButton, 'every view has a close button');
await child.eval("import('/js/workspace.js').then(module => { window.smokeWorkspace = module; })");
const measure = doc => [...doc.querySelectorAll('.xterm-screen')].map(el => {
  const rect = el.getBoundingClientRect();
  return {width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
    viewportWidth: doc.defaultView.innerWidth, viewportHeight: doc.defaultView.innerHeight};
});
await pause(400);
const sizes = {primary: measure(first.document), companion: measure(child.document)};
check(sizes.primary.every(r => r.width > 100 && r.height > 100), 'primary terminal has usable dimensions');
check(sizes.companion.every(r => r.width > 100 && r.height > 100), 'companion terminal has usable dimensions');
check(sizes.companion.every(r => r.right <= r.viewportWidth + 1 && r.bottom <= r.viewportHeight + 1), 'companion terminal fits viewport');
for (const [win, label] of [[first, 'PRIMARY'], [child, 'COMPANION']]) {
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
views.zoom(primary);
await pause();
check(companion.el.hidden && views.zoomed === primary, 'zooming a view hides the other');
views.zoom(primary);
await pause();
check(!companion.el.hidden && views.zoomed === null, 'zooming again shows every view');
const divider = views.stage.querySelector('.workspace-view-divider');
divider.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
check(Math.round(views.root.ratio * 100) === 55, 'keyboard divider resize');
divider.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
check(Math.round(views.root.ratio * 100) === 50, 'double-click balances the split');
check(views.moveView(companion, primary, 'top'), 'header drop docks the view on the chosen side');
check(views.root.dir === 'v' && views.root.children[0].pane === companion, 'the companion sits above the primary');
check(views.moveView(companion, primary, 'right'), 'and back to the right');
check(views.root.dir === 'h' && views.root.children[1].pane === companion, 'the companion sits beside the primary again');
const sessions = await api.getSessions({metrics: false});
check(sessions.length === 4 && sessions.every(s => s.alive), 'all real PTYs remain alive after splits');
const savedFetch = child.fetch;
child.fetch = (url, options) => options?.method === 'PUT' && String(url).includes('/api/workspaces/')
  ? Promise.reject(new Error('smoke: injected save failure')) : savedFetch.call(child, url, options);
await views.close(companion);
check(views.views().includes(companion), 'failed save keeps view open');
child.fetch = savedFetch;
await views.close(companion);
check(!views.views().includes(companion) && normalizeWindows(await api.listWindows()).length === 2, 'successful close removes view and claim');
check(!views.stage.classList.contains('multiple'), 'a lone view draws no borders');
check(views.active === primary, 'the remaining view takes over the keyboard');
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
check(await views.close(primary), 'the last view closes like any other');
check(views.views().length === 0 && !views.empty.hidden, 'an empty stage offers a new scratch view');
check((await api.getSessions({metrics: false})).every(s => s.alive), 'closing every view kills nothing');
document.querySelector('#app-error-close').click();
return {checks, sizes};
})()
"""


def main():
    with tempfile.TemporaryDirectory(
        prefix="quickterm-native-review-", ignore_cleanup_errors=True
    ) as isolated:
        os.environ["APPDATA"] = isolated
        from quickterm import app, config, workspace

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cfg = config.AppConfig(
            port=port,
            update_check=False,
            scratch_dir=isolated,
            default_profile="Smoke cmd",
            summon_hotkey="",
            profiles=[config.Profile("Smoke cmd", "cmd.exe", args=["/q", "/k"])],
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
            # neither restores nor stores an arrangement.
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
                supervisor = app._shutdown_hook.__self__
                window.destroy()
                time.sleep(0.7)
                assert supervisor.count() == 1, "retained terminals must keep the native window in tray"
                assert window.evaluate_js("Boolean(window.quicktermViews)"), (
                    "tray keeps document alive"
                )
                print("Native close-to-tray with retained terminals passed", flush=True)
            except BaseException:
                failures.append(traceback.format_exc())
                print(failures[-1], flush=True)
            finally:
                app._shutdown_hook()

        webview.create_window = create_test_window
        webview.start = lambda **kwargs: start(verify, **kwargs)
        try:
            if not app._run_desktop(cfg):
                raise RuntimeError("native app failed to start")
        finally:
            webview.create_window = create
            webview.start = start
        if failures:
            raise RuntimeError("native workspace smoke failed")


if __name__ == "__main__":
    main()
