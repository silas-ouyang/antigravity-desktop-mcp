/**
 * Local stdio JSON-RPC 2.0 MCP server for Antigravity (`antigravity-desktop-mcp`).
 *
 * Key guarantees:
 * - Zero non-JSON output to stdout (logs go strictly to stderr)
 * - Urgent bypass queue for `desktop_stop` and read-only `desktop_safety`
 * - Instant cancellation of queued server calls when physical E-Stop or `desktop_stop` triggers
 * - Clean shutdown on stdin EOF/close/SIGINT/SIGTERM (tears down worker, HUD overlay, temp captures)
 * - Zero background polling while idle
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PowerShellBackend } from './backend/bridge.js';
import { CaptureService } from './capture-service.js';
import { createCaptureExclusion } from './internal/capture-exclusion.mjs';
import { createExecutionRegistry } from './internal/execution.mjs';
import { createRefRegistry } from './internal/refs.mjs';
import { OverlaySupervisor } from './overlay-supervisor.js';
import { SafetyController } from './safety.js';
import { createDesktopToolbox, isReadOnlyToolCall } from './tools.js';

export const SERVER_INFO = {
  name: 'antigravity-desktop-mcp',
  version: '1.0.0',
};

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function logErr(msg) {
  process.stderr.write(`[antigravity-desktop-mcp] ${msg}\n`);
}

function sendJson(outputStream, obj) {
  outputStream.write(`${JSON.stringify(obj)}\n`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * Create a self-contained MCP server instance (parameterizable streams & options for E2E tests).
 */
export function createDesktopMcpServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const sessionId = options.sessionId ?? 'default';
  const runId = `run-${process.pid}-${randomBytes(3).toString('hex')}`;
  const runDir = options.runDir ?? join(tmpdir(), 'antigravity-desktop-mcp', runId);
  mkdirSync(runDir, { recursive: true });

  const cancelFilePath = options.cancelFilePath ?? join(runDir, 'cancel.flag');
  const heldFilePath = options.heldFilePath ?? join(runDir, 'held.json');
  const cancelEventName = options.cancelEventName ?? `Local\\AntigravityDesktopCancel_${process.pid}_${randomBytes(3).toString('hex')}`;
  const captureDir = join(runDir, 'captures');

  const safety = options.safety ?? new SafetyController({
    configPath: options.safetyConfigPath,
  });

  const overlay = options.enableOverlay === false ? null : (options.overlay ?? new OverlaySupervisor({
    cancelEventName,
    cancelFilePath,
    safety,
    allowIpcResume: options.allowIpcResume === true,
    armedCooldownMs: options.armedCooldownMs,
  }));

  const backend = options.backend ?? new PowerShellBackend({
    cancelFilePath,
    heldFilePath,
    cancelEventName,
    safety,
    cancelGraceMs: options.cancelGraceMs ?? 600,
    timeoutMs: options.timeoutMs ?? 30_000,
  });

  const executionRegistry = createExecutionRegistry();
  const refsRegistry = createRefRegistry({
    generationOf: () => (backend.info?.generation ? String(backend.info.generation) : ''),
  });

  const captureExclusion = overlay
    ? createCaptureExclusion({
        suspend: async () => {
          if (overlay.alive && !overlay.excludeFromCapture) {
            await overlay.suspendVisual('capture');
          }
        },
        resume: async () => {
          if (overlay.alive && !overlay.excludeFromCapture) {
            await overlay.resumeVisual();
          }
        },
      })
    : null;

  const captureService = new CaptureService({
    captureDir,
    captureExclusion,
    getVisualGeneration: () => (overlay?.alive ? (overlay.pid ?? overlay.hwnd ?? 0) : null),
  });

  // Pending non-urgent calls waiting behind the serial execution lane
  let serialQueueTail = Promise.resolve();
  const waitingInQueue = new Set();

  function abortQueuedServerCalls(reason) {
    let aborted = 0;
    for (const waiter of [...waitingInQueue]) {
      waitingInQueue.delete(waiter);
      waiter.abort(reason);
      aborted += 1;
    }
    return aborted;
  }

  // Wire Overlay physical E-Stop / Resume / Whitelist events -> backend immediately
  if (overlay) {
    overlay.on('estop', (evt) => {
      const msg = `[USER_ABORTED] Physical E-Stop triggered (${evt?.trigger ?? 'hotkey'}${evt?.key ? `:${evt.key}` : ''})`;
      logErr(msg);
      abortQueuedServerCalls(msg);
      void backend.abortAll({ reason: msg, userAborted: true });
      executionRegistry.abort(sessionId, msg);
      void backend.syncSafetyConfig(safety.getWorkerSafetyConfig());
    });

    overlay.on('resume', () => {
      logErr('User clicked physical RESUME on HUD; E-Stop unlatched.');
      void backend.syncSafetyConfig(safety.getWorkerSafetyConfig());
    });

    overlay.on('whitelistChanged', () => {
      logErr(`HUD whitelist changed: enabled=${safety.isWhitelistEnabled()}, count=${safety.getStatus().whitelistCount}`);
      void backend.syncSafetyConfig(safety.getWorkerSafetyConfig());
    });

    overlay.on('hotkeyChanged', () => {
      const st = safety.getStatus();
      logErr(`HUD hotkey changed: escMode=${st.escMode}, comboHotkey=${st.comboHotkey}`);
    });
  }

  const toolbox = createDesktopToolbox({
    backend,
    overlay,
    safety,
    captureService,
    executionRegistry,
    refsRegistry,
    sessionId,
    abortQueuedServerCalls,
  });

  let disposed = false;
  let overlayBootPromise = null;

  function ensureOverlayBooted() {
    if (!overlay || disposed) return Promise.resolve(null);
    if (!overlayBootPromise) {
      overlayBootPromise = overlay.ensureStarted().catch((err) => {
        logErr(`Warning: EStopOverlay failed to start: ${err?.message ?? err}`);
        return null;
      });
    }
    return overlayBootPromise;
  }

  function enqueueSerialized(fn, { allowUnderEstop = false } = {}) {
    if (!allowUnderEstop && safety.isEstopLatched()) {
      return Promise.reject(new Error('[ESTOP_ACTIVE] User E-Stop is latched; queued operation refused.'));
    }
    let abortedReason = null;
    let rejectWaiter = null;
    const waiter = {
      abort(reason) {
        abortedReason = reason || '[USER_ABORTED] Operation aborted while queued.';
        if (rejectWaiter) rejectWaiter(new Error(abortedReason));
      },
    };
    waitingInQueue.add(waiter);

    const run = serialQueueTail.then(async () => {
      waitingInQueue.delete(waiter);
      if (abortedReason !== null) throw new Error(abortedReason);
      return fn();
    });

    const raceAborted = new Promise((_, reject) => {
      rejectWaiter = reject;
    });

    // Advance serial tail cleanly even if individual tool calls fail or abort
    serialQueueTail = run.catch(() => undefined);
    return Promise.race([run, raceAborted]);
  }

  async function handleJsonRpc(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg?.id !== undefined) {
        sendJson(output, jsonRpcError(msg.id, -32600, 'Invalid Request'));
      }
      return;
    }

    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case 'initialize': {
          const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSIONS[0];
          const negotiated = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
          // Start HUD asynchronously without blocking MCP handshake
          void ensureOverlayBooted();
          if (!isNotification) {
            sendJson(output, jsonRpcResult(id, {
              protocolVersion: negotiated,
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
            }));
          }
          break;
        }

        case 'notifications/initialized':
        case 'initialized':
          void ensureOverlayBooted();
          break;

        case 'notifications/cancelled':
          if (params?.requestId !== undefined) {
            executionRegistry.abort(sessionId, 'Client cancelled request');
          }
          break;

        case 'ping':
          if (!isNotification) sendJson(output, jsonRpcResult(id, {}));
          break;

        case 'tools/list':
          if (!isNotification) {
            sendJson(output, jsonRpcResult(id, { tools: toolbox.toolDefinitions }));
          }
          break;

        case 'tools/call': {
          const toolName = String(params?.name ?? '');
          const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
          if (!toolName) {
            if (!isNotification) sendJson(output, jsonRpcError(id, -32602, 'Missing tool name'));
            break;
          }
          if (!toolbox.toolDefinitions.some((t) => t.name === toolName)) {
            if (!isNotification) sendJson(output, jsonRpcError(id, -32602, `Unknown tool: ${toolName}`));
            break;
          }

          await ensureOverlayBooted();

          const urgent = toolName === 'desktop_stop' || toolName === 'desktop_safety';
          const allowUnderEstop = isReadOnlyToolCall(toolName, toolArgs);
          const result = urgent
            ? await toolbox.executeTool(toolName, toolArgs)
            : await enqueueSerialized(() => toolbox.executeTool(toolName, toolArgs), { allowUnderEstop }).catch((err) => ({
                isError: true,
                content: [{ type: 'text', text: err?.message ?? String(err) }],
              }));

          if (!isNotification) sendJson(output, jsonRpcResult(id, result));
          break;
        }

        default:
          if (!isNotification) {
            sendJson(output, jsonRpcError(id, -32601, `Method not found: ${method}`));
          }
          break;
      }
    } catch (err) {
      logErr(`Internal error handling ${method}: ${err?.stack ?? err?.message ?? err}`);
      if (!isNotification) {
        sendJson(output, jsonRpcError(id, -32603, err?.message ?? 'Internal error'));
      }
    }
  }

  let rl = null;
  let shutdownPromise = null;

  function start() {
    rl = createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        sendJson(output, jsonRpcError(null, -32700, `Parse error: ${err?.message ?? err}`));
        return;
      }
      if (Array.isArray(parsed)) {
        for (const item of parsed) void handleJsonRpc(item);
      } else {
        void handleJsonRpc(parsed);
      }
    });

    const onInputEnd = () => {
      void shutdown().then(() => {
        if (options.exitOnEof !== false) process.exit(0);
      });
    };
    input.once('end', onInputEnd);
    input.once('close', onInputEnd);
    input.once('error', onInputEnd);

    if (options.autoBootOverlay === true) {
      void ensureOverlayBooted();
    }
  }

  async function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    disposed = true;
    shutdownPromise = (async () => {
      abortQueuedServerCalls('Server shutting down');
      try { rl?.close(); } catch { /* ignore */ }
      await Promise.allSettled([
        backend.dispose(),
        overlay ? overlay.shutdown() : Promise.resolve(),
        captureService.dispose(),
      ]);
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    })();
    return shutdownPromise;
  }

  return {
    start,
    shutdown,
    safety,
    overlay,
    backend,
    captureService,
    runDir,
    ensureOverlayBooted,
  };
}
