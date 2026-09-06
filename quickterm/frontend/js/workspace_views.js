import * as api from "./api.js";
import { claimFocus, releaseFocus } from "./focus.js";

export function companionUrl(path, workspace, id, token) {
  const query = new URLSearchParams({ workspace, window: id, embedded: "1" });
  return `${path || "/"}?${query}#t=${encodeURIComponent(token || "")}`;
}

export function clampViewRatio(value) {
  return Math.max(25, Math.min(75, Number.isFinite(value) ? value : 50));
}

export class WorkspaceViews {
  constructor({ current, focus, fit, error }) {
    this.current = current;
    this.focus = focus;
    this.fit = fit;
    this.error = error;
    this.frame = null;
    this.ratio = 50;
    this.hidden = false;
    this.busy = false;
    this.stage = document.createElement("div");
    this.stage.className = "workspace-views";
    this.primary = document.createElement("section");
    this.primary.className = "workspace-view workspace-view-primary";
    this.primary.setAttribute("aria-label", "Primary workspace");
    this.header = document.createElement("header");
    this.header.className = "workspace-view-heading";
    this.name = document.createElement("strong");
    this.toggle = this.button("Hide second workspace", () => this.setHidden(!this.hidden));
    this.direction = this.button("Stack vertically", () => {
      this.stage.classList.toggle("stacked");
      this.direction.textContent = this.stage.classList.contains("stacked") ? "Side by side" : "Stack vertically";
      this.resize();
    });
    this.header.append(this.name, this.direction, this.toggle);
    const app = document.getElementById("app");
    app.before(this.stage);
    this.primary.append(this.header, app);
    this.stage.append(this.primary);
    this.primary.addEventListener("pointerdown", () => this.activate(false), true);
    this.primary.addEventListener("focusin", () => this.activate(false));
    window.addEventListener("resize", () => this.resize());
    this.update();
  }

  button(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  update() {
    this.name.textContent = this.current() || "scratch";
    if (this.frame?.contentWindow?.quicktermView) {
      const name = this.frame.contentWindow.quicktermView.workspace() || "scratch";
      this.secondName.textContent = name;
      this.frame.title = `Workspace: ${name}`;
    }
  }

  activate(second) {
    if (this.secondActive === second) return;
    this.secondActive = second;
    if (second) claimFocus("companion"); else releaseFocus("companion");
    this.primary.classList.toggle("active", !second);
    this.secondary?.classList.toggle("active", second);
    this.frame?.contentWindow?.quicktermView?.suspend(!second);
  }

  async open(name) {
    if (this.busy) return false;
    if (this.frame) {
      this.setHidden(false);
      this.error("Close the second workspace view before opening another one.");
      return false;
    }
    if (!name || name === this.current()) return false;
    this.busy = true;
    try {
      // Reserve first: a failed registry must never create two layout writers.
      const info = await api.registerWindow({ workspace: name, title: `Side view: ${name}` });
      if (!info?.id) throw new Error("Missing workspace view identity");
      this.companionId = info.id;
      this.secondary = document.createElement("section");
      this.secondary.className = "workspace-view workspace-view-secondary";
      this.secondary.setAttribute("aria-label", "Second workspace");
      const header = document.createElement("header");
      header.className = "workspace-view-heading";
      this.secondName = document.createElement("strong");
      this.secondName.textContent = name;
      this.closeButton = this.button("Close view", () => this.close());
      this.closeButton.title = "Save and close this view; terminals keep running";
      header.append(this.secondName, this.closeButton);
      this.frame = document.createElement("iframe");
      this.frame.title = `Workspace: ${name}`;
      this.frame.src = companionUrl(location.pathname, name, info.id, api.token());
      this.secondary.append(header, this.frame);
      this.divider = document.createElement("div");
      this.divider.className = "workspace-view-divider";
      this.divider.tabIndex = 0;
      this.divider.setAttribute("role", "separator");
      this.divider.setAttribute("aria-label", "Resize workspaces");
      this.divider.setAttribute("aria-valuemin", "25");
      this.divider.setAttribute("aria-valuemax", "75");
      this.wireDivider();
      this.stage.append(this.divider, this.secondary);
      this.stage.classList.add("multiple");
      this.activate(false);
      this.resize();
      return true;
    } catch (error) {
      this.error(error?.detail || "Could not open the second workspace. It may already be open elsewhere.");
      return false;
    } finally {
      this.busy = false;
    }
  }

  setHidden(hidden) {
    if (!this.frame) return;
    this.hidden = hidden;
    this.stage.classList.toggle("companion-hidden", hidden);
    this.secondary.hidden = hidden;
    this.divider.hidden = hidden;
    this.toggle.textContent = hidden ? "Show second workspace" : "Hide second workspace";
    this.activate(false);
    this.frame.contentWindow?.quicktermView?.suspend(true);
    this.resize();
    this.focus();
  }

  async close() {
    if (!this.frame || this.busy) return;
    const view = this.frame.contentWindow?.quicktermView;
    if (!view) {
      this.error("The second workspace is still loading. Try closing it again once it has loaded.");
      return;
    }
    this.busy = true;
    this.closeButton.disabled = true;
    try {
      if (!await view.close()) {
        this.error("The second workspace is switching. Wait for it to finish before closing its view.");
        return;
      }
      this.activate(false);
      this.secondary.remove();
      this.divider.remove();
      this.frame = null;
      this.hidden = false;
      this.stage.classList.remove("multiple", "companion-hidden");
      this.toggle.textContent = "Hide second workspace";
      this.resize();
      this.focus();
    } catch (error) {
      this.error(error?.detail || "Could not save the second workspace. Its view remains open.");
    } finally {
      this.busy = false;
      this.closeButton.disabled = false;
    }
  }

  resize() {
    this.stage.style.setProperty("--view-ratio", `${this.ratio}%`);
    this.divider?.setAttribute("aria-valuenow", String(Math.round(this.ratio)));
    this.divider?.setAttribute("aria-orientation", this.vertical() ? "horizontal" : "vertical");
    requestAnimationFrame(() => this.fit());
  }

  vertical() {
    return this.stage.classList.contains("stacked") || window.innerWidth < 900;
  }

  wireDivider() {
    this.divider.addEventListener("keydown", (event) => {
      const decrease = this.vertical() ? "ArrowUp" : "ArrowLeft";
      const increase = this.vertical() ? "ArrowDown" : "ArrowRight";
      if (![decrease, increase, "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      this.ratio = event.key === "Home" ? 25 : event.key === "End" ? 75
        : clampViewRatio(this.ratio + (event.key === decrease ? -5 : 5));
      this.resize();
    });
    this.divider.addEventListener("dblclick", () => { this.ratio = 50; this.resize(); });
    this.divider.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.divider.setPointerCapture(event.pointerId);
      this.stage.classList.add("resizing");
      const move = (next) => {
        const box = this.stage.getBoundingClientRect();
        this.ratio = clampViewRatio(this.vertical()
          ? 100 * (next.clientY - box.top) / box.height
          : 100 * (next.clientX - box.left) / box.width);
        this.resize();
      };
      const stop = () => {
        this.stage.classList.remove("resizing");
        this.divider.removeEventListener("pointermove", move);
        this.divider.removeEventListener("pointerup", stop);
        this.divider.removeEventListener("lostpointercapture", stop);
      };
      this.divider.addEventListener("pointermove", move);
      this.divider.addEventListener("pointerup", stop);
      this.divider.addEventListener("lostpointercapture", stop);
    });
  }
}
