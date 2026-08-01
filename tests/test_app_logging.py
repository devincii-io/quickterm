import json
import logging

from quickterm.app import _DesktopApi, _PrivacyFormatter, _native_drop_paths, _queue_running_launch


def test_privacy_formatter_redacts_common_user_paths(monkeypatch):
    monkeypatch.setenv("USERPROFILE", r"C:\Users\PrivateName")
    monkeypatch.setenv("APPDATA", r"C:\Users\PrivateName\AppData\Roaming")
    record = logging.LogRecord(
        "quickterm",
        logging.ERROR,
        __file__,
        1,
        r"failed under C:\Users\PrivateName\AppData\Roaming\quickterm",
        (),
        None,
    )

    rendered = _PrivacyFormatter("%(message)s").format(record)

    assert "PrivateName" not in rendered
    assert rendered == r"failed under %APPDATA%\quickterm"


def test_running_instance_folder_launch_is_forwarded_with_local_token(monkeypatch, tmp_path):
    from quickterm import auth
    import quickterm.app as app

    captured = {}

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def fake_open(request, timeout):
        captured.update(request=request, timeout=timeout)
        return Response()

    monkeypatch.setattr(auth, "get_or_create_token", lambda: "local-token")
    monkeypatch.setattr(app.urllib.request, "urlopen", fake_open)

    assert _queue_running_launch(8620, str(tmp_path)) is True
    request = captured["request"]
    assert request.full_url == "http://127.0.0.1:8620/api/launches"
    assert json.loads(request.data) == {"cwd": str(tmp_path)}
    headers = {key.lower(): value for key, value in request.header_items()}
    assert headers[auth.HEADER.lower()] == "local-token"


def test_native_drop_bridge_uses_only_host_verified_full_paths():
    event = {
        "dataTransfer": {
            "files": [
                {"name": "image.png", "pywebviewFullPath": r"C:\work\image.png"},
                {"name": "unsafe-basename.txt"},
                {"pywebviewFullPath": r"C:\work\image.png"},
            ]
        }
    }
    assert _native_drop_paths(event) == [r"C:\work\image.png"]
    assert _native_drop_paths({"dataTransfer": {"files": [{"name": "only.txt"}]}}) == []


def test_desktop_folder_picker_returns_only_a_selected_existing_directory(tmp_path):
    picker = _DesktopApi()
    assert picker.pick_folder(str(tmp_path)) is None

    class Window:
        def __init__(self):
            self.selected = (str(tmp_path),)
            self.calls = []

        def create_file_dialog(self, dialog_type, *, directory):
            self.calls.append((dialog_type, directory))
            return self.selected

    window = Window()
    picker._bind_window(window)
    assert picker.pick_folder(str(tmp_path)) == str(tmp_path.resolve())
    assert window.calls == [(20, str(tmp_path))]

    window.selected = None
    assert picker.pick_folder(str(tmp_path)) is None
    window.selected = (str(tmp_path / "missing"),)
    assert picker.pick_folder(str(tmp_path)) is None
