"""Native Windows integration check with disposable config, workspaces, and PTYs.

Run with uv run --no-sync python scripts/smoke_workspace_views.py. A test
window appears briefly for capture, then verifies close-to-tray and exits.
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
                if not ready.wait(30):
                    raise TimeoutError(source[:160])
                if "error" in result[0]:
                    raise AssertionError(result[0])
                return result[0].get("value")

            try:
                deadline = time.monotonic() + 30
                while not window.evaluate_js("Boolean(window.quicktermView)"):
                    if time.monotonic() > deadline:
                        raise TimeoutError("primary boot")
                    time.sleep(0.1)
                result = js(
                    Path(__file__).with_name("smoke_workspace_views.js").read_text(encoding="utf-8")
                )
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
                assert supervisor.count() == 1, "retained companion must keep native window in tray"
                assert window.evaluate_js("Boolean(window.quicktermView)"), (
                    "tray keeps document alive"
                )
                print("Native close-to-tray with retained companion passed", flush=True)
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
