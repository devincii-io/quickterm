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
const pause = () => new Promise(resolve => setTimeout(resolve, 300));
const api = await import('/js/api.js');
const { normalizeWindows } = await import('/js/windows.js');
const views = window.quicktermViews;
check(window.quicktermView.workspace() === 'Primary', 'primary workspace boot');
check(await views.open('Companion'), 'open companion');
await wait(() => views.frame.contentWindow.quicktermView, 'companion boot');
const child = views.frame.contentWindow;
await child.eval("import('/js/workspace.js').then(module => { window.smokeWorkspace = module; })");
await pause();
check(child.quicktermView.workspace() === 'Companion', 'companion workspace boot');
check(normalizeWindows(await api.listWindows()).length === 2, 'distinct window registrations');
const measure = doc => [...doc.querySelectorAll('.xterm-screen')].map(el => {
  const rect = el.getBoundingClientRect();
  return {width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
    viewportWidth: doc.defaultView.innerWidth, viewportHeight: doc.defaultView.innerHeight};
});
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
  doc.querySelector('#zoom-host [data-action="zoom"]').click();
  check(!doc.body.classList.contains('zoomed'), `unzoom ${label}`);
}
child.document.querySelector('.xterm-helper-textarea').dispatchEvent(new child.PointerEvent('pointerdown', {bubbles: true}));
child.document.querySelector('.xterm-helper-textarea').focus();
await pause();
const parentFocus = await import('/js/focus.js');
check(!parentFocus.terminalMayFocus(), 'companion focus blocks primary focus');
views.setHidden(true);
await pause();
check(views.secondary.hidden && parentFocus.terminalMayFocus(), 'hide hands focus to primary');
views.setHidden(false);
views.divider.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
check(views.ratio === 55, 'keyboard divider resize');
views.direction.click();
await pause();
check(views.vertical(), 'vertical stacking');
views.direction.click();
await pause();
const sessions = await api.getSessions({metrics: false});
check(sessions.length === 4 && sessions.every(s => s.alive), 'all real PTYs remain alive after splits');
const savedFetch = child.fetch;
child.fetch = (url, options) => options?.method === 'PUT' && String(url).includes('/api/workspaces/')
  ? Promise.reject(new Error('smoke: injected save failure')) : savedFetch.call(child, url, options);
await views.close();
check(Boolean(views.frame), 'failed save keeps view open');
child.fetch = savedFetch;
await views.close();
check(!views.frame && normalizeWindows(await api.listWindows()).length === 1, 'successful close removes view and claim');
check((await api.getSessions({metrics: false})).every(s => s.alive), 'closing view preserves PTYs');
const retained = (await api.getSessions({metrics: false})).filter(s => s.workspace === 'Companion');
check(retained.length === 2 && retained.every(s => s.retained), 'closed companion terminals are retained');
check(await views.open('Companion'), 'reopen saved companion');
await wait(() => views.frame.contentWindow.quicktermView, 'reopened companion');
const reloaded = views.frame.contentWindow;
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
