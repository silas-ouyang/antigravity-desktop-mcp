/**
 * Standard MCP tool catalog & execution layer for antigravity-desktop-mcp.
 *
 * All desktop control tools pass through:
 * 1. Physical E-Stop latch enforcement (`SafetyController.assertEstopClear`)
 * 2. HUD bounds / HWND protection (`assertPointNotHud`, `assertHwndProtectedAndAllowed`)
 * 3. Ownership verification (`refsRegistry` frames & UIA snapshot refs)
 * 4. Overlay auto-arming activity counter (`beginActivity` / `endActivity`)
 * 5. PowerShell worker + Win32 Named Event E-Stop + Whitelist enforcement
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { launchApp } from './internal/app-launch.js';
import {
  backendMessage,
  decorateFailure,
  isIdempotentCall,
  READ_ONLY_ACTIONS,
  STEP_ACTION_LIST,
  UIA_ACTION_LIST,
  withOutcomeNote,
} from './internal/failures.mjs';
import { combineSignals, describeCall } from './internal/execution.mjs';
import {
  renderState,
  renderTextObservation,
  stateValue,
  STEP_PASSTHROUGH,
  textObservationValue,
} from './internal/tool-contracts.mjs';

function failText(err, cmd = '', args = {}) {
  const raw = backendMessage(err);
  const decorated = decorateFailure(raw, { idempotent: isIdempotentCall(cmd, args) });
  return withOutcomeNote(decorated, err, cmd, args);
}

function asErrorResult(text, extra = {}) {
  return {
    isError: true,
    content: [{ type: 'text', text: String(text) }],
    ...extra,
  };
}

function asTextResult(text) {
  return {
    content: [{ type: 'text', text: String(text) }],
  };
}

function normalizeCaptureOptions(args = {}) {
  const out = {};
  if (args.display !== undefined && args.display !== null && args.display !== '') out.display = args.display;
  if (args.region && typeof args.region === 'object') out.region = args.region;
  if (args.region_space) out.regionSpace = String(args.region_space);
  if (args.window !== undefined && args.window !== null) out.window = Number(args.window);
  if (args.surface) out.surface = String(args.surface);
  if (typeof args.require_window === 'boolean') out.requireWindow = args.require_window;
  if (typeof args.clip === 'boolean') out.clip = args.clip;
  if (args.captures) out.captures = String(args.captures);
  if (Number.isFinite(args.max_related)) out.maxRelated = Math.max(1, Math.min(8, Math.trunc(args.max_related)));
  if (args.format) out.format = String(args.format).toLowerCase();
  if (Number.isFinite(args.quality)) out.quality = Math.max(20, Math.min(100, Math.trunc(args.quality)));
  if (Number.isFinite(args.scale)) out.scale = Math.max(0.2, Math.min(1, Number(args.scale)));
  if (Number.isFinite(args.settle_ms)) out.settleMs = Math.max(0, Math.min(5000, Math.trunc(args.settle_ms)));
  if (Number.isFinite(args.stability_ms)) out.stabilityMs = Math.max(0, Math.min(30000, Math.trunc(args.stability_ms)));
  if (typeof args.stable === 'boolean') out.stable = args.stable;
  return out;
}

function formatWindowListText(windows, { focused } = {}) {
  const lines = [];
  if (focused) {
    lines.push(`focus: hwnd=${focused.hwnd} focused=${focused.focused} visible=${focused.visible} title="${focused.title ?? ''}"`);
  }
  lines.push(`${windows.length} window(s):`);
  for (const w of windows) {
    const flags = [];
    if (w.foreground) flags.push('foreground');
    if (w.minimized) flags.push('minimized');
    const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
    lines.push(`  hwnd=${w.hwnd} pid=${w.pid} [${w.process}] "${w.title}" (${w.x},${w.y} ${w.width}x${w.height})${flagStr}`);
  }
  return lines.join('\n');
}

export const TOOL_DEFINITIONS = [
  {
    name: 'desktop_screenshot',
    description:
      'Capture the Windows screen, a specific display, a specific window (even overlapped via PrintWindow), ' +
      'a screen/window region, or a foreground-plus-related-windows bundle. Returns the image directly plus ' +
      'physical-pixel coordinate metadata and a `frame_id` for accurate click/drag/scroll projection.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        display: {
          oneOf: [{ type: 'integer' }, { type: 'string', enum: ['all'] }],
          description: '0 for primary monitor, 1..N for secondary monitors, or "all" for the entire virtual desktop.',
        },
        region: {
          type: 'object',
          description: 'Rectangular crop { x, y, width, height }.',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer', minimum: 1 },
            height: { type: 'integer', minimum: 1 },
          },
          required: ['x', 'y', 'width', 'height'],
        },
        region_space: { type: 'string', enum: ['screen', 'window'], default: 'screen' },
        window: { type: 'integer', description: 'Window handle (hwnd from desktop_windows) to capture.' },
        surface: { type: 'string', enum: ['window', 'client'], default: 'window' },
        require_window: { type: 'boolean', description: 'Refuse instead of falling back to screen capture if window cannot render.' },
        clip: { type: 'boolean', description: 'Clip region to virtual desktop / window bounds instead of failing.' },
        captures: { type: 'string', enum: ['single', 'related'], default: 'single', description: 'Set "related" to capture related owned dialogs/tool windows of `window`.' },
        max_related: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
        format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
        quality: { type: 'integer', minimum: 20, maximum: 100, default: 85 },
        scale: { type: 'number', minimum: 0.2, maximum: 1.0, default: 1.0 },
        settle_ms: { type: 'integer', minimum: 0, maximum: 5000 },
        stability_ms: { type: 'integer', minimum: 0, maximum: 30000 },
        stable: { type: 'boolean' },
        save_path: { type: 'string', description: 'Optional local file path to copy the screenshot to.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_actions',
    description:
      'Execute a sequence of up to 50 desktop actions (click, move, drag, scroll, type, paste, key, clipboard, ' +
      'focus, launch, wait, wait_for, screenshot, state, or UI Automation actions like invoke/set_value/get_text) in ' +
      'a single round trip. Aborts immediately at <1ms latency if user E-Stop triggers.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          description: 'Ordered action steps to execute.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: `Step action: ${[...STEP_ACTION_LIST, ...UIA_ACTION_LIST].join(', ')}` },
              x: { type: 'integer' },
              y: { type: 'integer' },
              dx: { type: 'integer' },
              dy: { type: 'integer' },
              from_x: { type: 'integer' },
              from_y: { type: 'integer' },
              to_x: { type: 'integer' },
              to_y: { type: 'integer' },
              path: { type: 'array', items: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] } },
              duration_ms: { type: 'integer' },
              button: { type: 'string', enum: ['left', 'right', 'middle'] },
              clicks: { type: 'integer' },
              modifiers: { type: 'string' },
              prefer_a11y: { type: 'boolean' },
              direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
              text: { type: 'string' },
              delay_ms: { type: 'integer' },
              keys: { type: 'string' },
              repeat: { type: 'integer' },
              hold_ms: { type: 'integer' },
              seconds: { type: 'number' },
              op: { type: 'string', enum: ['get', 'set', 'clear'] },
              restore: { type: 'boolean' },
              require_restore: { type: 'boolean' },
              verify: { type: 'object' },
              target: { type: 'string' },
              arguments: { type: 'array', items: { type: 'string' } },
              from_frame: { type: 'string' },
              allow_activate: { type: 'boolean' },
              verify_content: { type: 'boolean' },
              allow_windows: { type: 'array', items: { type: 'object' } },
              into_hwnd: { type: 'integer' },
              hwnd: { type: 'integer' },
              ref: { type: 'string' },
              automation_id: { type: 'string' },
              name: { type: 'string' },
              control_type: { type: 'string' },
              class_name: { type: 'string' },
              index: { type: 'integer' },
              value: { type: 'string' },
              condition: { type: 'object' },
              timeout_ms: { type: 'integer' },
              on_timeout: { type: 'string', enum: ['stop', 'continue'] },
              capture: { type: 'boolean' },
              display: { oneOf: [{ type: 'integer' }, { type: 'string', enum: ['all'] }] },
              region: { type: 'object' },
              window: { type: 'integer' },
            },
            required: ['action'],
            additionalProperties: true,
          },
        },
        stop_on_window_change: { type: 'boolean', default: true },
        expected_transitions: { type: 'array', items: { type: 'object' } },
        capture_after: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['none', 'final', 'each'] }], default: true },
        evidence: { oneOf: [{ type: 'boolean' }, { type: 'object' }] },
        deadline_ms: { type: 'integer', minimum: 100, maximum: 180000 },
        settle_ms: { type: 'integer', minimum: 0, maximum: 5000 },
        stability_ms: { type: 'integer', minimum: 0, maximum: 30000 },
        stable: { type: 'boolean' },
        window: { type: 'integer' },
        require_window: { type: 'boolean' },
        display: { oneOf: [{ type: 'integer' }, { type: 'string', enum: ['all'] }] },
        region: { type: 'object' },
        region_space: { type: 'string', enum: ['screen', 'window'] },
        surface: { type: 'string', enum: ['window', 'client'] },
        clip: { type: 'boolean' },
        format: { type: 'string', enum: ['png', 'jpeg'] },
        quality: { type: 'integer' },
        scale: { type: 'number' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_click',
    description: 'Move to (x, y) and click. Prefer passing `from_frame` from `desktop_screenshot` so occlusion/window movement is guarded automatically.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'Physical desktop pixel X, or image X if `from_frame` is passed.' },
        y: { type: 'integer', description: 'Physical desktop pixel Y, or image Y if `from_frame` is passed.' },
        from_frame: { type: 'string', description: 'Frame id returned by desktop_screenshot.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        clicks: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
        modifiers: { type: 'string', description: 'Optional modifiers held during click, e.g. "ctrl" or "shift".' },
        prefer_a11y: { type: 'boolean', default: true },
        allow_activate: { type: 'boolean', default: false },
        verify_content: { type: 'boolean', default: true },
        allow_windows: { type: 'array', items: { type: 'object' } },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_move',
    description: 'Move the mouse cursor to absolute/frame-projected (x, y) or by relative delta (dx, dy) for hover tooltips or pointer-locked canvases.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' },
        dx: { type: 'integer' },
        dy: { type: 'integer' },
        from_frame: { type: 'string' },
        allow_activate: { type: 'boolean', default: false },
        verify_content: { type: 'boolean', default: true },
        allow_windows: { type: 'array', items: { type: 'object' } },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_drag',
    description: 'Press left button and drag smoothly from (from_x, from_y) to (to_x, to_y), along a multi-point `path`, or continuing from previous drag (`from_last` / `continue_from`).',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        from_x: { type: 'integer' },
        from_y: { type: 'integer' },
        to_x: { type: 'integer' },
        to_y: { type: 'integer' },
        path: {
          type: 'array',
          items: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] },
        },
        from_last: { type: 'boolean' },
        continue_from: { type: 'string' },
        duration_ms: { type: 'integer', minimum: 20, maximum: 10000 },
        from_frame: { type: 'string' },
        modifiers: { type: 'string' },
        allow_activate: { type: 'boolean', default: false },
        verify_content: { type: 'boolean', default: true },
        allow_windows: { type: 'array', items: { type: 'object' } },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_scroll',
    description: 'Scroll vertically or horizontally at (x, y) or current cursor position.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], default: 'down' },
        clicks: { type: 'integer', minimum: 0, maximum: 100, default: 3 },
        x: { type: 'integer' },
        y: { type: 'integer' },
        from_frame: { type: 'string' },
        allow_activate: { type: 'boolean', default: false },
        verify_content: { type: 'boolean', default: true },
        allow_windows: { type: 'array', items: { type: 'object' } },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_type',
    description: 'Type Unicode text cleanly using SendInput KEYEVENTF_UNICODE into the active foreground window (use `into_hwnd` to guard against focus stealing).',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        delay_ms: { type: 'integer', minimum: 0, maximum: 200, default: 0 },
        into_hwnd: { type: 'integer', description: 'Refuse if foreground window handle does not match this hwnd.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_key',
    description: 'Press or hold a key or key chord (e.g. "enter", "ctrl+s", "alt+f4", "ctrl+shift+p"). Blocked OS-escape chords are rejected under whitelist mode.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'Key name or `+`-joined chord (e.g. "ctrl+a", "f5", "esc").' },
        repeat: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
        hold_ms: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
        into_hwnd: { type: 'integer' },
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_windows',
    description: 'Enumerate visible Windows application windows (and optionally minimized ones with `include_minimized`), or bring a window to foreground via `focus_hwnd`.',
    annotations: { readOnlyHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Substring regex filter matching window title or process name.' },
        include_minimized: { type: 'boolean', default: false },
        focus_hwnd: { type: 'integer', description: 'Optional hwnd to bring to foreground.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_ui',
    description:
      'Inspect a window\'s UI Automation accessibility tree (with compact `[s#.#]` control refs for `desktop_ui_action`, ' +
      'snapshot delta diffing, pattern filtering, and optional focused/selected/document text observation).',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        hwnd: { type: 'integer' },
        max_depth: { type: 'integer', minimum: 1, maximum: 25, default: 6 },
        max_nodes: { type: 'integer', minimum: 1, maximum: 2000, default: 250 },
        max_visited: { type: 'integer', minimum: 1, maximum: 20000 },
        compact: { type: 'boolean', default: true },
        skip_empty: { type: 'boolean', default: true },
        prune: { type: 'boolean', default: true },
        patterns: { type: 'boolean', default: true },
        delta_of: { type: 'string', description: 'Previous snapshot id to compute only added/moved/altered/removed changes.' },
        filter: {
          type: 'object',
          properties: {
            automation_id: { type: 'string' },
            name: { type: 'string' },
            control_type: { type: 'string' },
            class_name: { type: 'string' },
            interactive_only: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        text_target: { type: 'object', additionalProperties: true },
        text_budget: { type: 'integer', minimum: 100, maximum: 50000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_ui_action',
    description: 'Perform a UI Automation action on a control identified by `ref` (from `desktop_ui`) or by selector (`hwnd`, `automation_id`, `name`, `control_type`, `class_name`, `index`).',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: UIA_ACTION_LIST },
        ref: { type: 'string', description: 'Control ref from desktop_ui, e.g. "s1.4".' },
        hwnd: { type: 'integer' },
        automation_id: { type: 'string' },
        name: { type: 'string' },
        control_type: { type: 'string' },
        class_name: { type: 'string' },
        index: { type: 'integer', minimum: 0, default: 0 },
        value: { type: 'string' },
        text: { type: 'string' },
        prefix: { type: 'string' },
        suffix: { type: 'string' },
        instance: { type: 'integer' },
        occurrence: { type: 'integer' },
        occurrence_mode: { type: 'string', enum: ['match', 'occurrence'] },
        scroll_to: { type: 'boolean' },
        click_located: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_clipboard',
    description: 'Read (`get`), write (`set`), or `clear` the Windows text clipboard.',
    annotations: { readOnlyHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['get', 'set', 'clear'], default: 'get' },
        text: { type: 'string', description: 'Text to write when op is "set".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_paste',
    description: 'Paste long or multi-line Unicode text reliably via clipboard + Ctrl+V, automatically saving & restoring previous clipboard contents (use `require_restore: true` to refuse if clipboard contains non-text data).',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        restore: { type: 'boolean', default: true },
        require_restore: { type: 'boolean', default: false },
        into_hwnd: { type: 'integer' },
        verify: { type: 'object', additionalProperties: true },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_launch',
    description: 'Launch a Windows application, executable path, Start Menu display name, URL, or Store app with Electron/Node-injection env vars stripped cleanly, and wait for its window.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Executable path, PATH command name, Start Menu display name, URL, or shell: AppsFolder target.' },
        arguments: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        wait_seconds: { type: 'number', minimum: 0, maximum: 30, default: 8 },
        kind: { type: 'string', enum: ['', 'store'], default: '' },
        refresh: { type: 'boolean', default: false },
        verify_window: { type: 'boolean', default: true },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_stop',
    description: 'URGENT: Immediately abort all running and queued desktop actions, kill hung workers if needed, confirm held keys/mouse buttons are released, and optionally latch the E-Stop.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short explanation of why the operation is being stopped.' },
        latch: { type: 'boolean', default: false, description: 'If true, also latch the E-Stop overlay so user must click RESUME before further desktop control.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_safety',
    description:
      'Inspect physical E-Stop overlay state, hotkey config (`Esc` mode + combo), window whitelist rules, and backend health, ' +
      'OR lock/tighten the window whitelist (`lock_whitelist` / `tighten_whitelist`). AI cannot clear an E-Stop or disable/widen an active whitelist.',
    annotations: { readOnlyHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'lock_whitelist', 'tighten_whitelist'], default: 'status' },
        rules: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              process: { type: 'string' },
              title_contains: { type: 'string' },
              hwnd: { type: 'integer' },
            },
            additionalProperties: false,
          },
        },
        process: { type: 'string', description: 'Shorthand single rule process name (e.g. "notepad", "Siemens.Automation.Portal").' },
        title_contains: { type: 'string' },
        hwnd: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
];

/**
 * Return true when an MCP tool call is purely read-only observation
 * and can safely inspect screen/UI state while an E-Stop latch is active.
 */
export function isReadOnlyToolCall(name, args = {}) {
  switch (name) {
    case 'desktop_safety':
      return String(args?.action ?? 'status').toLowerCase() === 'status';
    case 'desktop_screenshot':
    case 'desktop_ui':
      return true;
    case 'desktop_windows':
      return !Number.isFinite(args?.focus_hwnd);
    case 'desktop_clipboard':
      return String(args?.op ?? 'get').toLowerCase() === 'get';
    case 'desktop_ui_action':
      return READ_ONLY_ACTIONS.has(String(args?.action ?? '').toLowerCase());
    default:
      return false;
  }
}

/**
 * Create the complete MCP tool handler wired to backend worker, physical HUD overlay, safety controller, and capture service.
 */
export function createDesktopToolbox({
  backend,
  overlay,
  safety,
  captureService,
  executionRegistry,
  refsRegistry,
  sessionId = 'default',
  abortQueuedServerCalls = null,
}) {
  const genOf = () => (backend.info?.generation ? String(backend.info.generation) : '');

  async function runTracked(cmd, workerArgs, { signal, mutating = true, timeoutMs, activityLabel } = {}) {
    if (mutating) {
      safety.assertEstopClear(cmd);
    }
    const controller = new AbortController();
    const untrack = executionRegistry.track(sessionId, controller);
    const mergedSignal = combineSignals(signal, controller.signal);
    const label = activityLabel || describeCall(cmd, workerArgs);
    if (mutating) {
      await overlay?.beginActivity(label);
    }
    try {
      const result = await backend.call(cmd, workerArgs, { signal: mergedSignal, timeoutMs });
      if (result && typeof result === 'object') {
        const fId = result.frame ?? result.frameId;
        if (fId) refsRegistry.noteFrame(sessionId, String(fId));
        if (result.snapshot) refsRegistry.noteSnapshot(sessionId, result.snapshot);
      }
      return result;
    } finally {
      untrack();
      if (mutating) {
        overlay?.endActivity();
      }
    }
  }

  function mapBatchStep(step) {
    const out = { ...step };
    if (step.hold_ms !== undefined && step.hold_seconds === undefined) {
      out.hold_seconds = Number(step.hold_ms) / 1000;
    }
    return out;
  }

  async function handleScreenshot(args, signal) {
    const opts = normalizeCaptureOptions(args);
    const fmt = opts.format === 'jpeg' ? 'jpeg' : 'png';
    const ext = fmt === 'jpeg' ? 'jpg' : 'png';
    const path = await captureService.nextCapturePath(ext);

    const shot = await captureService.withCaptureExclusion(() => runTracked('screenshot', {
      path,
      ...opts,
    }, { signal, mutating: false, timeoutMs: Math.max(30_000, (opts.stabilityMs ?? 0) + 15_000) }));

    if (Array.isArray(shot.related) && shot.related.length > 0) {
      const content = [];
      const envelopes = [];
      const primary = await captureService.prepareShotResult(shot, {
        sessionId,
        savePath: opts.savePath || args.save_path || '',
        name: 'primary',
      });
      if (shot.frame ?? shot.frameId) refsRegistry.noteFrame(sessionId, String(shot.frame ?? shot.frameId));
      content.push(primary.imageContent);
      envelopes.push(`[primary]\n${primary.envelopeText}`);
      for (const rel of shot.related) {
        if (!rel?.path) continue;
        if (rel.frame ?? rel.frameId) refsRegistry.noteFrame(sessionId, String(rel.frame ?? rel.frameId));
        const relPrepared = await captureService.prepareShotResult(rel, { sessionId, name: rel.role || 'related' });
        content.push(relPrepared.imageContent);
        envelopes.push(`[related hwnd=${rel.hwnd} title="${rel.title ?? ''}"]\n${relPrepared.envelopeText}`);
      }
      content.push({ type: 'text', text: envelopes.join('\n\n') });
      return { content };
    }

    const prepared = await captureService.prepareShotResult(shot, {
      sessionId,
      savePath: args.save_path || '',
      name: 'desktop_screenshot',
    });
    if (shot.frame ?? shot.frameId) refsRegistry.noteFrame(sessionId, String(shot.frame ?? shot.frameId));
    return {
      content: [
        prepared.imageContent,
        { type: 'text', text: prepared.envelopeText },
      ],
    };
  }

  async function handleActions(args, signal) {
    safety.assertEstopClear('desktop_actions');
    const rawSteps = Array.isArray(args.steps) ? args.steps : [];
    if (rawSteps.length === 0 || rawSteps.length > 50) {
      return asErrorResult('[BAD_REQUEST] desktop_actions requires 1..50 steps.');
    }

    const mappedSteps = [];
    for (let i = 0; i < rawSteps.length; i += 1) {
      const s = rawSteps[i];
      if (!s || typeof s !== 'object') {
        return asErrorResult(`[BAD_REQUEST] step ${i} must be an object.`);
      }
      if (s.from_frame) refsRegistry.assertFrameOwnership(sessionId, String(s.from_frame));
      if (s.ref) refsRegistry.assertRefOwnership(sessionId, String(s.ref));
      if (!s.from_frame) {
        if (Number.isFinite(s.x) && Number.isFinite(s.y)) safety.assertPointNotHud(s.x, s.y, `step ${i} (${s.action})`);
        if (Number.isFinite(s.from_x) && Number.isFinite(s.from_y)) safety.assertPointNotHud(s.from_x, s.from_y, `step ${i} drag start`);
        if (Number.isFinite(s.to_x) && Number.isFinite(s.to_y)) safety.assertPointNotHud(s.to_x, s.to_y, `step ${i} drag end`);
      }
      if (Number.isFinite(s.hwnd)) safety.assertHwndProtectedAndAllowed(s.hwnd, `step ${i} (${s.action})`);
      if (Number.isFinite(s.into_hwnd)) safety.assertHwndProtectedAndAllowed(s.into_hwnd, `step ${i} (${s.action})`);
      mappedSteps.push(mapBatchStep(s));
    }

    const capOpts = normalizeCaptureOptions(args);
    const fmt = capOpts.format === 'jpeg' ? 'jpeg' : 'png';
    const captureAfterRaw = args.capture_after;
    const wantsCapture = captureAfterRaw === undefined ? true : (captureAfterRaw !== false && captureAfterRaw !== 'none');
    const shotPath = wantsCapture ? await captureService.nextCapturePath(fmt === 'jpeg' ? 'jpg' : 'png') : '';

    const batchArgs = {
      steps: mappedSteps,
      stopOnWindowChange: args.stop_on_window_change !== false,
      expectedTransitions: args.expected_transitions,
      screenshot: wantsCapture,
      captureAfter: wantsCapture ? (captureAfterRaw === 'each' ? 'each' : 'final') : 'none',
      evidence: args.evidence,
      deadlineMs: args.deadline_ms,
      ...capOpts,
      ...(shotPath ? { path: shotPath } : {}),
    };

    const runBatch = () => runTracked('batch', batchArgs, {
      signal,
      mutating: true,
      timeoutMs: Math.max(45_000, Number(args.deadline_ms ?? 30_000) + 15_000),
      activityLabel: `${mappedSteps.length} step(s)`,
    });

    const res = wantsCapture ? await captureService.withCaptureExclusion(runBatch) : await runBatch();
    const content = [];
    let envelope = '';
    if (res.shot && res.shot.path) {
      if (res.shot.frame ?? res.shot.frameId) refsRegistry.noteFrame(sessionId, String(res.shot.frame ?? res.shot.frameId));
      const prepared = await captureService.prepareShotResult(res.shot, { sessionId, name: 'batch_after' });
      content.push(prepared.imageContent);
      envelope = `\n\n${prepared.envelopeText}`;
    }

    const batchFailed = Boolean(res.error) || res.outcome === 'cancelled' || (Number.isInteger(res.failedAt) && res.failedAt >= 0);
    const summaryLines = [
      ...(res.error ? [decorateFailure(String(res.error), { idempotent: isIdempotentCall('batch', batchArgs) })] : []),
      `batch outcome=${res.outcome ?? 'ok'} performed=${(res.performed ?? []).length}/${mappedSteps.length} steps (${res.durationMs ?? res.elapsedMs ?? 0} ms)`,
      ...(res.performed ?? []).map((p, idx) => `  ${idx + 1}. ${p}`),
      ...(res.waits?.length ? [`waits: ${JSON.stringify(res.waits)}`] : []),
      ...(res.state ? [`state:\n${renderState(stateValue(res.state, false), true)}`] : []),
    ];
    content.push({ type: 'text', text: `${summaryLines.join('\n')}${envelope}` });
    return batchFailed ? { isError: true, content } : { content };
  }

  async function executeTool(name, args = {}, { signal } = {}) {
    switch (name) {
      case 'desktop_screenshot':
        try {
          return await handleScreenshot(args, signal);
        } catch (err) {
          return asErrorResult(failText(err, 'screenshot', args));
        }

      case 'desktop_actions':
        try {
          return await handleActions(args, signal);
        } catch (err) {
          return asErrorResult(failText(err, 'batch', { steps: args.steps }));
        }

      case 'desktop_click': {
        try {
          safety.assertEstopClear(name);
          if (args.from_frame) refsRegistry.assertFrameOwnership(sessionId, String(args.from_frame));
          else safety.assertPointNotHud(args.x, args.y, 'click');
          const payload = {
            x: args.x,
            y: args.y,
            fromFrame: args.from_frame,
            button: args.button ?? 'left',
            clicks: args.clicks ?? 1,
            modifiers: args.modifiers,
            preferA11y: args.prefer_a11y !== false,
            allowActivate: args.allow_activate === true,
            verifyContent: args.verify_content !== false,
            allowWindows: args.allow_windows,
          };
          const res = await runTracked('click', payload, { signal, mutating: true });
          return asTextResult(JSON.stringify(res, null, 2));
        } catch (err) {
          return asErrorResult(failText(err, 'click', args));
        }
      }

      case 'desktop_move': {
        try {
          safety.assertEstopClear(name);
          if (args.dx === undefined && args.dy === undefined && (args.x === undefined || args.y === undefined)) {
            return asErrorResult('[BAD_REQUEST] desktop_move requires either (x, y) or (dx, dy).');
          }
          if (args.from_frame) refsRegistry.assertFrameOwnership(sessionId, String(args.from_frame));
          else if (Number.isFinite(args.x) && Number.isFinite(args.y)) safety.assertPointNotHud(args.x, args.y, 'move');
          const res = await runTracked('move', {
            x: args.x,
            y: args.y,
            dx: args.dx,
            dy: args.dy,
            fromFrame: args.from_frame,
            allowActivate: args.allow_activate === true,
            verifyContent: args.verify_content !== false,
            allowWindows: args.allow_windows,
          }, { signal, mutating: true });
          return asTextResult(JSON.stringify(res, null, 2));
        } catch (err) {
          return asErrorResult(failText(err, 'move', args));
        }
      }

      case 'desktop_drag': {
        try {
          safety.assertEstopClear(name);
          if (args.from_frame) refsRegistry.assertFrameOwnership(sessionId, String(args.from_frame));
          else {
            if (Number.isFinite(args.from_x) && Number.isFinite(args.from_y)) safety.assertPointNotHud(args.from_x, args.from_y, 'drag start');
            if (Number.isFinite(args.to_x) && Number.isFinite(args.to_y)) safety.assertPointNotHud(args.to_x, args.to_y, 'drag end');
            if (Array.isArray(args.path)) {
              for (const pt of args.path) {
                if (Number.isFinite(pt?.x) && Number.isFinite(pt?.y)) safety.assertPointNotHud(pt.x, pt.y, 'drag waypoint');
              }
            }
          }
          const durationMs = args.duration_ms ?? 300;
          const res = await runTracked('drag', {
            fromX: args.from_x,
            fromY: args.from_y,
            toX: args.to_x,
            toY: args.to_y,
            path: args.path,
            fromLast: args.from_last,
            continueFrom: args.continue_from,
            durationMs,
            fromFrame: args.from_frame,
            modifiers: args.modifiers,
            allowActivate: args.allow_activate === true,
            verifyContent: args.verify_content !== false,
            allowWindows: args.allow_windows,
          }, { signal, mutating: true, timeoutMs: Math.max(30_000, durationMs + 15_000) });
          return asTextResult(JSON.stringify(res, null, 2));
        } catch (err) {
          return asErrorResult(failText(err, 'drag', args));
        }
      }

      case 'desktop_scroll': {
        try {
          safety.assertEstopClear(name);
          if (args.from_frame) refsRegistry.assertFrameOwnership(sessionId, String(args.from_frame));
          else if (Number.isFinite(args.x) && Number.isFinite(args.y)) safety.assertPointNotHud(args.x, args.y, 'scroll');
          const res = await runTracked('scroll', {
            direction: args.direction ?? 'down',
            clicks: args.clicks ?? 3,
            x: args.x,
            y: args.y,
            fromFrame: args.from_frame,
            allowActivate: args.allow_activate === true,
            verifyContent: args.verify_content !== false,
            allowWindows: args.allow_windows,
          }, { signal, mutating: true });
          return asTextResult(JSON.stringify(res, null, 2));
        } catch (err) {
          return asErrorResult(failText(err, 'scroll', args));
        }
      }

      case 'desktop_type': {
        try {
          safety.assertEstopClear(name);
          if (Number.isFinite(args.into_hwnd)) safety.assertHwndProtectedAndAllowed(args.into_hwnd, 'type');
          const res = await runTracked('type', {
            text: String(args.text ?? ''),
            delayMs: args.delay_ms ?? 0,
            intoHwnd: args.into_hwnd,
          }, { signal, mutating: true, timeoutMs: Math.max(30_000, String(args.text ?? '').length * ((args.delay_ms ?? 0) + 5) + 10_000) });
          return asTextResult(JSON.stringify(res, null, 2));
        } catch (err) {
          return asErrorResult(failText(err, 'type', args));
        }
      }

      case 'desktop_key': {
        try {
          safety.assertEstopClear(name);
          if (Number.isFinite(args.into_hwnd)) safety.assertHwndProtectedAndAllowed(args.into_hwnd, 'key');
          const holdMs = Number(args.hold_ms ?? 0);
          const res = await runTracked('key', {
            keys: String(args.keys ?? ''),
            repeat: args.repeat ?? 1,
            holdMs,
            intoHwnd: args.into_hwnd,
          }, { signal, mutating: true, timeoutMs: Math.max(30_000, holdMs + 10_000) });
          return asTextResult(JSON.stringify(res, null, 2));
        } catch (err) {
          return asErrorResult(failText(err, 'key', args));
        }
      }

      case 'desktop_windows': {
        try {
          let focused = null;
          if (Number.isFinite(args.focus_hwnd) && Number(args.focus_hwnd) > 0) {
            safety.assertEstopClear('desktop_windows(focus_hwnd)');
            safety.assertHwndProtectedAndAllowed(args.focus_hwnd, 'focus_hwnd');
            focused = await runTracked('focus', { hwnd: Number(args.focus_hwnd) }, { signal, mutating: true });
          }
          const listed = await runTracked('windows', {
            filter: args.filter ?? '',
            include_minimized: args.include_minimized === true,
          }, { signal, mutating: false });
          return asTextResult(formatWindowListText(listed.windows ?? [], { focused }));
        } catch (err) {
          return asErrorResult(failText(err, Number.isFinite(args.focus_hwnd) ? 'focus' : 'windows', args));
        }
      }

      case 'desktop_ui': {
        try {
          if (Number.isFinite(args.hwnd)) safety.assertHwndProtectedAndAllowed(args.hwnd, 'desktop_ui');
          const filter = args.filter && typeof args.filter === 'object' ? args.filter : {};
          const search = Boolean(filter.automation_id || filter.name || filter.control_type || filter.class_name || filter.interactive_only);
          const cmdArgs = {
            hwnd: args.hwnd,
            maxDepth: args.max_depth ?? 6,
            maxNodes: args.max_nodes ?? 250,
            maxVisited: args.max_visited,
            skipEmpty: args.skip_empty !== false,
            prune: args.prune !== false,
            patterns: args.patterns !== false,
            deltaOf: args.delta_of,
            automationId: filter.automation_id,
            name: filter.name,
            controlType: filter.control_type,
            className: filter.class_name,
            interactiveOnly: filter.interactive_only === true,
            textTarget: args.text_target,
            textBudget: args.text_budget,
          };
          const res = await runTracked('uitree', cmdArgs, { signal, mutating: false, timeoutMs: 45_000 });
          if (res.snapshot) refsRegistry.noteSnapshot(sessionId, res.snapshot);
          const val = stateValue(res, search);
          return asTextResult(renderState(val, args.compact !== false));
        } catch (err) {
          return asErrorResult(failText(err, 'uitree', args));
        }
      }

      case 'desktop_ui_action': {
        try {
          const action = String(args.action ?? '').toLowerCase();
          const isReadOnly = READ_ONLY_ACTIONS.has(action);
          if (!isReadOnly) safety.assertEstopClear(name);
          if (args.ref) refsRegistry.assertRefOwnership(sessionId, String(args.ref));
          if (Number.isFinite(args.hwnd)) safety.assertHwndProtectedAndAllowed(args.hwnd, `desktop_ui_action(${action})`);

          const res = await runTracked('uiact', {
            action,
            ref: args.ref,
            hwnd: args.hwnd,
            automationId: args.automation_id,
            name: args.name,
            controlType: args.control_type,
            className: args.class_name,
            index: args.index ?? 0,
            value: args.value,
            text: args.text,
            prefix: args.prefix,
            suffix: args.suffix,
            instance: args.instance,
            occurrence: args.occurrence,
            occurrenceMode: args.occurrence_mode,
            scrollTo: args.scroll_to,
            clickLocated: args.click_located,
          }, { signal, mutating: !isReadOnly, activityLabel: `uiact ${action}` });

          if (isReadOnly && res.textObservation) {
            return asTextResult(renderTextObservation(textObservationValue(res.textObservation)));
          }
          return asTextResult(JSON.stringify(res, null, 2));
        } catch (err) {
          return asErrorResult(failText(err, 'uiact', args));
        }
      }

      case 'desktop_clipboard': {
        try {
          const op = String(args.op ?? 'get').toLowerCase();
          if (op !== 'get') safety.assertEstopClear(`desktop_clipboard(${op})`);
          const res = await runTracked('clipboard', { op, text: args.text }, { signal, mutating: op !== 'get' });
          return asTextResult(JSON.stringify(res, null, 2));
        } catch (err) {
          return asErrorResult(failText(err, 'clipboard', args));
        }
      }

      case 'desktop_paste': {
        try {
          safety.assertEstopClear(name);
          if (Number.isFinite(args.into_hwnd)) safety.assertHwndProtectedAndAllowed(args.into_hwnd, 'paste');
          const res = await runTracked('paste', {
            text: String(args.text ?? ''),
            restore: args.restore !== false,
            requireRestore: args.require_restore === true,
            intoHwnd: args.into_hwnd,
            verify: args.verify,
          }, { signal, mutating: true });
          return asTextResult(JSON.stringify(res, null, 2));
        } catch (err) {
          return asErrorResult(failText(err, 'paste', args));
        }
      }

      case 'desktop_launch': {
        try {
          safety.assertEstopClear(name);
          const target = String(args.target ?? '').trim();
          if (!target) return asErrorResult('[BAD_REQUEST] desktop_launch requires a non-empty target.');
          safety.assertLaunchAllowed(target);
          const lower = target.toLowerCase();
          const directLaunch = args.kind === 'store' || lower.startsWith('shell:') || /^[a-z]+:\/\//i.test(target)
            || (isAbsolute(target) && existsSync(target));

          if (directLaunch) {
            await overlay?.beginActivity(`launch ${target}`);
            try {
              const report = await launchApp({
                target,
                arguments: args.arguments ?? [],
                cwd: args.cwd,
                kind: args.kind ?? '',
                waitMs: Math.round(Number(args.wait_seconds ?? 8) * 1000),
                verifyWindow: args.verify_window !== false,
              });
              if (report.ok === false) return asErrorResult(JSON.stringify(report, null, 2));
              return asTextResult(JSON.stringify(report, null, 2));
            } finally {
              overlay?.endActivity();
            }
          }

          const res = await runTracked('launch', {
            target,
            arguments: args.arguments ?? [],
            waitSeconds: args.wait_seconds ?? 8,
            refresh: args.refresh === true,
          }, { signal, mutating: true, timeoutMs: 40_000 });
          return asTextResult(JSON.stringify(res, null, 2));
        } catch (err) {
          return asErrorResult(failText(err, 'launch', args));
        }
      }

      case 'desktop_stop': {
        const reason = String(args.reason ?? 'Stopped by desktop_stop tool');
        let latchedNow = safety.isEstopLatched();
        if (args.latch === true) {
          if (overlay?.alive) {
            await overlay.call('estop', { detail: reason }).catch(() => { /* fallback below */ });
          }
          safety.triggerEstop({ trigger: 'mcp_stop', key: '', ts: Date.now() });
          latchedNow = true;
        }
        const serverQueuedAborted = abortQueuedServerCalls ? abortQueuedServerCalls(`[USER_ABORTED] ${reason}`) : 0;
        const abortPromise = backend.abortAll({ reason, userAborted: args.latch === true });
        const execAborted = executionRegistry.abort(sessionId, `[USER_ABORTED] ${reason}`);
        const abortReport = await abortPromise;
        return asTextResult(JSON.stringify({
          aborted: true,
          reason,
          estopLatched: latchedNow,
          serverQueuedAborted,
          executionAborted: execAborted,
          ...abortReport,
        }, null, 2));
      }

      case 'desktop_safety': {
        try {
          const outcome = safety.applyMcpAction(args);
          if (outcome.syncOverlay && overlay?.alive) {
            await overlay.syncWhitelistFromSafety().catch(() => { /* best effort */ });
          }
          if (outcome.syncWorker) {
            await backend.syncSafetyConfig(safety.getWorkerSafetyConfig());
          }
          const payload = {
            ...outcome.status,
            overlay: {
              alive: overlay?.alive ?? false,
              visualReady: overlay?.visualReady ?? false,
              excludeFromCapture: overlay?.excludeFromCapture ?? false,
              hookInstalled: overlay?.hookInstalled ?? false,
              hotkeyRegistered: overlay?.hotkeyRegistered ?? false,
            },
            backend: {
              alive: backend.alive,
              state: backend.state,
              outstanding: backend.outstanding,
              generation: genOf() || null,
              stats: backend.stats,
              lastRelease: backend.lastRelease ?? null,
              lastStopReport: backend.lastStopReport ?? null,
            },
          };
          return asTextResult(JSON.stringify(payload, null, 2));
        } catch (err) {
          return asErrorResult(decorateFailure(err?.message ?? String(err)));
        }
      }

      default:
        return asErrorResult(`Unknown tool: ${name}`);
    }
  }

  return {
    toolDefinitions: TOOL_DEFINITIONS,
    executeTool,
  };
}
