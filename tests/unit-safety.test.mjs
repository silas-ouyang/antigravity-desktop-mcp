import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  matchWindowAgainstRules,
  normalizeProcessName,
  SafetyController,
  sanitizeWhitelistRules,
} from '../src/safety.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-safety-unit-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeProcessName & sanitizeWhitelistRules handle edge cases cleanly', () => {
  assert.equal(normalizeProcessName(' Notepad.EXE '), 'notepad');
  assert.equal(normalizeProcessName('Siemens.Automation.Portal'), 'siemens.automation.portal');
  const rules = sanitizeWhitelistRules([
    { process: 'Notepad.exe', title_contains: '  Report  ' },
    { process: 'notepad', titleContains: 'report' }, // duplicate after normalization
    { hwnd: 12345 },
    { process: '', titleContains: '' }, // empty ignored
  ]);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0], { process: 'notepad', titleContains: 'Report' });
  assert.deepEqual(rules[1], { hwnd: 12345 });
});

test('matchWindowAgainstRules supports process, titleContains, hwnd, and wildcards', () => {
  const rules = sanitizeWhitelistRules([
    { process: 'notepad.exe', titleContains: 'Design' },
    { process: 'siemens.*' },
    { hwnd: 999 },
  ]);
  assert.equal(matchWindowAgainstRules({ hwnd: 1, process: 'Notepad', title: 'My Design.txt' }, rules), true);
  assert.equal(matchWindowAgainstRules({ hwnd: 2, process: 'Notepad', title: 'Other.txt' }, rules), false);
  assert.equal(matchWindowAgainstRules({ hwnd: 3, process: 'Siemens.Automation.Portal', title: 'TIA V20' }, rules), true);
  assert.equal(matchWindowAgainstRules({ hwnd: 999, process: 'custom', title: 'Panel' }, rules), true);
  assert.equal(matchWindowAgainstRules({ hwnd: 4, process: 'powershell', title: 'Admin' }, rules), false);
});

test('E-Stop latch blocks actions and cannot be cleared via MCP', () => withTempDir((dir) => {
  const safety = new SafetyController({ configPath: join(dir, 'safety.json') });
  assert.equal(safety.isEstopLatched(), false);
  safety.assertEstopClear('desktop_click');

  safety.triggerEstop({ trigger: 'hotkey', key: 'Esc', ts: 1000 });
  assert.equal(safety.isEstopLatched(), true);
  assert.throws(() => safety.assertEstopClear('desktop_click'), /\[ESTOP_ACTIVE\]/);
  assert.throws(() => safety.applyMcpAction({ action: 'resume' }), /\[ESTOP_ACTIVE\]/);

  safety.resumeFromHud({ trigger: 'button', ts: 2000 });
  assert.equal(safety.isEstopLatched(), false);
  safety.assertEstopClear('desktop_click');
}));

test('Window whitelist ratchet prevents disabling or widening once locked, but allows tightening', () => withTempDir((dir) => {
  const cfgPath = join(dir, 'safety.json');
  const safety = new SafetyController({ configPath: cfgPath });

  // Initially open -> AI may lock to notepad
  const locked = safety.applyMcpAction({ action: 'lock_whitelist', process: 'notepad' });
  assert.equal(locked.changed, true);
  assert.equal(safety.isWhitelistEnabled(), true);
  assert.equal(safety.isWhitelistLocked(), true);

  // Attempting to disable, clear, or widen to powershell MUST fail
  assert.throws(() => safety.applyMcpAction({ action: 'disable_whitelist' }), /\[WHITELIST_LOCKED\]/);
  assert.throws(() => safety.applyMcpAction({ action: 'lock_whitelist', rules: [{ process: 'powershell' }] }), /\[WHITELIST_LOCKED\]/);
  assert.throws(() => safety.applyMcpAction({ action: 'lock_whitelist', rules: [{ process: 'notepad' }, { process: 'calc' }] }), /\[WHITELIST_LOCKED\]/);

  // Tightening within existing notepad rule succeeds
  const tightened = safety.applyMcpAction({ action: 'tighten_whitelist', process: 'notepad', title_contains: 'Notes' });
  assert.equal(tightened.changed, true);
  assert.deepEqual(safety.getStatus().rules, [{ process: 'notepad', titleContains: 'Notes' }]);

  // Persisted to disk cleanly
  const reloaded = new SafetyController({ configPath: cfgPath });
  assert.equal(reloaded.isWhitelistEnabled(), true);
  assert.deepEqual(reloaded.getStatus().rules, [{ process: 'notepad', titleContains: 'Notes' }]);

  // Launch guard under active whitelist
  reloaded.assertLaunchAllowed('C:\\Windows\\System32\\notepad.exe');
  assert.throws(() => reloaded.assertLaunchAllowed('powershell.exe'), /\[WINDOW_NOT_WHITELISTED\]/);
}));

test('HUD bounds & HWND are strictly protected against clicks & focus', () => withTempDir((dir) => {
  const safety = new SafetyController({ configPath: join(dir, 'safety.json') });
  safety.syncFromOverlay({
    pid: 4242,
    hwnd: 8888,
    bounds: { x: 100, y: 50, width: 320, height: 60 },
  });

  assert.throws(() => safety.assertPointNotHud(150, 75, 'click'), /\[PROTECTED_HUD_TARGET\]/);
  safety.assertPointNotHud(99, 75, 'click');
  safety.assertPointNotHud(500, 500, 'click');

  assert.throws(() => safety.assertHwndProtectedAndAllowed(8888, 'focus'), /\[PROTECTED_HUD_TARGET\]/);
}));
