// Antigravity Desktop MCP - Native E-Stop & Safety Overlay HUD
// Target: .NET Framework 4.x (C# 5 compatible for built-in Windows csc.exe)
// Features:
//  - Always-on-top non-focus-stealing HUD bar (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)
//  - WDA_EXCLUDEFROMCAPTURE (0x11) so screenshots never see the overlay
//  - WH_KEYBOARD_LL global hotkey hook (ignores LLKHF_INJECTED synthetic keys!)
//  - RegisterHotKey secondary fallback for global combo hotkey across IL boundaries
//  - Win32 Named ManualResetEvent (SetEvent in microseconds inside hook) + cancel.flag + stdout JSON event
//  - Interactive Window Whitelist & Hotkey configuration popup
//  - Zero idle polling (blocks in GetMessage / stdin ReadLine / kernel Process.Exited)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace AntigravityDesktopMcp
{
    public static class NativeMethods
    {
        public const int WH_KEYBOARD_LL = 13;
        public const int WM_KEYDOWN = 0x0100;
        public const int WM_SYSKEYDOWN = 0x0104;
        public const int WM_HOTKEY = 0x0312;
        public const int WM_MOUSEACTIVATE = 0x0021;
        public const int MA_NOACTIVATE = 3;
        public const int WM_NCLBUTTONDOWN = 0x00A1;
        public const int HTCAPTION = 2;
        public const int WM_APP = 0x8000;
        public const int WM_APP_ESTOP = WM_APP + 101;

        public const int LLKHF_INJECTED = 0x10;
        public const int LLKHF_LOWER_IL_INJECTED = 0x02;

        public const int WS_EX_TOPMOST = 0x00000008;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_NOACTIVATE = 0x08000000;

        public const uint WDA_NONE = 0x00000000;
        public const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;

        public const int SW_HIDE = 0;
        public const int SW_SHOWNOACTIVATE = 4;

        public const uint MOD_ALT = 0x0001;
        public const uint MOD_CONTROL = 0x0002;
        public const uint MOD_SHIFT = 0x0004;
        public const uint MOD_NOREPEAT = 0x4000;

        public const int GWL_EXSTYLE = -20;
        public const int DWMWA_CLOAKED = 14;

        public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint pdwAffinity);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool PostMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

        [DllImport("shcore.dll")]
        public static extern int SetProcessDpiAwareness(int value);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int GetWindowLongW(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int dwAttribute, ref int pvAttribute, int cbAttribute);

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

        [DllImport("shcore.dll")]
        public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

        public static void EnablePerMonitorV2Dpi()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
            try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }
            try { SetProcessDPIAware(); } catch { }
        }

        public static float GetDpiScaleAtPoint(Point pt)
        {
            try
            {
                POINT p = new POINT { X = pt.X, Y = pt.Y };
                IntPtr mon = MonitorFromPoint(p, 2 /* MONITOR_DEFAULTTONEAREST */);
                if (mon != IntPtr.Zero)
                {
                    uint dx, dy;
                    if (GetDpiForMonitor(mon, 0 /* MDT_EFFECTIVE_DPI */, out dx, out dy) == 0 && dx >= 96)
                    {
                        return Math.Max(1.0f, Math.Min(4.0f, dx / 96.0f));
                    }
                }
            }
            catch { }
            try
            {
                using (Graphics g = Graphics.FromHwnd(IntPtr.Zero))
                {
                    return Math.Max(1.0f, Math.Min(4.0f, g.DpiX / 96.0f));
                }
            }
            catch
            {
                return 1.0f;
            }
        }

        public static void EnableDarkTitleBar(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            try
            {
                int useDark = 1;
                if (DwmSetWindowAttribute(hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref useDark, 4) != 0)
                {
                    DwmSetWindowAttribute(hwnd, 19 /* Win10 pre-20H1 fallback */, ref useDark, 4);
                }
            }
            catch { }
        }

        public static bool IsCloaked(IntPtr hWnd)
        {
            try
            {
                int cloaked = 0;
                if (DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, 4) != 0) return false;
                return cloaked != 0;
            }
            catch { return false; }
        }

        public static bool IsToolWindow(IntPtr hWnd)
        {
            try
            {
                int ex = GetWindowLongW(hWnd, GWL_EXSTYLE);
                return (ex & (0x00040000 | WS_EX_TOOLWINDOW)) == WS_EX_TOOLWINDOW;
            }
            catch { return false; }
        }

        public static string GetWindowTitle(IntPtr hWnd)
        {
            StringBuilder sb = new StringBuilder(512);
            GetWindowTextW(hWnd, sb, sb.Capacity);
            return sb.ToString();
        }
    }

    public class WhitelistRule
    {
        public string process { get; set; }
        public string titleContains { get; set; }
        public long hwnd { get; set; }

        public string DisplayLabel()
        {
            List<string> parts = new List<string>();
            if (!string.IsNullOrEmpty(process)) parts.Add("proc=" + process);
            if (!string.IsNullOrEmpty(titleContains)) parts.Add("title~" + titleContains);
            if (hwnd > 0) parts.Add("hwnd=" + hwnd);
            return parts.Count > 0 ? string.Join(" & ", parts.ToArray()) : "(empty)";
        }
    }

    public class SafetyConfig
    {
        public string escMode { get; set; }        // "armed" | "always" | "off"
        public string comboHotkey { get; set; }    // "Ctrl+Alt+Pause" | "F12" | "Pause" | "Ctrl+Shift+F12" | "none"
        public bool whitelistEnabled { get; set; }
        public List<WhitelistRule> rules { get; set; }
        public int hudX { get; set; }
        public int hudY { get; set; }
        public bool hasHudPos { get; set; }

        public SafetyConfig()
        {
            escMode = "armed";
            comboHotkey = "Ctrl+Alt+Pause";
            whitelistEnabled = false;
            rules = new List<WhitelistRule>();
            hudX = 0;
            hudY = 0;
            hasHudPos = false;
        }
    }

    public class WindowCandidate
    {
        public long hwnd { get; set; }
        public int pid { get; set; }
        public string process { get; set; }
        public string title { get; set; }
        public bool foreground { get; set; }
    }

    public sealed class HudForm : Form
    {
        private const int HOTKEY_ID_COMBO = 0x5101;
        private const int VK_ESCAPE = 0x1B;
        private const int VK_PAUSE = 0x13;
        private const int VK_F12 = 0x7B;
        private const int VK_CONTROL = 0x11;
        private const int VK_MENU = 0x12; // Alt
        private const int VK_SHIFT = 0x10;

        private readonly string _cancelEventName;
        private readonly string _cancelFilePath;
        private readonly string _configFilePath;
        private readonly bool _allowIpcResume;
        private readonly object _stdoutLock = new object();
        private readonly StreamWriter _stdout;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();

        private EventWaitHandle _cancelEvent;
        private IntPtr _hookId = IntPtr.Zero;
        private NativeMethods.LowLevelKeyboardProc _hookProc; // Keep strong reference to avoid GC!
        private bool _hotkeyRegistered = false;
        private bool _excludeFromCapture = false;
        private bool _visuallySuspended = false;

        // Shared atomic / volatile state read by WH_KEYBOARD_LL callback without locking
        private volatile int _estopLatched = 0;
        private volatile int _armedForEsc = 0; // 1 when state is "armed" or "running"
        private volatile int _escAlways = 0;   // 1 when escMode == "always"
        private volatile int _escOff = 0;      // 1 when escMode == "off"
        private volatile int _comboVk = VK_PAUSE;
        private volatile uint _comboMods = NativeMethods.MOD_CONTROL | NativeMethods.MOD_ALT;
        private volatile int _comboEnabled = 1;

        private string _runState = "standby"; // "standby" | "armed" | "running" | "stopped"
        private string _detail = "";
        private string _lastTrigger = "";
        private SafetyConfig _config = new SafetyConfig();
        private WhitelistPopupForm _popup = null;
        private float _dpiScale = 1.0f;

        private int S(int px)
        {
            return (int)Math.Round(px * _dpiScale);
        }

        public float CurrentDpiScale
        {
            get { return _dpiScale; }
        }

        // UI Controls
        private Panel _dragGrip;
        private Panel _ledDot;
        private Label _lblStatus;
        private Button _btnWhitelist;
        private Button _btnStop;
        private Button _btnResume;

        private Thread _stdinThread;
        private volatile bool _exiting = false;
        private Process _parentProc = null;

        public HudForm(string cancelEventName, string cancelFilePath, string configFilePath, int parentPid, bool allowIpcResume)
        {
            _cancelEventName = cancelEventName ?? "";
            _cancelFilePath = cancelFilePath ?? "";
            _configFilePath = configFilePath ?? "";
            _allowIpcResume = allowIpcResume;

            Encoding utf8NoBom = new UTF8Encoding(false);
            _stdout = new StreamWriter(Console.OpenStandardOutput(), utf8NoBom);
            _stdout.AutoFlush = true;

            LoadSafetyConfig();
            InitCancelWaitHandle();
            BuildUi();

            if (parentPid > 0)
            {
                AttachParentExitWatcher(parentPid);
            }
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= NativeMethods.WS_EX_TOPMOST | NativeMethods.WS_EX_TOOLWINDOW | NativeMethods.WS_EX_NOACTIVATE;
                return cp;
            }
        }

        private void InitCancelWaitHandle()
        {
            if (string.IsNullOrEmpty(_cancelEventName)) return;
            try
            {
                bool createdNew;
                _cancelEvent = new EventWaitHandle(false, EventResetMode.ManualReset, _cancelEventName, out createdNew);
            }
            catch
            {
                _cancelEvent = null;
            }
        }

        private void AttachParentExitWatcher(int parentPid)
        {
            try
            {
                _parentProc = Process.GetProcessById(parentPid);
                _parentProc.EnableRaisingEvents = true;
                _parentProc.Exited += delegate
                {
                    BeginSafeExit();
                };
                if (_parentProc.HasExited)
                {
                    BeginSafeExit();
                }
            }
            catch
            {
                // Parent may already be inaccessible or gone
            }
        }

        private void BuildUi()
        {
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int probeX = _config.hasHudPos ? _config.hudX : (wa.Right - 480);
            int probeY = _config.hasHudPos ? _config.hudY : (wa.Top + 14);
            _dpiScale = NativeMethods.GetDpiScaleAtPoint(new Point(probeX, probeY));

            this.AutoScaleMode = AutoScaleMode.None;
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition = FormStartPosition.Manual;
            this.ShowInTaskbar = false;
            this.TopMost = true;
            this.DoubleBuffered = true;
            this.BackColor = Color.FromArgb(24, 26, 32);
            this.ForeColor = Color.White;
            this.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            this.ClientSize = new Size(S(476), S(46));

            int startX = _config.hasHudPos ? _config.hudX : (wa.Right - this.Width - S(18));
            int startY = _config.hasHudPos ? _config.hudY : (wa.Top + S(14));
            // Keep on virtual screen bounds
            Rectangle vs = SystemInformation.VirtualScreen;
            if (startX < vs.Left) startX = vs.Left + S(8);
            if (startY < vs.Top) startY = vs.Top + S(8);
            if (startX + this.Width > vs.Right) startX = vs.Right - this.Width - S(8);
            if (startY + this.Height > vs.Bottom) startY = vs.Bottom - this.Height - S(8);
            this.Location = new Point(startX, startY);

            _dragGrip = new Panel();
            _dragGrip.Bounds = new Rectangle(0, 0, S(24), S(46));
            _dragGrip.BackColor = Color.FromArgb(32, 35, 44);
            _dragGrip.Cursor = Cursors.SizeAll;
            _dragGrip.Paint += delegate(object s, PaintEventArgs e)
            {
                using (Brush b = new SolidBrush(Color.FromArgb(130, 140, 160)))
                {
                    int dotSz = Math.Max(2, S(3));
                    for (int row = 12; row <= 28; row += 7)
                    {
                        e.Graphics.FillEllipse(b, S(6), S(row), dotSz, dotSz);
                        e.Graphics.FillEllipse(b, S(13), S(row), dotSz, dotSz);
                    }
                }
            };
            _dragGrip.MouseDown += OnDragMouseDown;

            _ledDot = new Panel();
            _ledDot.Bounds = new Rectangle(S(32), S(16), S(14), S(14));
            _ledDot.BackColor = Color.Transparent;
            _ledDot.Paint += delegate(object s, PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Color c = Color.FromArgb(34, 197, 94); // green standby
                if (_estopLatched != 0) c = Color.FromArgb(239, 68, 68);
                else if (_runState == "running") c = Color.FromArgb(245, 158, 11);
                else if (_runState == "armed") c = Color.FromArgb(56, 189, 248);
                using (Brush b = new SolidBrush(c))
                {
                    e.Graphics.FillEllipse(b, 1, 1, Math.Max(6, _ledDot.Width - 2), Math.Max(6, _ledDot.Height - 2));
                }
            };

            _lblStatus = new Label();
            _lblStatus.Bounds = new Rectangle(S(50), S(4), S(186), S(38));
            _lblStatus.TextAlign = ContentAlignment.MiddleLeft;
            _lblStatus.ForeColor = Color.FromArgb(229, 231, 235);
            _lblStatus.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);
            _lblStatus.Cursor = Cursors.SizeAll;
            _lblStatus.MouseDown += OnDragMouseDown;

            _btnWhitelist = new Button();
            _btnWhitelist.Bounds = new Rectangle(S(242), S(7), S(112), S(32));
            _btnWhitelist.FlatStyle = FlatStyle.Flat;
            _btnWhitelist.FlatAppearance.BorderSize = 1;
            _btnWhitelist.FlatAppearance.BorderColor = Color.FromArgb(65, 72, 88);
            _btnWhitelist.BackColor = Color.FromArgb(39, 43, 54);
            _btnWhitelist.ForeColor = Color.FromArgb(209, 213, 219);
            _btnWhitelist.Font = new Font("Microsoft YaHei UI", 8.2f, FontStyle.Regular);
            _btnWhitelist.TabStop = false;
            _btnWhitelist.Cursor = Cursors.Hand;
            _btnWhitelist.Click += delegate { ToggleWhitelistPopup(); };

            _btnStop = new Button();
            _btnStop.Bounds = new Rectangle(S(360), S(6), S(108), S(34));
            _btnStop.FlatStyle = FlatStyle.Flat;
            _btnStop.FlatAppearance.BorderSize = 0;
            _btnStop.BackColor = Color.FromArgb(220, 38, 38);
            _btnStop.FlatAppearance.MouseOverBackColor = Color.FromArgb(239, 68, 68);
            _btnStop.FlatAppearance.MouseDownBackColor = Color.FromArgb(185, 28, 28);
            _btnStop.ForeColor = Color.White;
            _btnStop.Font = new Font("Microsoft YaHei UI", 9.0f, FontStyle.Bold);
            _btnStop.Text = "STOP 急停";
            _btnStop.TabStop = false;
            _btnStop.Cursor = Cursors.Hand;
            _btnStop.Click += delegate { TriggerEStopFromUi("button", "STOP_BUTTON"); };

            _btnResume = new Button();
            _btnResume.Bounds = new Rectangle(S(360), S(6), S(108), S(34));
            _btnResume.FlatStyle = FlatStyle.Flat;
            _btnResume.FlatAppearance.BorderSize = 0;
            _btnResume.BackColor = Color.FromArgb(22, 163, 74);
            _btnResume.FlatAppearance.MouseOverBackColor = Color.FromArgb(34, 197, 94);
            _btnResume.ForeColor = Color.White;
            _btnResume.Font = new Font("Microsoft YaHei UI", 8.8f, FontStyle.Bold);
            _btnResume.Text = "▶ 恢复解锁";
            _btnResume.TabStop = false;
            _btnResume.Cursor = Cursors.Hand;
            _btnResume.Visible = false;
            _btnResume.Click += delegate { ResumeFromUi("button"); };

            this.Controls.Add(_dragGrip);
            this.Controls.Add(_ledDot);
            this.Controls.Add(_lblStatus);
            this.Controls.Add(_btnWhitelist);
            this.Controls.Add(_btnStop);
            this.Controls.Add(_btnResume);

            this.Paint += delegate(object s, PaintEventArgs e)
            {
                Color border = _estopLatched != 0
                    ? Color.FromArgb(239, 68, 68)
                    : (_runState == "running" ? Color.FromArgb(245, 158, 11) : Color.FromArgb(62, 68, 84));
                using (Pen p = new Pen(border, _estopLatched != 0 ? 2f : 1f))
                {
                    e.Graphics.DrawRectangle(p, 0, 0, this.Width - 1, this.Height - 1);
                }
            };

            RefreshVisuals();
        }

        private void OnDragMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            NativeMethods.ReleaseCapture();
            NativeMethods.SendMessage(this.Handle, NativeMethods.WM_NCLBUTTONDOWN, new IntPtr(NativeMethods.HTCAPTION), IntPtr.Zero);
            SaveHudPosition();
        }

        private void SaveHudPosition()
        {
            _config.hudX = this.Left;
            _config.hudY = this.Top;
            _config.hasHudPos = true;
            SaveSafetyConfig();
            Dictionary<string, object> evt = new Dictionary<string, object>();
            evt["event"] = "boundsChanged";
            evt["bounds"] = GetBoundsDict();
            EmitJson(evt);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyCaptureExclusion(this.Handle);
        }

        public bool ApplyCaptureExclusion(IntPtr handle)
        {
            if (handle == IntPtr.Zero) return false;
            try
            {
                bool ok = NativeMethods.SetWindowDisplayAffinity(handle, NativeMethods.WDA_EXCLUDEFROMCAPTURE);
                if (handle == this.Handle) _excludeFromCapture = ok;
                return ok;
            }
            catch
            {
                if (handle == this.Handle) _excludeFromCapture = false;
                return false;
            }
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            InstallKeyboardHook();
            ApplyHotkeyRegistration();
            StartStdinReader();

            Dictionary<string, object> ready = BuildHealthDict();
            ready["event"] = "ready";
            ready["protocol"] = 1;
            ready["visualReady"] = true;
            EmitJson(ready);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == NativeMethods.WM_MOUSEACTIVATE)
            {
                m.Result = new IntPtr(NativeMethods.MA_NOACTIVATE);
                return;
            }
            if (m.Msg == NativeMethods.WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_ID_COMBO)
            {
                TriggerEStopFromUi("hotkey", _config.comboHotkey);
                return;
            }
            if (m.Msg == NativeMethods.WM_APP_ESTOP)
            {
                int vk = m.LParam.ToInt32();
                string keyName = vk == VK_ESCAPE ? "Escape" : _config.comboHotkey;
                CompleteEStopNotification("hotkey", keyName);
                return;
            }
            base.WndProc(ref m);
        }

        private void InstallKeyboardHook()
        {
            if (_hookProc == null)
            {
                _hookProc = new NativeMethods.LowLevelKeyboardProc(HookCallback);
            }
            if (_hookId == IntPtr.Zero)
            {
                using (Process curProcess = Process.GetCurrentProcess())
                using (ProcessModule curModule = curProcess.MainModule)
                {
                    IntPtr hMod = NativeMethods.GetModuleHandle(curModule != null ? curModule.ModuleName : null);
                    _hookId = NativeMethods.SetWindowsHookEx(NativeMethods.WH_KEYBOARD_LL, _hookProc, hMod, 0);
                }
            }
        }

        private void ApplyHotkeyRegistration()
        {
            try { NativeMethods.UnregisterHotKey(this.Handle, HOTKEY_ID_COMBO); } catch { }
            _hotkeyRegistered = false;

            string mode = (_config.escMode ?? "armed").ToLowerInvariant();
            _escAlways = mode == "always" ? 1 : 0;
            _escOff = mode == "off" ? 1 : 0;

            string combo = (_config.comboHotkey ?? "Ctrl+Alt+Pause").Trim();
            uint mods = 0;
            int vk = 0;
            if (!string.IsNullOrEmpty(combo) && !combo.Equals("none", StringComparison.OrdinalIgnoreCase))
            {
                string[] parts = combo.Split('+');
                for (int i = 0; i < parts.Length; i++)
                {
                    string p = parts[i].Trim().ToLowerInvariant();
                    if (p == "ctrl" || p == "control") mods |= NativeMethods.MOD_CONTROL;
                    else if (p == "alt") mods |= NativeMethods.MOD_ALT;
                    else if (p == "shift") mods |= NativeMethods.MOD_SHIFT;
                    else if (p == "pause" || p == "break") vk = VK_PAUSE;
                    else if (p == "f12") vk = VK_F12;
                    else if (p == "f11") vk = 0x7A;
                    else if (p == "f10") vk = 0x79;
                    else if (p == "esc" || p == "escape") vk = VK_ESCAPE;
                    else if (p.Length == 1 && p[0] >= 'a' && p[0] <= 'z') vk = (int)char.ToUpperInvariant(p[0]);
                }
            }
            if (vk != 0)
            {
                _comboVk = vk;
                _comboMods = mods;
                _comboEnabled = 1;
                // Only use RegisterHotKey when at least one modifier is present OR non-Esc special key like Pause/F12
                if (mods != 0 || vk != VK_ESCAPE)
                {
                    try
                    {
                        _hotkeyRegistered = NativeMethods.RegisterHotKey(this.Handle, HOTKEY_ID_COMBO, mods | NativeMethods.MOD_NOREPEAT, (uint)vk);
                    }
                    catch { _hotkeyRegistered = false; }
                }
            }
            else
            {
                _comboEnabled = 0;
                _comboVk = 0;
                _comboMods = 0;
            }
        }

        // CRITICAL: Must return immediately. Zero blocking I/O, zero locks, zero allocations!
        private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                if (msg == NativeMethods.WM_KEYDOWN || msg == NativeMethods.WM_SYSKEYDOWN)
                {
                    int vkCode = Marshal.ReadInt32(lParam);
                    int flags = Marshal.ReadInt32(lParam, 8);
                    bool injected = (flags & (NativeMethods.LLKHF_INJECTED | NativeMethods.LLKHF_LOWER_IL_INJECTED)) != 0;
                    if (!injected && _estopLatched == 0)
                    {
                        bool trigger = false;
                        if (vkCode == VK_ESCAPE && _escOff == 0)
                        {
                            if (_escAlways != 0 || _armedForEsc != 0)
                            {
                                trigger = true;
                            }
                        }
                        else if (_comboEnabled != 0 && vkCode == _comboVk)
                        {
                            uint mods = _comboMods;
                            bool ctrlOk = ((mods & NativeMethods.MOD_CONTROL) == 0) || ((NativeMethods.GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0);
                            bool altOk = ((mods & NativeMethods.MOD_ALT) == 0) || ((NativeMethods.GetAsyncKeyState(VK_MENU) & 0x8000) != 0);
                            bool shiftOk = ((mods & NativeMethods.MOD_SHIFT) == 0) || ((NativeMethods.GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0);
                            if (ctrlOk && altOk && shiftOk)
                            {
                                trigger = true;
                            }
                        }

                        if (trigger)
                        {
                            if (Interlocked.Exchange(ref _estopLatched, 1) == 0)
                            {
                                try { if (_cancelEvent != null) _cancelEvent.Set(); } catch { }
                                NativeMethods.PostMessage(this.Handle, NativeMethods.WM_APP_ESTOP, new IntPtr(1), new IntPtr(vkCode));
                            }
                            return new IntPtr(1); // Swallow abort key
                        }
                    }
                }
            }
            return NativeMethods.CallNextHookEx(_hookId, nCode, wParam, lParam);
        }

        private void WriteCancelFlag()
        {
            if (string.IsNullOrEmpty(_cancelFilePath)) return;
            try
            {
                string dir = Path.GetDirectoryName(_cancelFilePath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(_cancelFilePath, "estop\n", Encoding.UTF8);
            }
            catch { }
        }

        private void DeleteCancelFlag()
        {
            if (string.IsNullOrEmpty(_cancelFilePath)) return;
            try { if (File.Exists(_cancelFilePath)) File.Delete(_cancelFilePath); } catch { }
        }

        private void CompleteEStopNotification(string trigger, string keyName)
        {
            try { if (_cancelEvent != null) _cancelEvent.Set(); } catch { }
            WriteCancelFlag();
            _runState = "stopped";
            _armedForEsc = 0;
            _lastTrigger = trigger + ":" + keyName;
            RefreshVisuals();
            BringTopMostNoActivate();

            Dictionary<string, object> evt = new Dictionary<string, object>();
            evt["event"] = "estop";
            evt["trigger"] = trigger;
            evt["key"] = keyName;
            evt["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            EmitJson(evt);
        }

        public void TriggerEStopFromUi(string trigger, string keyName)
        {
            Interlocked.Exchange(ref _estopLatched, 1);
            CompleteEStopNotification(trigger, keyName);
        }

        public void ResumeFromUi(string trigger)
        {
            Interlocked.Exchange(ref _estopLatched, 0);
            try { if (_cancelEvent != null) _cancelEvent.Reset(); } catch { }
            DeleteCancelFlag();
            _runState = "standby";
            _armedForEsc = 0;
            _detail = "";
            RefreshVisuals();

            Dictionary<string, object> evt = new Dictionary<string, object>();
            evt["event"] = "resume";
            evt["trigger"] = trigger;
            evt["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            EmitJson(evt);
        }

        private void BringTopMostNoActivate()
        {
            if (_visuallySuspended || this.IsDisposed) return;
            try
            {
                NativeMethods.SetWindowPos(
                    this.Handle,
                    NativeMethods.HWND_TOPMOST,
                    0, 0, 0, 0,
                    NativeMethods.SWP_NOMOVE | NativeMethods.SWP_NOSIZE | NativeMethods.SWP_NOACTIVATE | NativeMethods.SWP_SHOWWINDOW
                );
            }
            catch { }
        }

        private void RefreshVisuals()
        {
            if (this.IsDisposed) return;
            if (_estopLatched != 0)
            {
                this.BackColor = Color.FromArgb(65, 16, 20);
                _dragGrip.BackColor = Color.FromArgb(90, 22, 28);
                _lblStatus.Text = "已急停 · 已中断AI操作";
                _lblStatus.ForeColor = Color.FromArgb(254, 202, 202);
                _btnStop.Visible = false;
                _btnResume.Visible = true;
            }
            else
            {
                this.BackColor = Color.FromArgb(24, 26, 32);
                _dragGrip.BackColor = Color.FromArgb(32, 35, 44);
                _btnStop.Visible = true;
                _btnResume.Visible = false;
                if (_runState == "running")
                {
                    _lblStatus.Text = string.IsNullOrEmpty(_detail) ? "AI执行中 · Esc急停" : _detail;
                    _lblStatus.ForeColor = Color.FromArgb(253, 230, 138);
                }
                else if (_runState == "armed")
                {
                    _lblStatus.Text = "护航中 · Esc可急停";
                    _lblStatus.ForeColor = Color.FromArgb(125, 211, 252);
                }
                else
                {
                    string escHint = _config.escMode == "always" ? "Esc始终监听" : (_config.comboHotkey != "none" ? _config.comboHotkey : "点击急停");
                    _lblStatus.Text = "待机 · " + escHint;
                    _lblStatus.ForeColor = Color.FromArgb(209, 213, 219);
                }
            }

            int ruleCount = _config.rules != null ? _config.rules.Count : 0;
            if (_config.whitelistEnabled)
            {
                _btnWhitelist.Text = "🔒 白名单(" + ruleCount + ")";
                _btnWhitelist.BackColor = Color.FromArgb(30, 58, 138);
                _btnWhitelist.ForeColor = Color.FromArgb(219, 234, 254);
                _btnWhitelist.FlatAppearance.BorderColor = Color.FromArgb(59, 130, 246);
            }
            else
            {
                _btnWhitelist.Text = "🌐 全桌面";
                _btnWhitelist.BackColor = Color.FromArgb(39, 43, 54);
                _btnWhitelist.ForeColor = Color.FromArgb(209, 213, 219);
                _btnWhitelist.FlatAppearance.BorderColor = Color.FromArgb(65, 72, 88);
            }
            _ledDot.Invalidate();
            this.Invalidate();
        }

        private void ToggleWhitelistPopup()
        {
            if (_popup != null && !_popup.IsDisposed)
            {
                _popup.Close();
                _popup = null;
                return;
            }
            _popup = new WhitelistPopupForm(this, _config);
            _popup.FormClosed += delegate { _popup = null; };
            _popup.Show();
        }

        public void ApplySafetyConfigFromUi(SafetyConfig updated)
        {
            _config = updated;
            SaveSafetyConfig();
            ApplyHotkeyRegistration();
            RefreshVisuals();

            Dictionary<string, object> evtWl = new Dictionary<string, object>();
            evtWl["event"] = "whitelistChanged";
            evtWl["whitelistEnabled"] = _config.whitelistEnabled;
            evtWl["rules"] = RulesToObjectList(_config.rules);
            evtWl["source"] = "hud";
            EmitJson(evtWl);

            Dictionary<string, object> evtHk = new Dictionary<string, object>();
            evtHk["event"] = "hotkeyChanged";
            evtHk["escMode"] = _config.escMode;
            evtHk["comboHotkey"] = _config.comboHotkey;
            evtHk["source"] = "hud";
            EmitJson(evtHk);
        }

        private static List<Dictionary<string, object>> RulesToObjectList(List<WhitelistRule> rules)
        {
            List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
            if (rules == null) return list;
            for (int i = 0; i < rules.Count; i++)
            {
                WhitelistRule r = rules[i];
                if (r == null) continue;
                Dictionary<string, object> d = new Dictionary<string, object>();
                if (!string.IsNullOrEmpty(r.process)) d["process"] = r.process;
                if (!string.IsNullOrEmpty(r.titleContains)) d["titleContains"] = r.titleContains;
                if (r.hwnd > 0) d["hwnd"] = r.hwnd;
                list.Add(d);
            }
            return list;
        }

        private void LoadSafetyConfig()
        {
            if (string.IsNullOrEmpty(_configFilePath) || !File.Exists(_configFilePath)) return;
            try
            {
                string raw = File.ReadAllText(_configFilePath, Encoding.UTF8);
                Dictionary<string, object> doc = _json.DeserializeObject(raw) as Dictionary<string, object>;
                if (doc == null) return;
                if (doc.ContainsKey("escMode") && doc["escMode"] != null) _config.escMode = doc["escMode"].ToString();
                if (doc.ContainsKey("comboHotkey") && doc["comboHotkey"] != null) _config.comboHotkey = doc["comboHotkey"].ToString();
                if (doc.ContainsKey("whitelistEnabled") && doc["whitelistEnabled"] is bool) _config.whitelistEnabled = (bool)doc["whitelistEnabled"];
                if (doc.ContainsKey("hasHudPos") && doc["hasHudPos"] is bool) _config.hasHudPos = (bool)doc["hasHudPos"];
                if (doc.ContainsKey("hudX")) _config.hudX = Convert.ToInt32(doc["hudX"]);
                if (doc.ContainsKey("hudY")) _config.hudY = Convert.ToInt32(doc["hudY"]);
                if (doc.ContainsKey("rules") && doc["rules"] is object[])
                {
                    _config.rules = ParseRules((object[])doc["rules"]);
                }
                else if (doc.ContainsKey("rules") && doc["rules"] is System.Collections.ArrayList)
                {
                    System.Collections.ArrayList arr = (System.Collections.ArrayList)doc["rules"];
                    _config.rules = ParseRules(arr.ToArray());
                }
            }
            catch { }
        }

        private static List<WhitelistRule> ParseRules(object[] rawRules)
        {
            List<WhitelistRule> list = new List<WhitelistRule>();
            if (rawRules == null) return list;
            for (int i = 0; i < rawRules.Length; i++)
            {
                Dictionary<string, object> d = rawRules[i] as Dictionary<string, object>;
                if (d == null) continue;
                WhitelistRule r = new WhitelistRule();
                if (d.ContainsKey("process") && d["process"] != null) r.process = d["process"].ToString().Trim();
                if (d.ContainsKey("titleContains") && d["titleContains"] != null) r.titleContains = d["titleContains"].ToString().Trim();
                if (d.ContainsKey("hwnd") && d["hwnd"] != null) r.hwnd = Convert.ToInt64(d["hwnd"]);
                if (!string.IsNullOrEmpty(r.process) || !string.IsNullOrEmpty(r.titleContains) || r.hwnd > 0)
                {
                    list.Add(r);
                }
            }
            return list;
        }

        private void SaveSafetyConfig()
        {
            if (string.IsNullOrEmpty(_configFilePath)) return;
            try
            {
                string dir = Path.GetDirectoryName(_configFilePath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                Dictionary<string, object> doc = new Dictionary<string, object>();
                doc["escMode"] = _config.escMode;
                doc["comboHotkey"] = _config.comboHotkey;
                doc["whitelistEnabled"] = _config.whitelistEnabled;
                doc["rules"] = RulesToObjectList(_config.rules);
                doc["hudX"] = _config.hudX;
                doc["hudY"] = _config.hudY;
                doc["hasHudPos"] = _config.hasHudPos;
                string tmp = _configFilePath + ".tmp";
                File.WriteAllText(tmp, _json.Serialize(doc), new UTF8Encoding(false));
                if (File.Exists(_configFilePath)) File.Delete(_configFilePath);
                File.Move(tmp, _configFilePath);
            }
            catch { }
        }

        private void StartStdinReader()
        {
            _stdinThread = new Thread(delegate()
            {
                try
                {
                    Encoding utf8NoBom = new UTF8Encoding(false);
                    using (StreamReader reader = new StreamReader(Console.OpenStandardInput(), utf8NoBom))
                    {
                        string line;
                        while (!_exiting && (line = reader.ReadLine()) != null)
                        {
                            string trimmed = line.Trim();
                            if (trimmed.Length == 0) continue;
                            string captured = trimmed;
                            if (!this.IsDisposed && this.IsHandleCreated)
                            {
                                try
                                {
                                    this.BeginInvoke((MethodInvoker)delegate { HandleStdinLine(captured); });
                                }
                                catch { }
                            }
                        }
                    }
                }
                catch { }
                BeginSafeExit();
            });
            _stdinThread.IsBackground = true;
            _stdinThread.Start();
        }

        private void HandleStdinLine(string line)
        {
            object id = null;
            try
            {
                Dictionary<string, object> msg = _json.DeserializeObject(line) as Dictionary<string, object>;
                if (msg == null) return;
                if (msg.ContainsKey("id")) id = msg["id"];
                string method = msg.ContainsKey("method") && msg["method"] != null ? msg["method"].ToString() : "";

                if (method == "ping" || method == "health")
                {
                    ReplyOk(id, BuildHealthDict());
                    return;
                }
                if (method == "setState")
                {
                    string st = msg.ContainsKey("state") && msg["state"] != null ? msg["state"].ToString().ToLowerInvariant() : "standby";
                    string detail = msg.ContainsKey("detail") && msg["detail"] != null ? msg["detail"].ToString() : "";
                    if (_estopLatched == 0)
                    {
                        if (st == "running") { _runState = "running"; _armedForEsc = 1; _detail = detail; BringTopMostNoActivate(); }
                        else if (st == "armed") { _runState = "armed"; _armedForEsc = 1; _detail = ""; }
                        else { _runState = "standby"; _armedForEsc = 0; _detail = ""; }
                        RefreshVisuals();
                    }
                    ReplyOk(id, BuildHealthDict());
                    return;
                }
                if (method == "setWhitelist")
                {
                    bool en = msg.ContainsKey("enabled") && (msg["enabled"] is bool) ? (bool)msg["enabled"] : _config.whitelistEnabled;
                    _config.whitelistEnabled = en;
                    if (msg.ContainsKey("rules") && msg["rules"] is object[])
                    {
                        _config.rules = ParseRules((object[])msg["rules"]);
                    }
                    else if (msg.ContainsKey("rules") && msg["rules"] is System.Collections.ArrayList)
                    {
                        _config.rules = ParseRules(((System.Collections.ArrayList)msg["rules"]).ToArray());
                    }
                    SaveSafetyConfig();
                    RefreshVisuals();
                    ReplyOk(id, BuildHealthDict());
                    return;
                }
                if (method == "setHotkey")
                {
                    if (msg.ContainsKey("escMode") && msg["escMode"] != null) _config.escMode = msg["escMode"].ToString();
                    if (msg.ContainsKey("comboHotkey") && msg["comboHotkey"] != null) _config.comboHotkey = msg["comboHotkey"].ToString();
                    SaveSafetyConfig();
                    ApplyHotkeyRegistration();
                    RefreshVisuals();
                    ReplyOk(id, BuildHealthDict());
                    return;
                }
                if (method == "suspendVisual")
                {
                    _visuallySuspended = true;
                    NativeMethods.ShowWindow(this.Handle, NativeMethods.SW_HIDE);
                    if (_popup != null && !_popup.IsDisposed) NativeMethods.ShowWindow(_popup.Handle, NativeMethods.SW_HIDE);
                    Dictionary<string, object> r = new Dictionary<string, object>();
                    r["suspended"] = true;
                    ReplyOk(id, r);
                    return;
                }
                if (method == "resumeVisual")
                {
                    _visuallySuspended = false;
                    NativeMethods.ShowWindow(this.Handle, NativeMethods.SW_SHOWNOACTIVATE);
                    BringTopMostNoActivate();
                    ApplyCaptureExclusion(this.Handle);
                    if (_popup != null && !_popup.IsDisposed) NativeMethods.ShowWindow(_popup.Handle, NativeMethods.SW_SHOWNOACTIVATE);
                    Dictionary<string, object> r = new Dictionary<string, object>();
                    r["suspended"] = false;
                    ReplyOk(id, r);
                    return;
                }
                if (method == "estop")
                {
                    TriggerEStopFromUi("ipc", "IPC_STOP");
                    ReplyOk(id, BuildHealthDict());
                    return;
                }
                if (method == "testResume")
                {
                    if (!_allowIpcResume)
                    {
                        ReplyError(id, "testResume is disabled outside test mode; click Resume on the physical HUD");
                        return;
                    }
                    ResumeFromUi("test_ipc");
                    ReplyOk(id, BuildHealthDict());
                    return;
                }
                if (method == "quit")
                {
                    Dictionary<string, object> r = new Dictionary<string, object>();
                    r["bye"] = true;
                    ReplyOk(id, r);
                    BeginSafeExit();
                    return;
                }
                ReplyError(id, "unknown method: " + method);
            }
            catch (Exception ex)
            {
                ReplyError(id, ex.Message);
            }
        }

        private Dictionary<string, object> GetBoundsDict()
        {
            Dictionary<string, object> b = new Dictionary<string, object>();
            b["x"] = this.Left;
            b["y"] = this.Top;
            b["width"] = this.Width;
            b["height"] = this.Height;
            return b;
        }

        private Dictionary<string, object> BuildHealthDict()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["pid"] = Process.GetCurrentProcess().Id;
            d["hwnd"] = this.IsHandleCreated ? this.Handle.ToInt64() : 0L;
            d["estopLatched"] = (_estopLatched != 0);
            d["state"] = _estopLatched != 0 ? "stopped" : _runState;
            d["lastTrigger"] = _lastTrigger;
            d["excludeFromCapture"] = _excludeFromCapture;
            d["hookInstalled"] = (_hookId != IntPtr.Zero);
            d["hotkeyRegistered"] = _hotkeyRegistered;
            d["escMode"] = _config.escMode;
            d["comboHotkey"] = _config.comboHotkey;
            d["whitelistEnabled"] = _config.whitelistEnabled;
            d["whitelistCount"] = _config.rules != null ? _config.rules.Count : 0;
            d["rules"] = RulesToObjectList(_config.rules);
            d["bounds"] = GetBoundsDict();
            d["visuallySuspended"] = _visuallySuspended;
            return d;
        }

        private void ReplyOk(object id, Dictionary<string, object> result)
        {
            Dictionary<string, object> resp = new Dictionary<string, object>();
            resp["id"] = id;
            resp["ok"] = true;
            resp["result"] = result;
            EmitJson(resp);
        }

        private void ReplyError(object id, string error)
        {
            Dictionary<string, object> resp = new Dictionary<string, object>();
            resp["id"] = id;
            resp["ok"] = false;
            resp["error"] = error;
            EmitJson(resp);
        }

        private void EmitJson(Dictionary<string, object> obj)
        {
            string s = _json.Serialize(obj);
            lock (_stdoutLock)
            {
                try
                {
                    _stdout.WriteLine(s);
                }
                catch { }
            }
        }

        private void BeginSafeExit()
        {
            if (_exiting) return;
            _exiting = true;
            if (!this.IsDisposed && this.IsHandleCreated)
            {
                try
                {
                    this.BeginInvoke((MethodInvoker)delegate
                    {
                        CleanupAndExit();
                    });
                    return;
                }
                catch { }
            }
            try { Application.ExitThread(); } catch { }
        }

        private void CleanupAndExit()
        {
            if (_popup != null && !_popup.IsDisposed) { try { _popup.Close(); } catch { } }
            if (_hookId != IntPtr.Zero) { try { NativeMethods.UnhookWindowsHookEx(_hookId); } catch { } _hookId = IntPtr.Zero; }
            try { NativeMethods.UnregisterHotKey(this.Handle, HOTKEY_ID_COMBO); } catch { }
            try { if (_cancelEvent != null) _cancelEvent.Dispose(); } catch { }
            this.Close();
            Application.Exit();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (_hookId != IntPtr.Zero) { try { NativeMethods.UnhookWindowsHookEx(_hookId); } catch { } _hookId = IntPtr.Zero; }
            try { NativeMethods.UnregisterHotKey(this.Handle, HOTKEY_ID_COMBO); } catch { }
            base.OnFormClosed(e);
        }
    }

    public sealed class WhitelistPopupForm : Form
    {
        private readonly HudForm _ownerHud;
        private CheckBox _chkEnabled;
        private CheckedListBox _listRules;
        private TextBox _txtCustom;
        private ComboBox _cmbEscMode;
        private ComboBox _cmbCombo;
        private List<WhitelistRule> _workingRules = new List<WhitelistRule>();
        private float _dpiScale = 1.0f;

        private int S(int px)
        {
            return (int)Math.Round(px * _dpiScale);
        }

        public WhitelistPopupForm(HudForm ownerHud, SafetyConfig current)
        {
            _ownerHud = ownerHud;
            _dpiScale = ownerHud != null ? ownerHud.CurrentDpiScale : NativeMethods.GetDpiScaleAtPoint(Cursor.Position);

            this.AutoScaleMode = AutoScaleMode.None;
            this.FormBorderStyle = FormBorderStyle.FixedToolWindow;
            this.StartPosition = FormStartPosition.Manual;
            this.TopMost = true;
            this.ShowInTaskbar = false;
            this.Text = "桌面操控安全保护 & 白名单";
            this.BackColor = Color.FromArgb(28, 31, 38);
            this.ForeColor = Color.White;
            this.Font = new Font("Microsoft YaHei UI", 8.8f);
            this.ClientSize = new Size(S(520), S(476));

            int px = ownerHud.Right - this.Width;
            int py = ownerHud.Bottom + S(6);
            Rectangle vs = SystemInformation.VirtualScreen;
            if (px < vs.Left + S(8)) px = vs.Left + S(8);
            if (py + this.Height > vs.Bottom - S(8)) py = Math.Max(vs.Top + S(8), ownerHud.Top - this.Height - S(6));
            this.Location = new Point(px, py);

            _chkEnabled = new CheckBox();
            _chkEnabled.Bounds = new Rectangle(S(14), S(12), S(492), S(26));
            _chkEnabled.Text = "启用窗口白名单锁定 (仅允许 AI 操作下方勾选的应用)";
            _chkEnabled.Checked = current.whitelistEnabled;
            _chkEnabled.ForeColor = Color.FromArgb(147, 197, 253);

            Label lblList = new Label();
            lblList.Bounds = new Rectangle(S(14), S(46), S(350), S(22));
            lblList.TextAlign = ContentAlignment.MiddleLeft;
            lblList.Text = "白名单规则 / 当前桌面应用:";
            lblList.ForeColor = Color.FromArgb(209, 213, 219);

            Button btnRefresh = new Button();
            btnRefresh.Bounds = new Rectangle(S(386), S(42), S(120), S(28));
            btnRefresh.Text = "刷新桌面窗口";
            btnRefresh.FlatStyle = FlatStyle.Flat;
            btnRefresh.BackColor = Color.FromArgb(46, 51, 64);
            btnRefresh.Click += delegate { PopulateWindowList(); };

            _listRules = new CheckedListBox();
            _listRules.Bounds = new Rectangle(S(14), S(76), S(492), S(184));
            _listRules.BackColor = Color.FromArgb(20, 22, 28);
            _listRules.ForeColor = Color.White;
            _listRules.BorderStyle = BorderStyle.FixedSingle;
            _listRules.CheckOnClick = true;

            Label lblAdd = new Label();
            lblAdd.Bounds = new Rectangle(S(14), S(268), S(492), S(22));
            lblAdd.TextAlign = ContentAlignment.MiddleLeft;
            lblAdd.Text = "添加进程名(如 notepad) 或 title:标题关键字 (如 TIA Portal):";
            lblAdd.ForeColor = Color.FromArgb(156, 163, 175);

            _txtCustom = new TextBox();
            _txtCustom.Bounds = new Rectangle(S(14), S(294), S(372), S(26));
            _txtCustom.BackColor = Color.FromArgb(20, 22, 28);
            _txtCustom.ForeColor = Color.White;

            Button btnAdd = new Button();
            btnAdd.Bounds = new Rectangle(S(394), S(292), S(112), S(28));
            btnAdd.Text = "+ 添加规则";
            btnAdd.FlatStyle = FlatStyle.Flat;
            btnAdd.BackColor = Color.FromArgb(46, 51, 64);
            btnAdd.Click += delegate { AddCustomRule(); };

            // Presets row
            Button btnPresetTia = new Button();
            btnPresetTia.Bounds = new Rectangle(S(14), S(328), S(152), S(28));
            btnPresetTia.Text = "+ TIA Portal";
            btnPresetTia.FlatStyle = FlatStyle.Flat;
            btnPresetTia.BackColor = Color.FromArgb(39, 43, 54);
            btnPresetTia.Click += delegate { AddRuleIfMissing(new WhitelistRule { process = "Siemens.Automation.Portal" }, true); };

            Button btnPresetFio = new Button();
            btnPresetFio.Bounds = new Rectangle(S(174), S(328), S(156), S(28));
            btnPresetFio.Text = "+ Factory I/O";
            btnPresetFio.FlatStyle = FlatStyle.Flat;
            btnPresetFio.BackColor = Color.FromArgb(39, 43, 54);
            btnPresetFio.Click += delegate { AddRuleIfMissing(new WhitelistRule { process = "Factory IO" }, true); };

            Button btnPresetPad = new Button();
            btnPresetPad.Bounds = new Rectangle(S(338), S(328), S(168), S(28));
            btnPresetPad.Text = "+ 记事本 (notepad)";
            btnPresetPad.FlatStyle = FlatStyle.Flat;
            btnPresetPad.BackColor = Color.FromArgb(39, 43, 54);
            btnPresetPad.Click += delegate { AddRuleIfMissing(new WhitelistRule { process = "notepad" }, true); };

            Label lblEsc = new Label();
            lblEsc.Bounds = new Rectangle(S(14), S(368), S(160), S(24));
            lblEsc.TextAlign = ContentAlignment.MiddleLeft;
            lblEsc.Text = "Esc 急停监听模式:";
            lblEsc.ForeColor = Color.FromArgb(209, 213, 219);

            _cmbEscMode = new ComboBox();
            _cmbEscMode.Bounds = new Rectangle(S(178), S(366), S(328), S(26));
            _cmbEscMode.DropDownStyle = ComboBoxStyle.DropDownList;
            _cmbEscMode.BackColor = Color.FromArgb(20, 22, 28);
            _cmbEscMode.ForeColor = Color.White;
            _cmbEscMode.Items.AddRange(new object[] { "armed (仅AI操作期间触发 - 推荐)", "always (始终触发急停)", "off (禁用Esc，仅用组合键/按钮)" });
            if (current.escMode == "always") _cmbEscMode.SelectedIndex = 1;
            else if (current.escMode == "off") _cmbEscMode.SelectedIndex = 2;
            else _cmbEscMode.SelectedIndex = 0;

            Label lblCombo = new Label();
            lblCombo.Bounds = new Rectangle(S(14), S(400), S(160), S(24));
            lblCombo.TextAlign = ContentAlignment.MiddleLeft;
            lblCombo.Text = "全局组合急停热键:";
            lblCombo.ForeColor = Color.FromArgb(209, 213, 219);

            _cmbCombo = new ComboBox();
            _cmbCombo.Bounds = new Rectangle(S(178), S(398), S(328), S(26));
            _cmbCombo.DropDownStyle = ComboBoxStyle.DropDownList;
            _cmbCombo.BackColor = Color.FromArgb(20, 22, 28);
            _cmbCombo.ForeColor = Color.White;
            _cmbCombo.Items.AddRange(new object[] { "Ctrl+Alt+Pause", "F12", "Ctrl+Shift+F12", "Pause", "none" });
            int idx = _cmbCombo.Items.IndexOf(current.comboHotkey ?? "Ctrl+Alt+Pause");
            _cmbCombo.SelectedIndex = idx >= 0 ? idx : 0;

            Button btnApply = new Button();
            btnApply.Bounds = new Rectangle(S(282), S(434), S(128), S(32));
            btnApply.Text = "应用并保存";
            btnApply.FlatStyle = FlatStyle.Flat;
            btnApply.BackColor = Color.FromArgb(37, 99, 235);
            btnApply.ForeColor = Color.White;
            btnApply.Click += delegate { SaveAndClose(); };

            Button btnCancel = new Button();
            btnCancel.Bounds = new Rectangle(S(418), S(434), S(88), S(32));
            btnCancel.Text = "关闭";
            btnCancel.FlatStyle = FlatStyle.Flat;
            btnCancel.BackColor = Color.FromArgb(55, 65, 81);
            btnCancel.Click += delegate { this.Close(); };

            this.Controls.AddRange(new Control[] {
                _chkEnabled, lblList, btnRefresh, _listRules, lblAdd, _txtCustom, btnAdd,
                btnPresetTia, btnPresetFio, btnPresetPad, lblEsc, _cmbEscMode, lblCombo, _cmbCombo, btnApply, btnCancel
            });

            if (current.rules != null)
            {
                for (int i = 0; i < current.rules.Count; i++)
                {
                    AddRuleIfMissing(current.rules[i], true);
                }
            }
            PopulateWindowList();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            NativeMethods.EnableDarkTitleBar(this.Handle);
            _ownerHud.ApplyCaptureExclusion(this.Handle);
        }

        private void AddRuleIfMissing(WhitelistRule rule, bool isChecked)
        {
            if (rule == null) return;
            for (int i = 0; i < _workingRules.Count; i++)
            {
                WhitelistRule ex = _workingRules[i];
                if (string.Equals(ex.process ?? "", rule.process ?? "", StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(ex.titleContains ?? "", rule.titleContains ?? "", StringComparison.OrdinalIgnoreCase) &&
                    ex.hwnd == rule.hwnd)
                {
                    if (isChecked) _listRules.SetItemChecked(i, true);
                    return;
                }
            }
            _workingRules.Add(rule);
            _listRules.Items.Add(rule.DisplayLabel(), isChecked);
        }

        private void AddCustomRule()
        {
            string text = (_txtCustom.Text ?? "").Trim();
            if (text.Length == 0) return;
            WhitelistRule r = new WhitelistRule();
            if (text.StartsWith("title:", StringComparison.OrdinalIgnoreCase))
            {
                r.titleContains = text.Substring(6).Trim();
            }
            else
            {
                r.process = text.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? text.Substring(0, text.Length - 4) : text;
            }
            AddRuleIfMissing(r, true);
            _txtCustom.Text = "";
        }

        private void PopulateWindowList()
        {
            int selfPid = Process.GetCurrentProcess().Id;
            HashSet<string> seenProc = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            NativeMethods.EnumWindows(delegate(IntPtr hwnd, IntPtr lp)
            {
                if (!NativeMethods.IsWindowVisible(hwnd)) return true;
                if (NativeMethods.IsCloaked(hwnd) || NativeMethods.IsToolWindow(hwnd)) return true;
                string title = NativeMethods.GetWindowTitle(hwnd);
                if (string.IsNullOrWhiteSpace(title)) return true;
                uint pid = 0;
                NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
                if ((int)pid == selfPid || pid == 0) return true;
                string proc = "";
                try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { proc = ""; }
                if (string.IsNullOrEmpty(proc)) return true;
                if (seenProc.Add(proc))
                {
                    AddRuleIfMissing(new WhitelistRule { process = proc }, IsProcessChecked(proc));
                }
                return true;
            }, IntPtr.Zero);
        }

        private bool IsProcessChecked(string proc)
        {
            for (int i = 0; i < _workingRules.Count; i++)
            {
                if (string.Equals(_workingRules[i].process ?? "", proc, StringComparison.OrdinalIgnoreCase))
                {
                    return _listRules.GetItemChecked(i);
                }
            }
            return false;
        }

        private void SaveAndClose()
        {
            SafetyConfig next = new SafetyConfig();
            next.whitelistEnabled = _chkEnabled.Checked;
            next.hudX = _ownerHud.Left;
            next.hudY = _ownerHud.Top;
            next.hasHudPos = true;
            next.escMode = _cmbEscMode.SelectedIndex == 1 ? "always" : (_cmbEscMode.SelectedIndex == 2 ? "off" : "armed");
            next.comboHotkey = _cmbCombo.SelectedItem != null ? _cmbCombo.SelectedItem.ToString() : "Ctrl+Alt+Pause";
            for (int i = 0; i < _workingRules.Count; i++)
            {
                if (_listRules.GetItemChecked(i))
                {
                    next.rules.Add(_workingRules[i]);
                }
            }
            _ownerHud.ApplySafetyConfigFromUi(next);
            this.Close();
        }
    }

    public static class Program
    {
        [STAThread]
        public static void Main(string[] args)
        {
            NativeMethods.EnablePerMonitorV2Dpi();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string cancelEvent = "";
            string cancelFile = "";
            string configFile = "";
            int parentPid = 0;
            bool allowIpcResume = false;

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a.StartsWith("--cancel-event=")) cancelEvent = a.Substring("--cancel-event=".Length);
                else if (a.StartsWith("--cancel-file=")) cancelFile = a.Substring("--cancel-file=".Length);
                else if (a.StartsWith("--config-file=")) configFile = a.Substring("--config-file=".Length);
                else if (a.StartsWith("--parent-pid=")) int.TryParse(a.Substring("--parent-pid=".Length), out parentPid);
                else if (a == "--allow-ipc-resume") allowIpcResume = true;
            }

            HudForm hud = new HudForm(cancelEvent, cancelFile, configFile, parentPid, allowIpcResume);
            Application.Run(hud);
        }
    }
}
