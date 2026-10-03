import { icon } from "./icons.js";
import { make } from "./panel_shared.js";

const SETUP_KEY = "quickterm.setupComplete";
export function setupNeeded(profiles, storage = globalThis.localStorage) {
  try { return !profiles.length && storage.getItem(SETUP_KEY) !== "1"; }
  catch (_) { return !profiles.length; }
}

export function renderSetup(host) {
  const steps = [
    ["One window, one sidebar", "Each QuickTerm window has its own sidebar. Workspace views tile inside the window."],
    ["Workspaces own terminals", "A workspace has a folder and a terminal layout. Scratch is a temporary workspace you can name later."],
    ["Choose what runs", "Save a terminal or connection before opening it. Remote desktops open in their own client window."],
  ];
  let step = 0;
  const finish = () => { try { localStorage.setItem(SETUP_KEY, "1"); } catch (_) { /* optional */ } };
  const draw = () => {
    host.textContent = "";
    const progress = make("nav", "setup-progress");
    progress.setAttribute("aria-label", "Setup progress");
    for (let index = 0; index < steps.length; index++) {
      const button = this._button(String(index + 1), "setup-step");
      button.classList.toggle("active", index === step);
      button.title = steps[index][0];
      button.setAttribute("aria-label", steps[index][0]);
      if (index === step) button.setAttribute("aria-current", "step");
      button.addEventListener("click", () => { step = index; draw(); });
      progress.append(button);
    }
    const picture = make("div", "setup-window");
    const sidebar = make("div", "setup-sidebar", "Sidebar");
    const stage = make("div", "setup-stage");
    for (const name of ["Project", "Scratch"]) {
      const view = make("div", "setup-workspace");
      view.append(make("strong", "", name));
      const terminal = make("div", "setup-terminal");
      terminal.append(icon("terminal", 20), make("span", "", "Terminal"));
      view.append(terminal);
      stage.append(view);
    }
    picture.append(make("div", "setup-window-label", "QuickTerm window"), sidebar, stage);
    host.append(progress, picture, make("h2", "setup-title", steps[step][0]), make("p", "setup-copy", steps[step][1]));
    const footer = make("div", "connection-editor-footer");
    const skip = this._button("Skip tour", "secondary-button");
    skip.addEventListener("click", () => { finish(); this.close(); });
    const back = this._button("Back", "secondary-button");
    back.disabled = step === 0;
    back.addEventListener("click", () => { step--; draw(); });
    const next = this._button(step === steps.length - 1 ? "Set up a terminal" : "Next", "primary-button");
    next.addEventListener("click", () => {
      if (step < steps.length - 1) { step++; draw(); return; }
      finish();
      this.settingsTab = "connections";
      this.connectionEditor = { choosing: true };
      this.show("settings");
    });
    footer.append(skip, make("span", "footer-spacer"), back, next);
    host.append(footer);
  };
  draw();
}
