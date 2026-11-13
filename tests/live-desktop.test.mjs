import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createDesktopMcpServer } from '../src/server.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function frameStreamPair() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const pendingById = new Map();
  let buf = '';

  fromServer.setEncoding('utf8');
  fromServer.on('data', (chunk) => {
    buf += chunk;
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '').trim();
      buf = buf.slice(idx + 1);
      if (line) {
        const parsed = JSON.parse(line);
        if (parsed && parsed.id !== undefined && pendingById.has(parsed.id)) {
          const entry = pendingById.get(parsed.id);
          pendingById.delete(parsed.id);
          clearTimeout(entry.timer);
          entry.resolve(parsed);
        }
      }
      idx = buf.indexOf('\n');
    }
  });

  function send(msg) {
    toServer.write(`${JSON.stringify(msg)}\n`);
  }

  function rpc(id, method, params = {}, timeoutMs = 45_000) {
    return new Promise((resolveMsg, rejectMsg) => {
      const timer = setTimeout(() => {
        pendingById.delete(id);
        rejectMsg(new Error(`Timed out waiting for JSON-RPC reply id=${id} method=${method} (${timeoutMs} ms)`));
      }, timeoutMs);
      pendingById.set(id, { resolve: resolveMsg, reject: rejectMsg, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  return { toServer, fromServer, send, rpc };
}

function createChildJsonRpc(child) {
  const byId = new Map();
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '').trim();
      buf = buf.slice(idx + 1);
      if (line) {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && byId.has(msg.id)) {
          const entry = byId.get(msg.id);
          byId.delete(msg.id);
          clearTimeout(entry.timer);
          entry.resolve(msg);
        }
      }
      idx = buf.indexOf('\n');
    }
  });

  function call(id, method, params = {}, timeoutMs = 45_000) {
    return new Promise((resolveMsg, rejectMsg) => {
      const timer = setTimeout(() => {
        byId.delete(id);
        rejectMsg(new Error(`Child RPC ${method} timed out (${timeoutMs} ms). stderr=${stderr}`));
      }, timeoutMs);
      byId.set(id, { resolve: resolveMsg, reject: rejectMsg, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  return { call, getStderr: () => stderr };
}

function sampleProcessCpuMs(pids) {
  const valid = pids.filter((p) => Number.isFinite(p) && p > 0);
  if (valid.length === 0) return {};
  const ps = `
    $out = @{}
    foreach ($p in @(${valid.join(',')})) {
      try {
        $proc = Get-Process -Id $p -ErrorAction Stop
        $out["$p"] = [Math]::Round($proc.TotalProcessorTime.TotalMilliseconds, 2)
      } catch { }
    }
    $out | ConvertTo-Json -Compress
  `;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8' }).trim();
  return raw ? JSON.parse(raw) : {};
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a real Windows GUI WinForms application (`AgyLiveTarget`) on the current desktop
 * so `EnumWindows`, `PrintWindow`, and `CUIAutomation` run against genuine Win32 controls
 * even when running inside an isolated sandbox desktop (`exebox-...`).
 */
function launchTargetGuiApp(workDir) {
  const readyFile = join(workDir, 'target-ready.json');
  const scriptPath = join(workDir, 'target-gui.ps1');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'AgyLiveTargetWindow'
$form.Width = 460
$form.Height = 280
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(80, 80)
$form.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)

$clicks = 0
$label = New-Object System.Windows.Forms.Label
$label.Name = 'lblCounter'
$label.Text = 'Clicks: 0'
$label.Left = 24
$label.Top = 24
$label.Width = 380
$label.Height = 28

$textbox = New-Object System.Windows.Forms.TextBox
$textbox.Name = 'txtPayload'
$textbox.Text = 'InitialText'
$textbox.Left = 24
$textbox.Top = 64
$textbox.Width = 380
$textbox.Height = 28

$button = New-Object System.Windows.Forms.Button
$button.Name = 'btnIncrement'
$button.Text = 'IncrementCounter'
$button.Left = 24
$button.Top = 108
$button.Width = 180
$button.Height = 36
$button.BackColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
$button.ForeColor = [System.Drawing.Color]::White
$button.Add_Click({
  $script:clicks++
  $label.Text = "Clicks: $($script:clicks)"
})

$form.Controls.Add($label)
$form.Controls.Add($textbox)
$form.Controls.Add($button)

$form.Add_Shown({
  $payload = @{ pid = $PID; hwnd = [int64]$form.Handle; title = $form.Text } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($env:AGY_TARGET_READY_FILE, $payload, [System.Text.Encoding]::UTF8)
})

[System.Windows.Forms.Application]::Run($form)
`;
  writeFileSync(scriptPath, script, 'utf8');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    env: { ...process.env, AGY_TARGET_READY_FILE: readyFile },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  const ready = new Promise((resolveReady, rejectReady) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    const deadline = Date.now() + 15_000;
    const poll = setInterval(() => {
      if (child.exitCode !== null) {
        clearInterval(poll);
        rejectReady(new Error(`Target GUI exited prematurely (${child.exitCode}): ${stderr}`));
        return;
      }
      try {
        if (existsSync(readyFile)) {
          const raw = readFileSync(readyFile, 'utf8').replace(/^\uFEFF/, '').trim();
          if (raw) {
            clearInterval(poll);
            resolveReady(JSON.parse(raw));
            return;
          }
        }
      } catch { /* retry */ }
      if (Date.now() > deadline) {
        clearInterval(poll);
        rejectReady(new Error(`Timed out waiting for target GUI window: ${stderr}`));
      }
    }, 100);
  });

  return { child, ready };
}

test('Live E2E: overlay HUD protection, PrintWindow capture, UIA control, clipboard, whitelist ratchet, E-Stop <1.5s abort, and near-0% idle CPU', { timeout: 120_000 }, async (t) => {
  const runDir = join(tmpdir(), 'antigravity-desktop-mcp', `live-e2e-${process.pid}-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const { toServer, fromServer, rpc } = frameStreamPair();
  const server = createDesktopMcpServer({
    input: toServer,
    output: fromServer,
    runDir,
    enableOverlay: true,
    allowIpcResume: true,
    safetyConfigPath: join(runDir, 'safety.json'),
    autoBootOverlay: true,
    exitOnEof: false,
  });

  let guiProc = null;
  let originalClipboard = '';
  let hadSavedClipboard = false;

  try {
    await server.start();
    const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'antigravity-desktop-mcp');

    // Save existing user text clipboard best-effort before test
    const preClipRes = await rpc(2, 'tools/call', { name: 'desktop_clipboard', arguments: { op: 'get' } });
    if (!preClipRes.result.isError) {
      const parsed = JSON.parse(preClipRes.result.content[0].text);
      if (typeof parsed.text === 'string') {
        originalClipboard = parsed.text;
        hadSavedClipboard = true;
      }
    }

    // 1. Verify overlay HUD live flags & bounds
    const safetyRes = await rpc(3, 'tools/call', { name: 'desktop_safety', arguments: { action: 'status' } });
    assert.notEqual(safetyRes.result.isError, true, safetyRes.result.content?.[0]?.text);
    const safetyJson = JSON.parse(safetyRes.result.content[0].text);
    assert.equal(safetyJson.overlay.alive, true, 'EStopOverlay.exe must be alive');
    assert.equal(safetyJson.overlay.visualReady, true, 'HUD form must be visible');
    assert.equal(safetyJson.overlay.excludeFromCapture, true, 'WDA_EXCLUDEFROMCAPTURE must be active');
    assert.equal(safetyJson.overlay.hookInstalled, true, 'Global WH_KEYBOARD_LL hook must be installed');
    assert.equal(safetyJson.overlay.hotkeyRegistered, true, 'Ctrl+Alt+Pause hotkey must be registered');
    const hudBounds = safetyJson.hud.bounds;
    assert.ok(hudBounds.width >= 200 && hudBounds.height >= 24);

    // 2. Verify HUD bounds & HWND cannot be clicked, focused, or UI-inspected
    const hudCenterX = Math.round(hudBounds.x + hudBounds.width / 2);
    const hudCenterY = Math.round(hudBounds.y + hudBounds.height / 2);
    const hudClickRes = await rpc(4, 'tools/call', {
      name: 'desktop_click',
      arguments: { x: hudCenterX, y: hudCenterY },
    });
    assert.equal(hudClickRes.result.isError, true);
    assert.match(hudClickRes.result.content[0].text, /PROTECTED_HUD_TARGET/);

    const hudFocusRes = await rpc(5, 'tools/call', {
      name: 'desktop_windows',
      arguments: { focus_hwnd: safetyJson.hud.hwnd },
    });
    assert.equal(hudFocusRes.result.isError, true);
    assert.match(hudFocusRes.result.content[0].text, /PROTECTED_HUD_TARGET/);

    const hudUiRes = await rpc(6, 'tools/call', {
      name: 'desktop_ui',
      arguments: { hwnd: safetyJson.hud.hwnd },
    });
    assert.equal(hudUiRes.result.isError, true);
    assert.match(hudUiRes.result.content[0].text, /PROTECTED_HUD_TARGET/);

    // 3. Launch real WinForms GUI window, verify window enumeration (HUD excluded), PrintWindow capture, and UIA control
    const gui = launchTargetGuiApp(runDir);
    guiProc = gui.child;
    const guiInfo = await gui.ready;
    const targetHwnd = Number(guiInfo.hwnd);
    assert.ok(targetHwnd > 0);

    const winListRes = await rpc(7, 'tools/call', {
      name: 'desktop_windows',
      arguments: { filter: 'AgyLiveTargetWindow' },
    });
    assert.notEqual(winListRes.result.isError, true, winListRes.result.content?.[0]?.text);
    const winListText = winListRes.result.content[0].text;
    assert.match(winListText, new RegExp(`hwnd=${targetHwnd}`));
    assert.ok(!winListText.includes(`hwnd=${safetyJson.hud.hwnd}`), 'EStop HUD HWND must never appear in desktop_windows');

    // Window screenshot via PrintWindow (renders window's own pixels cleanly)
    const winShotRes = await rpc(8, 'tools/call', {
      name: 'desktop_screenshot',
      arguments: { window: targetHwnd, format: 'png', settle_ms: 80 },
    });
    assert.notEqual(winShotRes.result.isError, true, `Window screenshot error: ${winShotRes.result.content?.[0]?.text}`);
    const pngImg = winShotRes.result.content.find((c) => c.type === 'image');
    assert.ok(pngImg?.data && pngImg.mimeType === 'image/png', 'Window screenshot must deliver real PNG');
    const pngHeader = Buffer.from(pngImg.data, 'base64').subarray(0, 4);
    assert.deepEqual([...pngHeader], [0x89, 0x50, 0x4e, 0x47], 'Delivered screenshot bytes must start with PNG magic');
    const envText = winShotRes.result.content.find((c) => c.type === 'text')?.text ?? '';
    assert.match(envText, /frame:\s*f\d+/i);

    // Inspect real COM UI Automation tree and verify refs exist for Button & Edit
    const uiRes = await rpc(9, 'tools/call', {
      name: 'desktop_ui',
      arguments: { hwnd: targetHwnd, max_depth: 5, max_nodes: 80 },
    });
    assert.notEqual(uiRes.result.isError, true, uiRes.result.content?.[0]?.text);
    const uiText = uiRes.result.content[0].text;
    assert.match(uiText, /IncrementCounter/);
    const btnRefMatch = uiText.match(/\[(s\d+\.\d+)\][^\n]*IncrementCounter/);
    const editRefMatch = uiText.match(/\[(s\d+\.\d+)\][^\n]*Edit/i);
    assert.ok(btnRefMatch, `Expected IncrementCounter ref in desktop_ui:\n${uiText}`);
    assert.ok(editRefMatch, `Expected Edit TextBox ref in desktop_ui:\n${uiText}`);
    const btnRef = btnRefMatch[1];
    const editRef = editRefMatch[1];

    // Invoke button & set_value/get_value via UIA refs
    const invokeRes = await rpc(10, 'tools/call', {
      name: 'desktop_ui_action',
      arguments: { action: 'invoke', ref: btnRef },
    });
    assert.notEqual(invokeRes.result.isError, true, invokeRes.result.content?.[0]?.text);

    const setValRes = await rpc(11, 'tools/call', {
      name: 'desktop_ui_action',
      arguments: { action: 'set_value', ref: editRef, value: 'Hello_Antigravity_中文校验' },
    });
    assert.notEqual(setValRes.result.isError, true, setValRes.result.content?.[0]?.text);

    const getValRes = await rpc(12, 'tools/call', {
      name: 'desktop_ui_action',
      arguments: { action: 'get_value', ref: editRef },
    });
    assert.notEqual(getValRes.result.isError, true, getValRes.result.content?.[0]?.text);
    assert.match(getValRes.result.content[0].text, /Hello_Antigravity_中文校验/);

    // Batch actions: invoke button again, wait, get_value, capture_after='final' on target window
    const batchRes = await rpc(13, 'tools/call', {
      name: 'desktop_actions',
      arguments: {
        steps: [
          { action: 'invoke', hwnd: targetHwnd, name: 'IncrementCounter' },
          { action: 'wait', seconds: 0.1 },
        ],
        capture_after: 'final',
        window: targetHwnd,
        format: 'png',
      },
    });
    assert.notEqual(batchRes.result.isError, true, batchRes.result.content?.find((c) => c.type === 'text')?.text);
    assert.ok(batchRes.result.content.some((c) => c.type === 'image'));

    // Verify Clicks counter reached 2 in live WinForms Label via UIA
    const uiAfterRes = await rpc(14, 'tools/call', {
      name: 'desktop_ui',
      arguments: { hwnd: targetHwnd, max_depth: 5, max_nodes: 80 },
    });
    assert.match(uiAfterRes.result.content[0].text, /Clicks:\s*2/);

    // Clipboard real round-trip test
    const setClip = await rpc(15, 'tools/call', { name: 'desktop_clipboard', arguments: { op: 'set', text: 'AgyClipboard_中文_123' } });
    assert.notEqual(setClip.result.isError, true, setClip.result.content?.[0]?.text);
    const getClip = JSON.parse((await rpc(16, 'tools/call', { name: 'desktop_clipboard', arguments: { op: 'get' } })).result.content[0].text);
    assert.equal(getClip.text, 'AgyClipboard_中文_123');

    // 4. Window Whitelist Lock & Ratchet Enforcement
    const lockRes = await rpc(17, 'tools/call', {
      name: 'desktop_safety',
      arguments: { action: 'lock_whitelist', process: 'powershell', title_contains: 'AgyLiveTargetWindow' },
    });
    assert.notEqual(lockRes.result.isError, true, lockRes.result.content?.[0]?.text);
    const lockJson = JSON.parse(lockRes.result.content[0].text);
    assert.equal(lockJson.whitelistEnabled, true);
    assert.equal(lockJson.whitelistLocked, true);

    const widenAttempt = await rpc(18, 'tools/call', {
      name: 'desktop_safety',
      arguments: { action: 'lock_whitelist', process: 'calc' },
    });
    assert.equal(widenAttempt.result.isError, true);
    assert.match(widenAttempt.result.content[0].text, /WHITELIST_LOCKED/);

    const osKeyAttempt = await rpc(19, 'tools/call', {
      name: 'desktop_key',
      arguments: { keys: 'win+r' },
    });
    assert.equal(osKeyAttempt.result.isError, true);
    assert.match(osKeyAttempt.result.content[0].text, /WHITELIST_OS_SHORTCUT_BLOCKED/);

    const blockedLaunch = await rpc(20, 'tools/call', {
      name: 'desktop_launch',
      arguments: { target: 'cmd.exe' },
    });
    assert.equal(blockedLaunch.result.isError, true);
    assert.match(blockedLaunch.result.content[0].text, /WINDOW_NOT_WHITELISTED/);

    // Whitelisted target action still works, and tightening to exact hwnd works
    const allowedInvoke = await rpc(21, 'tools/call', {
      name: 'desktop_ui_action',
      arguments: { action: 'invoke', hwnd: targetHwnd, name: 'IncrementCounter' },
    });
    assert.notEqual(allowedInvoke.result.isError, true, allowedInvoke.result.content?.[0]?.text);

    const tightenRes = await rpc(22, 'tools/call', {
      name: 'desktop_safety',
      arguments: { action: 'tighten_whitelist', rules: [{ process: 'powershell', title_contains: 'AgyLiveTargetWindow', hwnd: targetHwnd }] },
    });
    assert.notEqual(tightenRes.result.isError, true, tightenRes.result.content?.[0]?.text);

    // 5. Real Overlay E-Stop Interruption (<1.5s latency) + Queue Drop + IPC Resume
    const t0 = performance.now();
    const longWaitPromise = rpc(23, 'tools/call', {
      name: 'desktop_actions',
      arguments: {
        steps: [
          { action: 'wait', seconds: 6 },
          { action: 'invoke', hwnd: targetHwnd, name: 'IncrementCounter' },
        ],
        capture_after: false,
      },
    });
    const queuedPromise = rpc(24, 'tools/call', {
      name: 'desktop_ui_action',
      arguments: { action: 'invoke', hwnd: targetHwnd, name: 'IncrementCounter' },
    });

    await new Promise((r) => setTimeout(r, 350));
    await server.overlay.call('estop', { detail: 'Automated E2E E-Stop test' });

    const [longRes, queuedRes] = await Promise.all([longWaitPromise, queuedPromise]);
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 2500, `Expected E-Stop to abort 6s wait quickly, took ${Math.round(elapsedMs)} ms`);
    assert.equal(longRes.result.isError, true);
    assert.match(longRes.result.content[0].text, /USER_ABORTED|ESTOP_ACTIVE/);
    assert.equal(queuedRes.result.isError, true);
    assert.match(queuedRes.result.content[0].text, /USER_ABORTED|ESTOP_ACTIVE/);

    // Latched state refuses mutating UI action
    const postEstop = await rpc(25, 'tools/call', {
      name: 'desktop_ui_action',
      arguments: { action: 'invoke', hwnd: targetHwnd, name: 'IncrementCounter' },
    });
    assert.equal(postEstop.result.isError, true);
    assert.match(postEstop.result.content[0].text, /ESTOP_ACTIVE/);

    // Verify counter remained 3 (post-abort invoke step and queued invoke never ran)
    const uiCheckAborted = await rpc(26, 'tools/call', {
      name: 'desktop_ui',
      arguments: { hwnd: targetHwnd, max_depth: 5, max_nodes: 80 },
    });
    assert.match(uiCheckAborted.result.content[0].text, /Clicks:\s*3/);

    // Clear E-Stop via overlay UI resume (`testResume` simulates clicking HUD RESUME button)
    await server.overlay.call('testResume');
    await new Promise((r) => setTimeout(r, 150));
    const resumedStatus = JSON.parse((await rpc(27, 'tools/call', { name: 'desktop_safety', arguments: { action: 'status' } })).result.content[0].text);
    assert.equal(resumedStatus.estopLatched, false);

    // 6. Measure idle CPU time across 2.5 seconds of complete inactivity
    const overlayPid = Number(server.overlay.pid ?? 0);
    const workerPid = Number(server.backend.info?.pid ?? 0);
    assert.ok(overlayPid > 0 && workerPid > 0, 'Both overlayPid and workerPid must be running for idle CPU check');

    const cpuBefore = sampleProcessCpuMs([overlayPid, workerPid]);
    await new Promise((r) => setTimeout(r, 2500));
    const cpuAfter = sampleProcessCpuMs([overlayPid, workerPid]);
    const deltaOverlay = Math.max(0, (cpuAfter[String(overlayPid)] ?? 0) - (cpuBefore[String(overlayPid)] ?? 0));
    const deltaWorker = Math.max(0, (cpuAfter[String(workerPid)] ?? 0) - (cpuBefore[String(workerPid)] ?? 0));
    const totalCpuPct = ((deltaOverlay + deltaWorker) / 2500) * 100;
    t.diagnostic(`Idle CPU 2500ms: overlay=${deltaOverlay.toFixed(1)}ms worker=${deltaWorker.toFixed(1)}ms (${totalCpuPct.toFixed(2)}% of 1 core); E-Stop abort elapsed=${Math.round(elapsedMs)}ms`);
    assert.ok(totalCpuPct < 3.0, `Expected low idle CPU (<3%), got ${totalCpuPct.toFixed(2)}% (overlay=${deltaOverlay}ms, worker=${deltaWorker}ms)`);
  } finally {
    if (hadSavedClipboard) {
      await rpc(901, 'tools/call', { name: 'desktop_clipboard', arguments: { op: 'set', text: originalClipboard } }).catch(() => { /* ignore */ });
    }
    await server.shutdown().catch(() => { /* ignore */ });
    if (guiProc && guiProc.pid) {
      try { execFileSync('taskkill', ['/PID', String(guiProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('Live Child Process Stdio Smoke: production entrypoint cleans up child processes on EOF', { timeout: 60_000 }, async () => {
  const runDir = join(tmpdir(), 'antigravity-desktop-mcp', `live-proc-${process.pid}-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'antigravity-desktop-mcp.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGY_DESKTOP_RUN_DIR: runDir,
      AGY_DESKTOP_SAFETY_CONFIG: join(runDir, 'safety.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let overlayPid = 0;

  try {
    const client = createChildJsonRpc(child);
    const init = await client.call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'antigravity-desktop-mcp');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const list = await client.call(2, 'tools/list');
    assert.equal(list.result.tools.length, 16);

    const win = await client.call(3, 'tools/call', { name: 'desktop_windows', arguments: {} });
    assert.notEqual(win.result.isError, true);

    const status = await client.call(4, 'tools/call', { name: 'desktop_safety', arguments: { action: 'status' } });
    assert.notEqual(status.result.isError, true);
    const statusJson = JSON.parse(status.result.content[0].text);
    assert.equal(statusJson.overlay.alive, true);
    assert.equal(statusJson.backend.alive, true);
    overlayPid = Number(statusJson.hud?.pid ?? 0);

    const psFind = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${child.pid}" | Select-Object ProcessId,Name | ConvertTo-Json -Compress`;
    const procsRaw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psFind], { encoding: 'utf8' }).trim();
    const childProcs = procsRaw ? (JSON.parse(procsRaw) instanceof Array ? JSON.parse(procsRaw) : [JSON.parse(procsRaw)]) : [];
    const childPids = childProcs.map((p) => Number(p.ProcessId)).filter((n) => n > 0);
    assert.ok(childPids.length >= 2, `Expected EStopOverlay + PowerShell worker children, got: ${procsRaw}`);

    const exitPromise = new Promise((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    child.stdin.end();
    const exitInfo = await Promise.race([
      exitPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Production server did not exit on EOF within 10s')), 10_000)),
    ]);
    assert.equal(exitInfo.code, 0, `Expected exit code 0, got ${JSON.stringify(exitInfo)}; stderr=${client.getStderr()}`);

    await new Promise((r) => setTimeout(r, 400));
    for (const cpid of [...childPids, ...(overlayPid > 0 ? [overlayPid] : [])]) {
      assert.equal(isPidAlive(cpid), false, `Child process PID ${cpid} leaked after server EOF!`);
    }
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    rmSync(runDir, { recursive: true, force: true });
  }
});
