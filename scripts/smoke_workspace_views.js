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
const viewNamed = name => views.views().find(view => views.nameOf(view) === name);
check(window.quicktermView.workspace() === 'Primary', 'primary workspace boot');
check(await views.open('Companion'), 'open companion');
const companion = viewNamed('Companion');
await wait(() => companion.frame.contentWindow.quicktermView, 'companion boot');
const child = companion.frame.contentWindow;
await child.eval("import('/js/workspace.js').then(module => { window.smokeWorkspace = module; })");
await pause();
check(child.quicktermView.workspace() === 'Companion', 'companion workspace boot');
check(normalizeWindows(await api.listWindows()).length === 2, 'distinct window registrations');
check(views.stage.classList.contains('multiple'), 'two views draw borders and headers');
check(views.root.type === 'split' && views.root.dir === 'h', 'a wide primary is split side by side');
const measure = doc => [...doc.querySelectorAll('.xterm-screen')].map(el => {
  const rect = el.getBoundingClientRect();
  return {width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
    viewportWidth: doc.defaultView.innerWidth, viewportHeight: doc.defaultView.innerHeight};
});
await pause(400);
const sizes = {primary: measure(document), companion: measure(child.document)};
check(sizes.primary.every(r => r.width > 100 && r.height > 100), 'primary terminal has usable dimensions');
check(sizes.companion.every(r => r.width > 100 && r.height > 100), 'companion terminal has usable dimensions');
check(sizes.companion.every(r => r.right <= r.viewportWidth + 1 && r.bottom <= r.viewportHeight + 1), 'companion terminal fits viewport');
for (const [doc, win, label] of [[document, window, 'PRIMARY'], [child.document, child, 'COMPANION']]) {
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
child.document.querySelector('.xterm-helper-textarea').dispatchEvent(new child.PointerEvent('pointerdown', {bubbles: true}));
child.document.querySelector('.xterm-helper-textarea').focus();
await pause();
const parentFocus = await import('/js/focus.js');
check(!parentFocus.terminalMayFocus(), 'companion focus blocks primary focus');
views.zoom(views.primary);
await pause();
check(companion.el.hidden && views.zoomed === views.primary && parentFocus.terminalMayFocus(), 'zooming the primary hides the companion and hands focus back');
views.zoom(views.primary);
await pause();
check(!companion.el.hidden && views.zoomed === null, 'zooming again shows every view');
const divider = views.stage.querySelector('.workspace-view-divider');
divider.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
check(Math.round(views.root.ratio * 100) === 55, 'keyboard divider resize');
divider.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
check(Math.round(views.root.ratio * 100) === 50, 'double-click balances the split');
check(views.moveView(companion, views.primary, 'top'), 'header drop docks the view on the chosen side');
check(views.root.dir === 'v' && views.root.children[0].pane === companion, 'the companion sits above the primary');
check(views.moveView(companion, views.primary, 'right'), 'and back to the right');
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
check(!views.views().includes(companion) && normalizeWindows(await api.listWindows()).length === 1, 'successful close removes view and claim');
check(!views.stage.classList.contains('multiple'), 'a lone view draws no borders');
check((await api.getSessions({metrics: false})).every(s => s.alive), 'closing view preserves PTYs');
const retained = (await api.getSessions({metrics: false})).filter(s => s.workspace === 'Companion');
check(retained.length === 2 && retained.every(s => s.retained), 'closed companion terminals are retained');
check(await views.open('Companion'), 'reopen saved companion');
const reopenedView = viewNamed('Companion');
await wait(() => reopenedView.frame.contentWindow.quicktermView, 'reopened companion');
const reloaded = reopenedView.frame.contentWindow;
await reloaded.eval("import('/js/workspace.js').then(module => { window.smokeWorkspace = module; })");
await new Promise(resolve => setTimeout(resolve, 700));
const originalFetch = reloaded.fetch;
let releaseFirst;
let first = true;
reloaded.fetch = async (url, options) => {
  if (first && options?.method === 'PUT') {
    first = false;
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
document.querySelector('#app-error-close').click();
return {checks, sizes};
})()
