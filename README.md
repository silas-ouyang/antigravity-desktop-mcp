# Antigravity Desktop MCP (`antigravity-desktop-mcp`)

A local stdio Model Context Protocol (MCP) server for Windows 10/11 general desktop automation, adapted from the MIT-licensed [`LJL454/dsh-computer-use`](https://github.com/LJL454/dsh-computer-use) project for **Google Antigravity**.

Built with universal desktop control (screenshots, region/window capture, mouse/keyboard input, clipboard, Win32 window enumeration/focus, COM UI Automation, multi-step batching) **plus** an always-on-top physical E-Stop overlay HUD, global interrupt hotkeys, anti-capture exclusion, strict HUD self-protection, monotonic window whitelist ratcheting, and event-driven ~0% idle CPU architecture.

---

## Key Capabilities & Architecture

### 1. 16 Standard MCP Tools (stdio JSON-RPC 2.0)

| Tool | Category | Purpose |
| :--- | :--- | :--- |
| `desktop_screenshot` | Vision | Full display / virtual desktop / screen region / specific window (`PrintWindow`) / owned popup bundle capture, returning inline base64 PNG/JPEG + physical-pixel metadata & `frame_id`. |
| `desktop_actions` | Batch | Up to 50 sequential steps (`click`, `move`, `drag`, `scroll`, `type`, `paste`, `key`, `clipboard`, `focus`, `launch`, `wait`, `wait_for`, `screenshot`, `state`, UIA actions) in one round trip with shared deadline and window-change stop guards. |
| `desktop_click` | Mouse | Absolute or `from_frame`-projected click (`left`/`right`/`middle`, 1–3 clicks, modifiers) with pre-landing content & occlusion verification. |
| `desktop_move` | Mouse | Absolute, `from_frame`-projected, or relative (`dx`/`dy`) cursor movement. |
| `desktop_drag` | Mouse | Smooth multi-point `path` or point-to-point drag, or `from_last` continuation. |
| `desktop_scroll` | Mouse | Vertical or horizontal scroll at cursor or target coordinates. |
| `desktop_type` | Keyboard | Unicode typing via `SendInput` (`KEYEVENTF_UNICODE`) with optional `into_hwnd` foreground guard. |
| `desktop_key` | Keyboard | Single keys, chords (`ctrl+s`, `alt+f4`), repeats, or held keys (`hold_ms`). |
| `desktop_windows` | Windowing | Enumerate visible/minimized top-level windows (HUD automatically filtered out) or bring `focus_hwnd` to foreground. |
| `desktop_ui` | Accessibility | Native COM `CUIAutomation8` tree snapshot with compact `[s#.#]` control refs, delta diffing, and document/selection text observation. |
| `desktop_ui_action` | Accessibility | Invoke, `set_value`, `get_value`, `get_text`, `select_text`, `toggle`, `select`, `expand`, `collapse`, `scroll_into_view`, `minimize`/`maximize`/`restore`/`close`, `click_text`, `locate_text`. |
| `desktop_clipboard` | Clipboard | `get`, `set`, or `clear` Windows text clipboard. |
| `desktop_paste` | Clipboard | Reliable long/CJK text insertion via clipboard + `Ctrl+V` with automatic save/restore (`require_restore` option). |
| `desktop_launch` | Launch | Launch `.exe`, PATH commands, Start Menu display names, URLs, or UWP Store apps cleanly. |
| `desktop_stop` | Safety | **Urgent queue-bypass** abort: halts running & queued calls, terminates hung PowerShell workers via 6-step shutdown, and runs independent `release-input.ps1` cleanup. |
| `desktop_safety` | Safety | Inspect E-Stop/overlay/backend health (`status`), or enable/tighten the window whitelist (`lock_whitelist` / `tighten_whitelist`). |

---

### 2. High-Reliability E-Stop & Operational Safety

1. **Always-On-Top Floating HUD ([`EStopOverlay.cs`](native/EStopOverlay.cs))**:
   - Compiled to `bin/EStopOverlay.exe` (.NET 4 WinForms, Per-Monitor V2 DPI aware, `WS_EX_NOACTIVATE` + `WS_EX_TOPMOST`).
   - Features a draggable status badge (`待机` / `护航中` / `AI执行中` / `已急停`), prominent red **`STOP 急停`** button, user-only **`恢复 RESUME`** button, right-click configuration menu (`Esc` mode, whitelist unlock/clear, reposition), and capture-exclusion badge.
   - Marked with **`WDA_EXCLUDEFROMCAPTURE` (`0x11`)** at Win32 level so hardware/DWM screen captures do not see the overlay pixels (with automatic reference-counted `suspendVisual`/`resumeVisual` fallback if unsupported).

2. **Three-Layer Instant Abort (`< 1 ms` wake-up + Clean Input Unwind)**:
   - **Global Low-Level Keyboard Hook (`WH_KEYBOARD_LL`)**: Captures real hardware keystrokes while strictly ignoring synthetic AI inputs (`LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED`) so `AI`-typed `Esc` or hotkeys cannot self-trigger.
   - **`Esc` Auto-Arming**: In default `auto` mode, `Esc` is armed whenever AI mutating steps execute and stays armed for a brief cooldown (`1800ms`) afterward (configurable in UI to `always` or `disabled`).
   - **Dedicated `RegisterHotKey`**: `Ctrl + Alt + Pause` works globally at all times (configurable to `Ctrl+Alt+Backspace` or `Ctrl+Shift+Esc` safe alternatives).
   - **Kernel Named `EventWaitHandle` (`Local\AgyDesktopCancel_<pid>`) + Cancel Flag**: Immediately wakes blocked `Wait-Cancellable` loops inside PowerShell without waiting for poll intervals or `Wait-Condition` timeouts, aborts queued MCP requests cleanly (`[USER_ABORTED]`), and if any Win32/UIA call refuses to unwind within budget, kills the worker process and runs standalone `backend/release-input.ps1` to release any held modifier/mouse keys.

3. **Un-Bypassable Safety Ratchets**:
   - **E-Stop Latch**: Once triggered by hardware hotkey or physical STOP click, all mutating MCP tools return `[ESTOP_ACTIVE]` until the **user** physically clicks `恢复 RESUME` on the floating HUD. MCP tools cannot clear an E-Stop.
   - **Protected HUD Target**: Coordinates inside `hud.bounds`, the HUD `hwnd`, and the overlay PID are blocked in Node and PowerShell (`[PROTECTED_HUD_TARGET]`).
   - **Monotonic Window Whitelist**: User or `desktop_safety(lock_whitelist)` can restrict operations to specific processes / title substrings / HWNDs (e.g., TIA Portal, Factory I/O, or Notepad). Once locked, AI can only `tighten_whitelist` — disabling or widening returns `[WHITELIST_LOCKED]`. Under whitelist mode, OS escape chords (`win+*`, `alt+tab`, `alt+esc`, `ctrl+esc`, `ctrl+shift+esc`, `win`) are rejected (`[WHITELIST_OS_SHORTCUT_BLOCKED]`).

4. **Near-Zero Idle CPU (Zero Busy-Polling)**:
   - Node MCP server awaits blocking `readline`/stream events.
   - `EStopOverlay.exe` runs a native Win32 `Application.Run()` message pump.
   - `backend/worker.ps1` blocks on `$stdin.ReadLine()` between calls and uses `EventWaitHandle.WaitOne(sliceMs)` inside waits.

---

## Project Layout

```text
antigravity-desktop-mcp/
├── bin/
│   ├── antigravity-desktop-mcp.js   # Production stdio MCP entrypoint
│   └── EStopOverlay.exe             # Compiled Win32 floating E-Stop overlay & hotkey daemon
├── native/
│   └── EStopOverlay.cs              # C# source for physical HUD, WH_KEYBOARD_LL, RegisterHotKey, WDA_EXCLUDEFROMCAPTURE
├── backend/
│   ├── worker.ps1                   # Deterministic modular loader generated by scripts/build-worker.mjs
│   ├── release-input.ps1            # Independent held-key/mouse recovery script
│   └── parts/                       # Modular PowerShell worker slices (00-preamble .. 13-main-loop)
├── src/
│   ├── server.js                    # JSON-RPC 2.0 stdio transport + urgent bypass lane for desktop_stop / desktop_safety
│   ├── tools.js                     # 16 MCP tool schemas and execution handlers
│   ├── safety.js                    # E-Stop latch, HUD target guard, monotonic whitelist controller
│   ├── overlay-supervisor.js        # Supervises EStopOverlay.exe IPC lifecycle
│   ├── capture-service.js           # Magic-byte verified PNG/JPEG delivery, ring buffer cleanup, coordinate envelopes
│   ├── backend/                     # PowerShellBackend & 6-step Generation lifecycle supervisor
│   └── internal/                    # Core contracts ported & extended from dsh-computer-use
├── scripts/
│   ├── build-native.mjs             # Compiles native/EStopOverlay.cs via .NET 4 csc.exe
│   ├── build-worker.mjs             # Generates deterministic backend/worker.ps1 loader + SHA-256 manifest (--check supported)
│   └── doctor.mjs                   # Live environment + overlay + worker health check
└── tests/
    ├── unit-*.test.mjs              # Fast offline unit tests (protocol, safety ratchet, worker build)
    └── live-desktop.test.mjs        # Live Windows end-to-end verification tests
```

---

## Commands

```powershell
npm run build         # Regenerate backend/worker.ps1 + compile bin/EStopOverlay.exe if needed
npm run check:worker  # Verify backend/worker.ps1 matches backend/parts/*.ps1 hashes
npm run doctor        # Spawn overlay + worker cleanly and output JSON health report
npm test              # Run offline unit tests
npm run test:live     # Run live Windows tests (overlay, UIA, PrintWindow, whitelist, E-Stop, stdio cleanup)
```

---

## Antigravity Global MCP Configuration (`%USERPROFILE%\.gemini\config\mcp_config.json`)

```json
{
  "mcpServers": {
    "desktop": {
      "command": "node",
      "args": [
        "C:\\path\\to\\antigravity-desktop-mcp\\bin\\antigravity-desktop-mcp.js"
      ],
      "env": {
        "AGY_DESKTOP_UI_ENGINE": "com"
      }
    }
  }
}
```

> **Note**: In `production` mode (`bin/antigravity-desktop-mcp.js`), `--allow-ipc-resume` is disabled by default so an E-Stop latch can **only** be cleared by physically clicking **`恢复 RESUME`** on the floating overlay HUD.
