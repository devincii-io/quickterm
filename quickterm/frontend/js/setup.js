import { icon } from "./icons.js";
import { make } from "./panel_shared.js";

const SETUP_KEY = "quickterm.setupComplete";
// The tour opens on its own until it was finished or skipped once.
export function setupNeeded(storage = globalThis.localStorage) {
  try { return storage.getItem(SETUP_KEY) !== "1"; }
  catch (_) { return false; }
}

export function renderSetup(host) {
  const steps = [
    ["One workspace at a time", "The sidebar lists your workspaces and their terminals. The one you pick fills the window; the others keep running behind it."],
    ["A workspace is a folder", "The + beside Workspaces makes one from a folder on this PC, in WSL or over SSH. Scratch is a throwaway workspace: cd into a project there and the sidebar offers to make that folder a workspace."],
    ["Pick what + starts", "The + at the top starts your shell, PowerShell unless Settings says otherwise. Its arrow starts another shell, Claude Code or Codex, and + remembers that pick."],
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
    const sidebar = make("div", "setup-sidebar");
    for (const name of ["acme", "scratch"]) {
      sidebar.append(make("div", name === "acme" ? "setup-sidebar-row active" : "setup-sidebar-row", name));
    }
    const stage = make("div", "setup-stage");
    const view = make("div", "setup-workspace");
    view.append(make("strong", "", "acme"));
    const terminal = make("div", "setup-terminal");
    terminal.append(icon("terminal", 20), make("span", "", "PowerShell"));
    view.append(terminal);
    stage.append(view);
    picture.append(make("div", "setup-window-label", "QuickTerm window"), sidebar, stage);
    host.append(progress, picture, make("h2", "setup-title", steps[step][0]), make("p", "setup-copy", steps[step][1]));
    const footer = make("div", "connection-editor-footer");
    const skip = this._button("Skip tour", "secondary-button");
    skip.addEventListener("click", () => { finish(); this.close(); });
    const back = this._button("Back", "secondary-button");
    back.disabled = step === 0;
    back.addEventListener("click", () => { step--; draw(); });
    // No profile is needed to start: the shell is a setting, so the tour
    // ends in the terminal, not in an editor.
    const next = this._button(step === steps.length - 1 ? "Done" : "Next", "primary-button");
    next.addEventListener("click", () => {
      if (step < steps.length - 1) { step++; draw(); return; }
      finish();
      this.close();
    });
    footer.append(skip, make("span", "footer-spacer"), back, next);
    host.append(footer);
  };
  draw();
}
