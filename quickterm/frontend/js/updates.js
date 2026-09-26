// Update notification: a quiet accent pill in the nav when a newer release
// exists. Clicking it opens Settings > About, where install lives.

function showUpdatePill(panels, latest) {
  const nav = document.querySelector(".sidebar-footer");
  if (!nav || nav.querySelector(".update-pill")) return;
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "sidebar-action sidebar-nav-button update-pill";
  pill.title = `QuickTerm v${latest} is available. Open About to install.`;
  pill.setAttribute("aria-label", pill.title);
  pill.textContent = "up";
  pill.addEventListener("click", () => {
    panels.settingsTab = "about"; // land directly on About, where install lives
    panels.show("settings");
  });
  nav.prepend(pill);
}

export function watchUpdates({ api, state, panels }) {
  if (state.cfg.elevated || state.cfg.update_check === false) return;
  const probe = () => {
    api.checkUpdate().then((result) => {
      if (result && result.update_available) showUpdatePill(panels, result.latest);
    }).catch(() => {});
  };
  setTimeout(probe, 4000); // stay out of the boot path
  setInterval(probe, 6 * 3600 * 1000);
}
