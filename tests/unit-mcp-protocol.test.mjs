import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopMcpServer } from '../src/server.js';
import { SafetyController } from '../src/safety.js';

function createFakeBackend(behavior = {}) {
  const calls = [];
  let aborted = false;
  let releasePending = null;
  return {
    calls,
    info: { generation: 1 },
    alive: true,
    state: 'ready',
    outstanding: 0,
    stats: { requests: 0 },
    lastRelease: null,
    lastStopReport: null,
    async call(cmd, args) {
      calls.push({ cmd, args });
      if (behavior.slowCmd === cmd) {
        return new Promise((resolve, reject) => {
          releasePending = { resolve, reject };
        });
      }
      if (cmd === 'windows') return { windows: [{ hwnd: 101, pid: 202, process: 'notepad', title: 'Test', x: 0, y: 0, width: 400, height: 300 }] };
      if (cmd === 'click') return { x: args.x, y: args.y, clicks: 1, button: 'left' };
      return { ok: true };
    },
    async abortAll({ reason, userAborted } = {}) {
      aborted = true;
      if (releasePending) {
        const err = new Error(`[USER_ABORTED] ${reason}`);
        err.canceled = true;
        err.userAborted = userAborted;
        releasePending.reject(err);
        releasePending = null;
      }
      return { ok: true, userAborted, cancelledCount: 1, hadInFlight: true, releaseConfirmed: true, released: [] };
    },
    async syncSafetyConfig() { return { synced: true }; },
    async dispose() { aborted = true; },
    get aborted() { return aborted; },
  };
}

function makeRpcHarness(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const dir = mkdtempSync(join(tmpdir(), 'agy-mcp-unit-'));
  const safety = new SafetyController({ configPath: join(dir, 'safety.json'), loadFromDisk: false });
  const backend = options.backend ?? createFakeBackend();
  const server = createDesktopMcpServer({
    input,
    output,
    runDir: dir,
    safety,
    backend,
    enableOverlay: false,
    exitOnEof: false,
  });

  const pending = new Map();
  const rl = createInterface({ input: output });
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      entry.resolve(msg);
    }
  });

  let nextId = 1;
  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC timeout for ${method}`)), 5_000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
      });
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  server.start();
  return {
    send,
    safety,
    backend,
    async close() {
      rl.close();
      await server.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('MCP initialize, tools/list, ping, and desktop_safety work over stdio JSON-RPC 2.0', async () => {
  const h = makeRpcHarness();
  try {
    const init = await h.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'antigravity-desktop-mcp');

    const listed = await h.send('tools/list');
    const names = listed.result.tools.map((t) => t.name);
    for (const expected of [
      'desktop_screenshot', 'desktop_actions', 'desktop_click', 'desktop_move',
      'desktop_drag', 'desktop_scroll', 'desktop_type', 'desktop_key',
      'desktop_windows', 'desktop_ui', 'desktop_ui_action', 'desktop_clipboard',
      'desktop_paste', 'desktop_launch', 'desktop_stop', 'desktop_safety',
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    const ping = await h.send('ping');
    assert.deepEqual(ping.result, {});

    const safetyResp = await h.send('tools/call', { name: 'desktop_safety', arguments: { action: 'status' } });
    assert.equal(safetyResp.result.isError, undefined);
    const parsed = JSON.parse(safetyResp.result.content[0].text);
    assert.equal(parsed.estopLatched, false);
    assert.equal(parsed.whitelistEnabled, false);
  } finally {
    await h.close();
  }
});

test('desktop_stop bypasses serialized queue, aborts in-flight & queued calls, and latches E-Stop when requested', async () => {
  const backend = createFakeBackend({ slowCmd: 'click' });
  const h = makeRpcHarness({ backend });
  try {
    await h.send('initialize', { protocolVersion: '2025-06-18' });

    // Launch a slow in-flight click + a second queued type
    const slowClick = h.send('tools/call', { name: 'desktop_click', arguments: { x: 20, y: 20 } });
    const queuedType = h.send('tools/call', { name: 'desktop_type', arguments: { text: 'should never run' } });

    // Wait a tick so slowClick reaches backend.call('click')
    await new Promise((r) => setTimeout(r, 30));

    // desktop_stop MUST run immediately without waiting behind slowClick
    const stopRes = await h.send('tools/call', {
      name: 'desktop_stop',
      arguments: { reason: 'Emergency test abort', latch: true },
    });
    const stopJson = JSON.parse(stopRes.result.content[0].text);
    assert.equal(stopJson.aborted, true);
    assert.equal(stopJson.estopLatched, true);
    assert.equal(stopJson.releaseConfirmed, true);

    const [clickRes, typeRes] = await Promise.all([slowClick, queuedType]);
    assert.equal(clickRes.result.isError, true);
    assert.match(clickRes.result.content[0].text, /USER_ABORTED/);
    assert.equal(typeRes.result.isError, true);
    assert.match(typeRes.result.content[0].text, /USER_ABORTED/);
    // Crucially, 'type' never reached the fake backend!
    assert.equal(backend.calls.some((c) => c.cmd === 'type'), false);

    // Subsequent mutating tool calls fail immediately with [ESTOP_ACTIVE]
    const blockedClick = await h.send('tools/call', { name: 'desktop_click', arguments: { x: 50, y: 50 } });
    assert.equal(blockedClick.result.isError, true);
    assert.match(blockedClick.result.content[0].text, /ESTOP_ACTIVE/);
  } finally {
    await h.close();
  }
});
