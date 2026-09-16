// Sub2API updates its iframe URL when the host theme changes.
export function initializeTheme(win, doc, renderButton) {
  const params = new URLSearchParams(win.location.search);
  const suppliedTheme = params.get('theme');
  const hostTheme = ['light', 'dark'].includes(suppliedTheme) ? suppliedTheme : null;
  const managed = params.get('ui_mode') === 'embedded' && hostTheme !== null;
  const storageKey = 'intelligence-observatory.theme';
  const button = doc.querySelector('#theme-toggle');
  let savedTheme;
  try { savedTheme = win.localStorage.getItem(storageKey); } catch {}
  const apply = theme => {
    doc.documentElement.classList.toggle('light', theme === 'light');
    doc.documentElement.classList.toggle('dark', theme !== 'light');
    doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#000000');
    renderButton();
  };
  apply(hostTheme || (savedTheme === 'light' ? 'light' : 'dark'));
  button.hidden = managed;
  button.addEventListener('click', () => {
    if (managed) return;
    const theme = doc.documentElement.classList.contains('light') ? 'dark' : 'light';
    apply(theme);
    try { win.localStorage.setItem(storageKey, theme); } catch {}
  });
}
