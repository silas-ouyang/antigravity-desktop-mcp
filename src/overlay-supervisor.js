/**
 * Supervises the native C# physical E-Stop / Whitelist HUD process (`bin/EStopOverlay.exe`).
 *
 * Responsibilities:
 * - Auto-compiles `EStopOverlay.exe` if missing/outdated via `scripts/build-native.mjs`
 * - Launches overlay with `--parent-pid`, `--cancel-event`, `--cancel-file`, `--config-file`
 * - Dispatches urgent `'estop'` / `'resume'` / `'whitelistChanged'` events immediately
 * - Tracks AI activity nesting (`beginActivity` / `endActivity`) to auto-arm Esc only while active
 * - Exposes `suspendVisual` / `resumeVisual` only as a fallback when WDA_EXCLUDEFROMCAPTURE is unsupported
 * - Zero background polling (completely event-driven on pipe stdout + unref'd activity grace timer)
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOverlay, needsBuild } from '../scripts/build-native.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const DEFAULT_OVERLAY_EXE = join(PROJECT_ROOT, 'bin', 'EStopOverlay.exe');

export class OverlaySupervisor extends EventEmitter {
  #exePath;
  #cancelEventName;
  #cancelFilePath;
  #safety;
  #allowIpcResume;
  #armedCooldownMs;
  #spawnFn;
  #child = null;
  #lines = null;
  #startPromise = null;
  #disposed = false;
  #nextId = 1;
  #pendingRpc = new Map();
  #readyInfo = null;
  #activeOps = 0;
  #cooldownTimer = null;
  #stderr = [];
  #restartCount = 0;

  constructor(options = {}) {
    super();
    this.#exePath = options.exePath ?? DEFAULT_OVERLAY_EXE;
    this.#cancelEventName = options.cancelEventName ?? `Local\\AntigravityDesktopCancel_${process.pid}`;
    this.#cancelFilePath = options.cancelFilePath ?? '';
    this.#safety = options.safety ?? null;
    this.#allowIpcResume = options.allowIpcResume === true;
    this.#armedCooldownMs = Number.isFinite(options.armedCooldownMs) ? Math.max(0, options.armedCooldownMs) : 2_000;
    this.#spawnFn = typeof options.spawn === 'function' ? options.spawn : spawn;
  }

  get exePath() {
    return this.#exePath;
  }

  get pid() {
    return this.#child?.pid ?? this.#readyInfo?.pid ?? 0;
  }

  get alive() {
    return this.#child !== null && this.#child.exitCode === null && !this.#disposed;
  }

  get visualReady() {
    return this.#readyInfo?.visualReady === true && this.alive;
  }

  get excludeFromCapture() {
    return this.#readyInfo?.excludeFromCapture === true;
  }

  get hookInstalled() {
    return this.#readyInfo?.hookInstalled === true;
  }

  get hotkeyRegistered() {
    return this.#readyInfo?.hotkeyRegistered === true;
  }

  get readyInfo() {
    return this.#readyInfo ? { ...this.#readyInfo } : null;
  }

  /**
   * Ensure EStopOverlay.exe is built and running, returning its ready event payload.
   */
  async ensureStarted({ timeoutMs = 8_000 } = {}) {
    if (this.#disposed) throw new Error('OverlaySupervisor has been disposed');
    if (this.alive && this.#readyInfo !== null) return this.#readyInfo;
    if (this.#startPromise !== null) return this.#startPromise;

    this.#startPromise = (async () => {
      if (this.#exePath === DEFAULT_OVERLAY_EXE && (!existsSync(this.#exePath) || needsBuild())) {
        buildOverlay();
      }
      if (!existsSync(this.#exePath)) {
        throw new Error(`EStopOverlay.exe not found at ${this.#exePath}`);
      }
      if (this.#cancelFilePath) {
        try {
          mkdirSync(dirname(this.#cancelFilePath), { recursive: true });
        } catch { /* best effort */ }
      }

      const args = [
        `--cancel-event=${this.#cancelEventName}`,
        `--parent-pid=${process.pid}`,
      ];
      if (this.#cancelFilePath) args.push(`--cancel-file=${this.#cancelFilePath}`);
      if (this.#safety?.configPath) args.push(`--config-file=${this.#safety.configPath}`);
      if (this.#allowIpcResume) args.push('--allow-ipc-resume');

      const child = this.#spawnFn(this.#exePath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
      });
      this.#child = child;
      this.#stderr = [];
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => {
        this.#stderr.push(chunk);
        if (this.#stderr.length > 30) this.#stderr.shift();
      });
      child.stdin?.on('error', () => { /* handled via exit/close */ });

      const ready = await new Promise((resolveReady, rejectReady) => {
        let settled = false;
        const finish = (err, info) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) rejectReady(err);
          else resolveReady(info);
        };
        const timer = setTimeout(() => {
          finish(new Error(`EStopOverlay.exe did not become ready within ${timeoutMs} ms`));
        }, timeoutMs);
        timer.unref?.();

        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        this.#lines = rl;
        rl.on('line', (line) => {
          const text = line.trim();
          if (!text) return;
          let msg;
          try {
            msg = JSON.parse(text);
          } catch {
            return;
          }
          if (msg.event === 'ready') {
            this.#readyInfo = msg;
            this.#safety?.syncFromOverlay(msg);
            this.emit('ready', msg);
            finish(null, msg);
            return;
          }
          this.#handleOverlayMessage(msg);
        });

        child.once('error', (err) => {
          finish(err);
        });
        child.once('exit', (code, signal) => {
          const errMsg = this.#stderr.join('').trim();
          if (!settled) {
            finish(new Error(`EStopOverlay.exe exited early (code=${code}, signal=${signal}): ${errMsg}`));
          }
          this.#cleanupChild(code, signal);
        });
      });

      return ready;
    })();

    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  #handleOverlayMessage(msg) {
    if (typeof msg.id === 'number' && this.#pendingRpc.has(msg.id)) {
      const pending = this.#pendingRpc.get(msg.id);
      this.#pendingRpc.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok === false) pending.reject(new Error(msg.error ?? 'overlay rpc failed'));
      else pending.resolve(msg);
      return;
    }
    switch (msg.event) {
      case 'estop':
        this.#clearCooldown();
        this.#safety?.triggerEstop(msg);
        this.emit('estop', msg);
        break;
      case 'resume':
        this.#safety?.resumeFromHud(msg);
        this.emit('resume', msg);
        break;
      case 'whitelistChanged':
        this.#safety?.syncFromOverlay(msg);
        this.emit('whitelistChanged', msg);
        break;
      case 'hotkeyChanged':
        this.#safety?.syncFromOverlay(msg);
        this.emit('hotkeyChanged', msg);
        break;
      case 'boundsChanged':
        this.#safety?.syncFromOverlay(msg);
        this.emit('boundsChanged', msg);
        break;
      default:
        break;
    }
  }

  #cleanupChild(code, signal) {
    this.#lines?.close();
    this.#lines = null;
    this.#child = null;
    this.#clearCooldown();
    for (const pending of this.#pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`EStopOverlay exited (code=${code}, signal=${signal})`));
    }
    this.#pendingRpc.clear();
    this.emit('exit', { code, signal });
    if (!this.#disposed && this.#restartCount < 5) {
      this.#restartCount += 1;
      const timer = setTimeout(() => {
        if (!this.#disposed) {
          void this.ensureStarted().catch(() => { /* diagnostic reflects unavailable */ });
        }
      }, 400);
      timer.unref?.();
    }
  }

  #clearCooldown() {
    if (this.#cooldownTimer !== null) {
      clearTimeout(this.#cooldownTimer);
      this.#cooldownTimer = null;
    }
  }

  /**
   * Call an IPC method on the overlay process. Never rejects fatally on optional UI updates unless required.
   */
  call(method, payload = {}, { timeoutMs = 2500 } = {}) {
    if (!this.alive || !this.#child?.stdin?.writable) {
      return Promise.reject(new Error('EStopOverlay is not running'));
    }
    const id = this.#nextId++;
    const line = `${JSON.stringify({ id, method, ...payload })}\n`;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.#pendingRpc.delete(id);
        rejectCall(new Error(`Overlay RPC '${method}' timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pendingRpc.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      try {
        this.#child.stdin.write(line);
      } catch (err) {
        this.#pendingRpc.delete(id);
        clearTimeout(timer);
        rejectCall(err);
      }
    });
  }

  async setState(state, detail = '') {
    if (!this.alive) return;
    if (this.#safety?.isEstopLatched() && state !== 'stopped') return;
    try {
      await this.call('setState', { state, detail });
    } catch { /* best effort status badge update */ }
  }

  async beginActivity(detail = '') {
    this.#activeOps += 1;
    this.#clearCooldown();
    if (this.#activeOps === 1) {
      await this.setState('running', detail);
    }
  }

  endActivity() {
    this.#activeOps = Math.max(0, this.#activeOps - 1);
    if (this.#activeOps > 0 || this.#disposed) return;
    if (this.#safety?.isEstopLatched()) return;
    if (this.#armedCooldownMs <= 0) {
      void this.setState('standby', '');
      return;
    }
    void this.setState('armed', '');
    this.#clearCooldown();
    this.#cooldownTimer = setTimeout(() => {
      this.#cooldownTimer = null;
      if (this.#activeOps === 0 && !this.#disposed && !this.#safety?.isEstopLatched()) {
        void this.setState('standby', '');
      }
    }, this.#armedCooldownMs);
    this.#cooldownTimer.unref?.();
  }

  async syncWhitelistFromSafety() {
    if (!this.alive || !this.#safety) return;
    const st = this.#safety.getStatus();
    await this.call('setWhitelist', { enabled: st.whitelistEnabled, rules: st.rules });
  }

  async suspendVisual() {
    if (!this.alive || this.excludeFromCapture) return;
    try {
      await this.call('suspendVisual');
    } catch { /* best effort */ }
  }

  async resumeVisual() {
    if (!this.alive || this.excludeFromCapture) return;
    try {
      await this.call('resumeVisual');
    } catch { /* best effort */ }
  }

  async ping() {
    if (!this.alive) return { ok: false, alive: false };
    return this.call('ping');
  }

  async shutdown({ timeoutMs = 1500 } = {}) {
    this.#disposed = true;
    this.#clearCooldown();
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    try {
      await Promise.race([
        this.call('quit', {}, { timeoutMs: Math.min(800, timeoutMs) }),
        new Promise((r) => setTimeout(r, Math.min(800, timeoutMs))),
      ]);
    } catch { /* proceed to exit wait */ }
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) {
        resolveExit();
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
        resolveExit();
      }, timeoutMs);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
}
