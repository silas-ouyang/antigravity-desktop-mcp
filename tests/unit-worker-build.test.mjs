import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectImageMimeType } from '../src/capture-service.js';
import { findCsc, needsBuild } from '../scripts/build-native.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('worker.ps1 is deterministically built, has no UTF-8 BOM, and passes PowerShell AST check', () => {
  const workerPath = join(ROOT, 'backend', 'worker.ps1');
  const releasePath = join(ROOT, 'backend', 'release-input.ps1');
  assert.equal(existsSync(workerPath), true);
  assert.equal(existsSync(releasePath), true);

  const head = readFileSync(workerPath).subarray(0, 3);
  assert.equal(head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf, false, 'worker.ps1 must not contain UTF-8 BOM');

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-worker.mjs'), '--check'], { stdio: 'pipe' });

  const parseCmd = `
    $e1 = $null; $t1 = $null;
    [void][System.Management.Automation.Language.Parser]::ParseFile('${workerPath.replace(/'/g, "''")}', [ref]$t1, [ref]$e1);
    if ($e1 -and $e1.Count -gt 0) { $e1 | ForEach-Object { $_.Message }; exit 1 }
    $e2 = $null; $t2 = $null;
    [void][System.Management.Automation.Language.Parser]::ParseFile('${releasePath.replace(/'/g, "''")}', [ref]$t2, [ref]$e2);
    if ($e2 -and $e2.Count -gt 0) { $e2 | ForEach-Object { $_.Message }; exit 1 }
  `;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parseCmd], { stdio: 'pipe' });
});

test('EStopOverlay.exe binary is built and up to date with native/EStopOverlay.cs', () => {
  assert.ok(findCsc(), 'csc.exe should be available');
  assert.equal(existsSync(join(ROOT, 'bin', 'EStopOverlay.exe')), true);
  assert.equal(needsBuild(), false);
});

test('detectImageMimeType verifies encoded header bytes cleanly', () => {
  assert.equal(detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
  assert.equal(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(detectImageMimeType(Buffer.from('RIFF1234WEBP', 'ascii')), 'image/webp');
});
