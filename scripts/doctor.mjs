/**
 * Environment and health diagnostic check (`npm run doctor`) for antigravity-desktop-mcp.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PowerShellBackend, resolvePowerShell } from '../src/backend/bridge.js';
import { findCsc, needsBuild } from './build-native.mjs';
import { OverlaySupervisor } from '../src/overlay-supervisor.js';
import { SafetyController } from '../src/safety.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const report = {
    ok: true,
    node: process.version,
    powershell: resolvePowerShell(),
    csc: findCsc(),
    overlayExe: existsSync(join(ROOT, 'bin', 'EStopOverlay.exe')),
    overlayNeedsBuild: needsBuild(),
    workerPs1: existsSync(join(ROOT, 'backend', 'worker.ps1')),
    releaseInputPs1: existsSync(join(ROOT, 'backend', 'release-input.ps1')),
    overlayLive: null,
    workerLive: null,
  };

  const probeDir = join(tmpdir(), 'antigravity-desktop-mcp', `doctor-${process.pid}`);
  mkdirSync(probeDir, { recursive: true });
  const safety = new SafetyController({ configPath: join(probeDir, 'safety.json'), loadFromDisk: false });
  const overlay = new OverlaySupervisor({
    cancelEventName: `Local\\AgyDesktopDoctor_${process.pid}`,
    cancelFilePath: join(probeDir, 'cancel.flag'),
    safety,
  });
  const backend = new PowerShellBackend({
    cancelFilePath: join(probeDir, 'cancel.flag'),
    heldFilePath: join(probeDir, 'held.json'),
    cancelEventName: `Local\\AgyDesktopDoctor_${process.pid}`,
    safety,
  });

  try {
    const ready = await overlay.ensureStarted({ timeoutMs: 10_000 });
    report.overlayLive = {
      pid: ready.pid,
      hwnd: ready.hwnd,
      excludeFromCapture: ready.excludeFromCapture,
      hookInstalled: ready.hookInstalled,
      hotkeyRegistered: ready.hotkeyRegistered,
      bounds: ready.bounds,
    };
    const info = await backend.start();
    const health = await backend.call('health');
    report.workerLive = {
      pid: info.pid,
      dpi: info.dpi,
      dpiActual: info.dpiActual,
      screens: info.screens?.length ?? 0,
      uia: health.uia ?? health.engine ?? 'ok',
    };
  } catch (err) {
    report.ok = false;
    report.error = err?.message ?? String(err);
  } finally {
    try { await Promise.resolve(backend.dispose()); } catch { /* ignore */ }
    await overlay.shutdown().catch(() => { /* ignore */ });
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

void main();
