import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeTheme } from '../public/theme.js';

function page(search, saved = {}, blockedStorage = false) {
  const classes = new Set(['dark']);
  const writes = [];
  const button = { addEventListener(type, listener) { this[type] = listener; } };
  const meta = { setAttribute(name, value) { this[name] = value; } };
  const doc = {
    documentElement: { classList: {
      contains: name => classes.has(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    } },
    querySelector: selector => selector === '#theme-toggle' ? button : meta,
  };
  const win = { location: { search }, localStorage: {
    getItem(key) { if (blockedStorage) throw new Error('blocked'); return saved[key]; },
    setItem(key, value) { if (blockedStorage) throw new Error('blocked'); writes.push([key, value]); },
  } };
  initializeTheme(win, doc, () => {});
  return { classes, button, writes, meta };
}

test('Sub2API URL themes override saved preference across iframe reloads without writing host storage', () => {
  for (const theme of ['light', 'dark']) {
    const p = page(`?ui_mode=embedded&theme=${theme}`, { 'intelligence-observatory.theme': theme === 'light' ? 'dark' : 'light' });
    assert.deepEqual([...p.classes], [theme]);
    assert.equal(p.button.hidden, true);
    p.button.click();
    assert.deepEqual([...p.classes], [theme]);
    assert.deepEqual(p.writes, []);
    assert.equal(p.meta.content, theme === 'light' ? '#ffffff' : '#000000');
  }
});

test('Standalone theme uses isolated storage; invalid parameters and unavailable storage remain usable', () => {
  const p = page('', { theme: 'light' });
  assert.equal(p.classes.has('dark'), true);
  assert.equal(p.button.hidden, false);
  p.button.click();
  assert.deepEqual(p.writes, [['intelligence-observatory.theme', 'light']]);
  const saved = page('?ui_mode=embedded&theme=invalid', { 'intelligence-observatory.theme': 'light' });
  assert.equal(saved.classes.has('light'), true);
  assert.equal(saved.button.hidden, false);
  const blocked = page('?theme=light', {}, true);
  assert.equal(blocked.classes.has('light'), true);
  blocked.button.click();
  assert.equal(blocked.classes.has('dark'), true);
});
