/**
 * Runtime safety policy controller for antigravity-desktop-mcp:
 * - Physical E-Stop latch state (AI cannot unlatch via MCP; only physical HUD RESUME unlocks)
 * - Window whitelist ratchet & rule matching (AI cannot disable or widen an active whitelist)
 * - HUD bounds/HWND protection so AI cannot click RESUME or tamper with the HUD popup
 * - Persistent configuration file shared/synced with EStopOverlay.exe and worker.ps1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const ESC_MODES = Object.freeze(['armed', 'always', 'off']);

/**
 * Default persistent config location under ~/.gemini/antigravity/antigravity-desktop-mcp/safety-config.json.
 */
export function defaultSafetyConfigPath() {
  return process.env.AGY_DESKTOP_SAFETY_CONFIG
    || join(homedir(), '.gemini', 'antigravity', 'antigravity-desktop-mcp', 'safety-config.json');
}

/**
 * Normalize a Windows process name (`Notepad.exe` -> `notepad`).
 */
export function normalizeProcessName(name) {
  if (typeof name !== 'string') return '';
  let out = name.trim().toLowerCase();
  if (out.endsWith('.exe')) out = out.slice(0, -4);
  return out;
}

/**
 * Validate and normalize an array of whitelist rules.
 * Each rule matches when ALL its specified fields match a window (OR across rules).
 */
export function sanitizeWhitelistRules(rules) {
  if (!Array.isArray(rules)) return [];
  const clean = [];
  const seen = new Set();
  for (const raw of rules) {
    if (!raw || typeof raw !== 'object') continue;
    const proc = typeof raw.process === 'string' ? normalizeProcessName(raw.process) : '';
    const titleContains = typeof raw.titleContains === 'string'
      ? raw.titleContains.trim()
      : (typeof raw.title_contains === 'string' ? raw.title_contains.trim() : '');
    const hwndNum = raw.hwnd !== undefined && raw.hwnd !== null && raw.hwnd !== ''
      ? Number(raw.hwnd)
      : 0;
    const hwnd = Number.isInteger(hwndNum) && hwndNum > 0 ? hwndNum : 0;
    if (!proc && !titleContains && !hwnd) continue;
    const rule = {};
    if (proc) rule.process = proc;
    if (titleContains) rule.titleContains = titleContains;
    if (hwnd) rule.hwnd = hwnd;
    const key = `${rule.process ?? ''}|${(rule.titleContains ?? '').toLowerCase()}|${rule.hwnd ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(rule);
  }
  return clean;
}

function wildcardMatch(actual, pattern) {
  if (!pattern.includes('*') && !pattern.includes('?')) return actual === pattern;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(actual);
}

/**
 * Test whether a window descriptor `{ hwnd, pid, process, title }` matches at least one rule.
 */
export function matchWindowAgainstRules(win, rules) {
  if (!win || !Array.isArray(rules) || rules.length === 0) return false;
  const actualHwnd = Number(win.hwnd ?? 0);
  const actualProc = normalizeProcessName(String(win.process ?? ''));
  const actualTitle = String(win.title ?? '');
  for (const rule of rules) {
    if (!rule) continue;
    let matched = true;
    let hasField = false;
    if (rule.hwnd) {
      hasField = true;
      if (actualHwnd !== rule.hwnd) matched = false;
    }
    if (matched && rule.process) {
      hasField = true;
      if (!actualProc || !wildcardMatch(actualProc, normalizeProcessName(rule.process))) matched = false;
    }
    if (matched && rule.titleContains) {
      hasField = true;
      if (!actualTitle.toLowerCase().includes(rule.titleContains.toLowerCase())) matched = false;
    }
    if (hasField && matched) return true;
  }
  return false;
}

/**
 * Checks whether candidate tightened rule B is a subset of existing rule A
 * (every window matching B also matches A). Used to let AI only narrow an already-active whitelist.
 */
function ruleCoveredBy(narrow, broad) {
  if (broad.hwnd && narrow.hwnd !== broad.hwnd) return false;
  if (broad.process) {
    if (!narrow.process) return false;
    const b = normalizeProcessName(broad.process);
    const n = normalizeProcessName(narrow.process);
    if (b !== n && !wildcardMatch(n, b)) return false;
  }
  if (broad.titleContains) {
    if (!narrow.titleContains) return false;
    if (!narrow.titleContains.toLowerCase().includes(broad.titleContains.toLowerCase())) return false;
  }
  return true;
}

/**
 * Coordinates E-Stop latch, HUD protection, and window whitelist policy across MCP tools, HUD, and PowerShell worker.
 */
export class SafetyController {
  #configPath;
  #escMode = 'armed';
  #comboHotkey = 'Ctrl+Alt+Pause';
  #whitelistEnabled = false;
  #whitelistLocked = false;
  #rules = [];
  #estopLatched = false;
  #safetyEpoch = 1;
  #hudPid = 0;
  #hudHwnd = 0;
  #hudBounds = null;
  #lastAbort = null;
  #lastResume = null;

  constructor(options = {}) {
    this.#configPath = options.configPath ?? defaultSafetyConfigPath();
    if (options.loadFromDisk !== false) {
      this.#loadPersistedConfig();
    }
    if (typeof options.whitelistEnabled === 'boolean') {
      this.#whitelistEnabled = options.whitelistEnabled;
      this.#whitelistLocked = options.whitelistEnabled;
    }
    if (Array.isArray(options.rules)) {
      this.#rules = sanitizeWhitelistRules(options.rules);
    }
    if (ESC_MODES.includes(options.escMode)) this.#escMode = options.escMode;
    if (typeof options.comboHotkey === 'string' && options.comboHotkey.trim()) {
      this.#comboHotkey = options.comboHotkey.trim();
    }
  }

  get configPath() {
    return this.#configPath;
  }

  get safetyEpoch() {
    return this.#safetyEpoch;
  }

  get hudPid() {
    return this.#hudPid;
  }

  get hudHwnd() {
    return this.#hudHwnd;
  }

  get hudBounds() {
    return this.#hudBounds ? { ...this.#hudBounds } : null;
  }

  isEstopLatched() {
    return this.#estopLatched;
  }

  isWhitelistEnabled() {
    return this.#whitelistEnabled;
  }

  isWhitelistLocked() {
    return this.#whitelistLocked;
  }

  #loadPersistedConfig() {
    if (!this.#configPath || !existsSync(this.#configPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.#configPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (ESC_MODES.includes(parsed.escMode)) this.#escMode = parsed.escMode;
        if (typeof parsed.comboHotkey === 'string' && parsed.comboHotkey.trim()) {
          this.#comboHotkey = parsed.comboHotkey.trim();
        }
        if (typeof parsed.whitelistEnabled === 'boolean') {
          this.#whitelistEnabled = parsed.whitelistEnabled;
          this.#whitelistLocked = parsed.whitelistEnabled;
        }
        if (Array.isArray(parsed.rules)) {
          this.#rules = sanitizeWhitelistRules(parsed.rules);
        }
      }
    } catch {
      /* corrupt user config falls back cleanly to safe defaults */
    }
  }

  #savePersistedConfig() {
    if (!this.#configPath) return;
    try {
      mkdirSync(dirname(this.#configPath), { recursive: true });
      let existing = {};
      if (existsSync(this.#configPath)) {
        try {
          existing = JSON.parse(readFileSync(this.#configPath, 'utf8')) || {};
        } catch {
          existing = {};
        }
      }
      const next = {
        ...existing,
        escMode: this.#escMode,
        comboHotkey: this.#comboHotkey,
        whitelistEnabled: this.#whitelistEnabled,
        rules: this.#rules,
      };
      writeFileSync(this.#configPath, JSON.stringify(next, null, 2), 'utf8');
    } catch {
      /* best effort */
    }
  }

  /**
   * Synchronize HUD startup/change notifications into Node policy.
   */
  syncFromOverlay(evt) {
    if (!evt || typeof evt !== 'object') return;
    if (Number.isFinite(Number(evt.pid)) && Number(evt.pid) > 0) this.#hudPid = Number(evt.pid);
    if (Number.isFinite(Number(evt.hwnd)) && Number(evt.hwnd) > 0) this.#hudHwnd = Number(evt.hwnd);
    if (evt.bounds && typeof evt.bounds === 'object') {
      const b = evt.bounds;
      if (Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height)) {
        this.#hudBounds = { x: Math.trunc(b.x), y: Math.trunc(b.y), width: Math.trunc(b.width), height: Math.trunc(b.height) };
      }
    }
    if (typeof evt.whitelistEnabled === 'boolean') {
      this.#whitelistEnabled = evt.whitelistEnabled;
      // Enabling from the HUD locks the ratchet; disabling from the HUD unlocks it.
      this.#whitelistLocked = evt.whitelistEnabled;
    }
    if (Array.isArray(evt.rules)) {
      this.#rules = sanitizeWhitelistRules(evt.rules);
    }
    if (ESC_MODES.includes(evt.escMode)) this.#escMode = evt.escMode;
    if (typeof evt.comboHotkey === 'string' && evt.comboHotkey.trim()) this.#comboHotkey = evt.comboHotkey.trim();
    if (typeof evt.estopLatched === 'boolean') this.#estopLatched = evt.estopLatched;
  }

  /**
   * Latch physical/hotkey E-Stop. AI cannot clear this; user must click RESUME on the HUD.
   */
  triggerEstop(info = {}) {
    this.#safetyEpoch += 1;
    this.#estopLatched = true;
    this.#lastAbort = {
      ts: Number(info.ts) || Date.now(),
      trigger: String(info.trigger ?? 'hotkey'),
      key: String(info.key ?? ''),
      epoch: this.#safetyEpoch,
    };
    return this.#lastAbort;
  }

  /**
   * Clear E-Stop latch when the user clicks physical RESUME on EStopOverlay.
   */
  resumeFromHud(info = {}) {
    this.#safetyEpoch += 1;
    this.#estopLatched = false;
    this.#lastResume = {
      ts: Number(info.ts) || Date.now(),
      trigger: String(info.trigger ?? 'button'),
      epoch: this.#safetyEpoch,
    };
    return this.#lastResume;
  }

  /**
   * Assert E-Stop is not latched before starting a mutating or protected action.
   */
  assertEstopClear(toolName) {
    if (!this.#estopLatched) return;
    const via = this.#lastAbort
      ? `（触发来源: ${this.#lastAbort.trigger}${this.#lastAbort.key ? ` / ${this.#lastAbort.key}` : ''}）`
      : '';
    throw new Error(
      `[ESTOP_ACTIVE] 桌面操控当前处于用户急停锁存状态${via}，工具 ${toolName} 已被拒绝执行（action_sent=false）。` +
      '请先向用户确认原因，并请用户在屏幕置顶悬浮窗上手动点击【恢复 RESUME】后，再重新执行操作；AI 无法通过 MCP 自行解除急停。',
    );
  }

  /**
   * Assert screen coordinate does not land on the floating E-Stop/Safety HUD window.
   */
  assertPointNotHud(x, y, what = 'coordinate action') {
    if (!this.#hudBounds || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const b = this.#hudBounds;
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
      throw new Error(
        `[PROTECTED_HUD_TARGET] ${what} at (${x},${y}) falls inside the protected E-Stop/Safety HUD bounds ` +
        `(${b.x},${b.y} ${b.width}x${b.height}). AI control of the HUD is disabled. (action_sent=false)`,
      );
    }
  }

  /**
   * Assert explicit target window HWND is neither the HUD nor disallowed when whitelist is active.
   */
  assertHwndProtectedAndAllowed(winOrHwnd, what = 'window action') {
    const hwnd = typeof winOrHwnd === 'object' && winOrHwnd !== null ? Number(winOrHwnd.hwnd ?? 0) : Number(winOrHwnd ?? 0);
    if (this.#hudHwnd > 0 && hwnd > 0 && hwnd === this.#hudHwnd) {
      throw new Error(`[PROTECTED_HUD_TARGET] ${what} targets the protected HUD hwnd ${hwnd}. (action_sent=false)`);
    }
    if (typeof winOrHwnd === 'object' && winOrHwnd !== null && this.#whitelistEnabled) {
      if (!matchWindowAgainstRules(winOrHwnd, this.#rules)) {
        throw new Error(
          `[WINDOW_NOT_WHITELISTED] ${what} blocked by active window whitelist: target window [${winOrHwnd.process ?? ''}] ` +
          `"${winOrHwnd.title ?? ''}" (hwnd ${hwnd}) is not permitted. (action_sent=false)`,
        );
      }
    }
  }

  /**
   * Assert launch target executable/app name is permitted when whitelist is active.
   */
  assertLaunchAllowed(target) {
    if (!this.#whitelistEnabled) return;
    if (this.#rules.length === 0) {
      throw new Error('[WINDOW_NOT_WHITELISTED] desktop_launch blocked: active window whitelist is empty. (action_sent=false)');
    }
    const base = String(target ?? '').trim().split(/[\\/]/).pop() ?? '';
    const norm = normalizeProcessName(base);
    const allowed = this.#rules.some((rule) => rule.process && norm && wildcardMatch(norm, normalizeProcessName(rule.process)));
    if (!allowed) {
      throw new Error(`[WINDOW_NOT_WHITELISTED] desktop_launch '${target}' blocked by active window whitelist. (action_sent=false)`);
    }
  }

  /**
   * Apply a `desktop_safety` call from the MCP client.
   * Security invariant: AI can inspect status or lock/tighten whitelist,
   * NEVER resume an E-Stop and NEVER disable or widen an active/locked whitelist.
   */
  applyMcpAction(args = {}) {
    const action = String(args.action ?? 'status').trim().toLowerCase();
    if (action === 'status' || action === '') {
      return { ok: true, changed: false, status: this.getStatus() };
    }
    if (action === 'resume' || action === 'clear_estop' || action === 'unlock_estop') {
      throw new Error('[ESTOP_ACTIVE] 急停锁存不可由 AI 通过 MCP 解除，必须由用户在置顶悬浮窗物理点击【恢复 RESUME】。');
    }
    if (action === 'disable_whitelist' || action === 'clear_whitelist' || action === 'unlock_whitelist') {
      throw new Error('[WHITELIST_LOCKED] AI 不可通过 MCP 关闭、清空或解锁窗口白名单，请由用户在悬浮窗【白名单】弹窗中手动修改。');
    }
    if (action === 'lock_whitelist' || action === 'set_whitelist') {
      const nextRules = sanitizeWhitelistRules(args.rules ?? (args.process || args.title_contains || args.titleContains || args.hwnd
        ? [{ process: args.process, titleContains: args.title_contains ?? args.titleContains, hwnd: args.hwnd }]
        : []));
      if (nextRules.length === 0) {
        throw new Error('[BAD_REQUEST] lock_whitelist / set_whitelist requires at least one valid rule ({ process, title_contains, hwnd }).');
      }
      if (this.#whitelistEnabled || this.#whitelistLocked) {
        // Ratchet check: every newly supplied rule must already be covered by the active whitelist!
        const widened = nextRules.filter((nr) => !this.#rules.some((existing) => ruleCoveredBy(nr, existing)));
        if (widened.length > 0) {
          throw new Error(
            '[WHITELIST_LOCKED] 窗口白名单已开启/锁定，AI 只能进一步收紧规则，不能放宽或新增超出当前白名单范围的应用；' +
            '如需增加允许的应用，请由用户在悬浮窗【白名单】中手动添加。',
          );
        }
      }
      this.#whitelistEnabled = true;
      this.#whitelistLocked = true;
      this.#rules = nextRules;
      this.#savePersistedConfig();
      return { ok: true, changed: true, syncOverlay: true, syncWorker: true, status: this.getStatus() };
    }
    if (action === 'tighten_whitelist') {
      if (!this.#whitelistEnabled) {
        return this.applyMcpAction({ ...args, action: 'lock_whitelist' });
      }
      const nextRules = sanitizeWhitelistRules(args.rules ?? (args.process || args.title_contains || args.titleContains || args.hwnd
        ? [{ process: args.process, titleContains: args.title_contains ?? args.titleContains, hwnd: args.hwnd }]
        : []));
      if (nextRules.length === 0) {
        throw new Error('[BAD_REQUEST] tighten_whitelist requires at least one valid rule.');
      }
      const narrowed = nextRules.filter((nr) => this.#rules.some((existing) => ruleCoveredBy(nr, existing)));
      if (narrowed.length === 0) {
        throw new Error('[WHITELIST_LOCKED] tighten_whitelist 中的规则均不在现有白名单交集内，无法扩大范围。');
      }
      this.#rules = narrowed;
      this.#savePersistedConfig();
      return { ok: true, changed: true, syncOverlay: true, syncWorker: true, status: this.getStatus() };
    }
    throw new Error(`[BAD_REQUEST] Unknown desktop_safety action '${action}'. Valid actions: status, lock_whitelist, tighten_whitelist.`);
  }

  getWorkerEnvOverrides() {
    return {
      AGY_DESKTOP_HUD_PID: this.#hudPid > 0 ? String(this.#hudPid) : '',
      AGY_DESKTOP_ESTOP_LATCHED: this.#estopLatched ? '1' : '0',
      AGY_DESKTOP_WHITELIST_ENABLED: this.#whitelistEnabled ? '1' : '0',
      AGY_DESKTOP_WHITELIST_JSON: JSON.stringify(this.#rules),
    };
  }

  getWorkerSafetyConfig() {
    return {
      hudPid: this.#hudPid,
      estopLatched: this.#estopLatched,
      whitelistEnabled: this.#whitelistEnabled,
      rules: this.#rules.map((r) => ({ ...r })),
    };
  }

  getStatus() {
    return {
      estopLatched: this.#estopLatched,
      safetyEpoch: this.#safetyEpoch,
      escMode: this.#escMode,
      comboHotkey: this.#comboHotkey,
      whitelistEnabled: this.#whitelistEnabled,
      whitelistLocked: this.#whitelistLocked,
      whitelistCount: this.#rules.length,
      rules: this.#rules.map((r) => ({ ...r })),
      hud: {
        pid: this.#hudPid,
        hwnd: this.#hudHwnd,
        bounds: this.#hudBounds ? { ...this.#hudBounds } : null,
      },
      lastAbort: this.#lastAbort ? { ...this.#lastAbort } : null,
      lastResume: this.#lastResume ? { ...this.#lastResume } : null,
      configPath: this.#configPath,
    };
  }
}
