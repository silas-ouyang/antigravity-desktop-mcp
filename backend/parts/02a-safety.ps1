# Runtime safety policy inside PowerShell worker:
# - Protected E-Stop/Safety HUD coordinates & HWNDs (AI can never click RESUME or inspect/edit HUD UI)
# - Window whitelist enforcement (process / titleContains / hwnd, including GA_ROOTOWNER dialog support)
# - OS-escape shortcut blocking when whitelist mode is active

$script:SafetyConfig = [ordered]@{
    hudPid           = 0
    estopLatched     = $false
    whitelistEnabled = $false
    rules            = @()
}
$script:HudPid = 0

if (-not [string]::IsNullOrWhiteSpace("$($env:AGY_DESKTOP_HUD_PID)")) {
    try {
        $script:HudPid = [int]$env:AGY_DESKTOP_HUD_PID
        $script:SafetyConfig.hudPid = $script:HudPid
    } catch { }
}
if ("$($env:AGY_DESKTOP_ESTOP_LATCHED)" -eq '1') {
    $script:SafetyEstopLatched = $true
    $script:SafetyConfig.estopLatched = $true
}
if ("$($env:AGY_DESKTOP_WHITELIST_ENABLED)" -eq '1') {
    $script:SafetyConfig.whitelistEnabled = $true
}
if (-not [string]::IsNullOrWhiteSpace("$($env:AGY_DESKTOP_WHITELIST_JSON)")) {
    try {
        $parsedRules = $env:AGY_DESKTOP_WHITELIST_JSON | ConvertFrom-Json
        if ($null -ne $parsedRules) { $script:SafetyConfig.rules = @($parsedRules) }
    } catch { }
}

function Normalize-ProcessName([string]$name) {
    if ([string]::IsNullOrWhiteSpace($name)) { return '' }
    $n = $name.Trim().ToLowerInvariant()
    if ($n.EndsWith('.exe')) { $n = $n.Substring(0, $n.Length - 4) }
    return $n
}

function Set-SafetyConfig([object]$Arg) {
    if ($null -ne $Arg.hudPid) {
        $script:HudPid = [int]$Arg.hudPid
        $script:SafetyConfig.hudPid = $script:HudPid
    }
    if ($null -ne $Arg.estopLatched) {
        $latched = ($Arg.estopLatched -eq $true -or "$($Arg.estopLatched)" -eq 'true')
        $script:SafetyEstopLatched = $latched
        $script:SafetyConfig.estopLatched = $latched
    }
    if ($null -ne $Arg.whitelistEnabled) {
        $script:SafetyConfig.whitelistEnabled = ($Arg.whitelistEnabled -eq $true -or "$($Arg.whitelistEnabled)" -eq 'true')
    }
    if ($null -ne $Arg.rules) {
        $script:SafetyConfig.rules = @($Arg.rules)
    }
    return [ordered]@{
        ok               = $true
        hudPid           = $script:HudPid
        estopLatched     = $script:SafetyEstopLatched
        whitelistEnabled = $script:SafetyConfig.whitelistEnabled
        ruleCount        = $script:SafetyConfig.rules.Count
    }
}

function Get-SafetyStatus {
    return [ordered]@{
        hudPid           = $script:HudPid
        estopLatched     = $script:SafetyEstopLatched
        whitelistEnabled = $script:SafetyConfig.whitelistEnabled
        ruleCount        = $script:SafetyConfig.rules.Count
    }
}

function Test-IsHudHwnd([IntPtr]$hwnd) {
    if ($hwnd -eq [IntPtr]::Zero -or $script:HudPid -le 0) { return $false }
    $procId = 0
    [void][DshNative]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    if ($procId -eq $script:HudPid) { return $true }
    $root = [DshNative]::GetAncestor($hwnd, 2)
    if ($root -ne [IntPtr]::Zero -and $root -ne $hwnd) {
        $rp = 0
        [void][DshNative]::GetWindowThreadProcessId($root, [ref]$rp)
        if ($rp -eq $script:HudPid) { return $true }
    }
    return $false
}

function Test-PointOverHudRect([int]$x, [int]$y) {
    if ($script:HudPid -le 0) { return $false }
    $state = @{ hit = $false }
    $cb = [DshNative+EnumWindowsProc] {
        param([IntPtr]$hwnd, [IntPtr]$lParam)
        if (-not [DshNative]::IsWindowVisible($hwnd)) { return $true }
        $procId = 0
        [void][DshNative]::GetWindowThreadProcessId($hwnd, [ref]$procId)
        if ($procId -ne $script:HudPid) { return $true }
        $rect = New-Object DshNative+RECT
        if ([DshNative]::GetWindowRect($hwnd, [ref]$rect)) {
            if ($x -ge $rect.Left -and $x -lt $rect.Right -and $y -ge $rect.Top -and $y -lt $rect.Bottom) {
                $state.hit = $true
                return $false
            }
        }
        return $true
    }
    [void][DshNative]::EnumWindows($cb, [IntPtr]::Zero)
    return [bool]$state.hit
}

function Assert-HudProtectedHwnd([int64]$hwndVal, [string]$what) {
    if ($hwndVal -le 0) { return }
    if (Test-IsHudHwnd ([IntPtr]$hwndVal)) {
        throw "[PROTECTED_HUD_TARGET] $what targets the protected E-Stop/Safety HUD window (hwnd $hwndVal). AI control of the HUD is disabled. (action_sent=false)"
    }
}

function Assert-HudProtectedPoint([int]$x, [int]$y, [string]$what) {
    $pt = New-Object DshNative+POINT
    $pt.X = $x
    $pt.Y = $y
    $hit = [DshNative]::WindowFromPoint($pt)
    if (Test-IsHudHwnd $hit) {
        throw "[PROTECTED_HUD_TARGET] $what at ($x,$y) targets the protected E-Stop/Safety HUD window. AI control of the HUD is disabled. (action_sent=false)"
    }
    if (Test-PointOverHudRect $x $y) {
        throw "[PROTECTED_HUD_TARGET] $what at ($x,$y) lies within the protected E-Stop/Safety HUD bounds. AI control of the HUD is disabled. (action_sent=false)"
    }
}

function Test-SingleHwndMatchesRule([IntPtr]$hwnd, [object]$rule) {
    if ($hwnd -eq [IntPtr]::Zero) { return $false }
    $hasConstraint = $false

    $ruleHwnd = 0
    if ($null -ne $rule.hwnd -and "$($rule.hwnd)" -ne '') {
        try { $ruleHwnd = [int64]$rule.hwnd } catch { $ruleHwnd = 0 }
    }
    if ($ruleHwnd -gt 0) {
        $hasConstraint = $true
        if ([int64]$hwnd -ne $ruleHwnd) { return $false }
    }

    $ruleProc = Normalize-ProcessName "$($rule.process)"
    $ruleTitle = ''
    if ($null -ne $rule.titleContains) { $ruleTitle = "$($rule.titleContains)".Trim() }

    if ($ruleProc -ne '' -or $ruleTitle -ne '') {
        $procId = 0
        [void][DshNative]::GetWindowThreadProcessId($hwnd, [ref]$procId)
        if ($procId -le 0) { return $false }
        if ($ruleProc -ne '') {
            $hasConstraint = $true
            $actualProc = ''
            try { $actualProc = Normalize-ProcessName ((Get-Process -Id $procId -ErrorAction Stop).ProcessName) } catch { $actualProc = '' }
            if ($actualProc -eq '') { return $false }
            if ($ruleProc.Contains('*') -or $ruleProc.Contains('?')) {
                if (-not ($actualProc -like $ruleProc)) { return $false }
            } elseif ($actualProc -ne $ruleProc) {
                return $false
            }
        }
        if ($ruleTitle -ne '') {
            $hasConstraint = $true
            $actualTitle = [DshNative]::WindowText($hwnd)
            if ([string]::IsNullOrEmpty($actualTitle)) { return $false }
            if ($actualTitle.IndexOf($ruleTitle, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
        }
    }
    return $hasConstraint
}

function Test-HwndMatchesWhitelist([IntPtr]$hwnd) {
    if (-not $script:SafetyConfig.whitelistEnabled) { return $true }
    $rules = @($script:SafetyConfig.rules)
    if ($rules.Count -eq 0) { return $false }
    if ($hwnd -eq [IntPtr]::Zero -or -not [DshNative]::IsWindow($hwnd)) { return $false }

    $candidates = New-Object System.Collections.Generic.List[IntPtr]
    $candidates.Add($hwnd)
    $root = [DshNative]::GetAncestor($hwnd, 2)
    if ($root -ne [IntPtr]::Zero -and $root -ne $hwnd) { $candidates.Add($root) }
    $rootOwner = [DshNative]::GetAncestor($hwnd, 3)
    if ($rootOwner -ne [IntPtr]::Zero -and -not $candidates.Contains($rootOwner)) { $candidates.Add($rootOwner) }

    foreach ($rule in $rules) {
        if ($null -eq $rule) { continue }
        foreach ($cand in $candidates) {
            if (Test-SingleHwndMatchesRule $cand $rule) { return $true }
        }
    }
    return $false
}

function Assert-WindowAllowedHwnd([IntPtr]$hwnd, [string]$what) {
    Assert-HudProtectedHwnd ([int64]$hwnd) $what
    if (-not $script:SafetyConfig.whitelistEnabled) { return }
    if (-not (Test-HwndMatchesWhitelist $hwnd)) {
        $root = [DshNative]::GetAncestor($hwnd, 3)
        if ($root -eq [IntPtr]::Zero) { $root = [DshNative]::GetAncestor($hwnd, 2) }
        if ($root -eq [IntPtr]::Zero) { $root = $hwnd }
        $procId = 0
        [void][DshNative]::GetWindowThreadProcessId($root, [ref]$procId)
        $procName = ''
        if ($procId -gt 0) { try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { } }
        $title = [DshNative]::WindowText($root)
        throw "[WINDOW_NOT_WHITELISTED] $what blocked by active window whitelist: target window hwnd $([int64]$root) [$procName] '$title' is not in the allowed list. (action_sent=false)"
    }
}

function Assert-CoordinateSafety([int]$x, [int]$y, [string]$what) {
    Assert-HudProtectedPoint $x $y $what
    if (-not $script:SafetyConfig.whitelistEnabled) { return }
    $pt = New-Object DshNative+POINT
    $pt.X = $x
    $pt.Y = $y
    $hit = [DshNative]::WindowFromPoint($pt)
    $root = [DshNative]::GetAncestor($hit, 3)
    if ($root -eq [IntPtr]::Zero) { $root = [DshNative]::GetAncestor($hit, 2) }
    if ($root -eq [IntPtr]::Zero) { $root = $hit }
    if ($root -eq [IntPtr]::Zero -or -not (Test-HwndMatchesWhitelist $hit)) {
        $procId = 0
        if ($root -ne [IntPtr]::Zero) { [void][DshNative]::GetWindowThreadProcessId($root, [ref]$procId) }
        $procName = ''
        if ($procId -gt 0) { try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { } }
        $title = if ($root -ne [IntPtr]::Zero) { [DshNative]::WindowText($root) } else { '' }
        throw "[WINDOW_NOT_WHITELISTED] $what at ($x,$y) blocked by active window whitelist: point lands on hwnd $([int64]$root) [$procName] '$title', which is not allowed. (action_sent=false)"
    }
}

function Assert-KeyAllowedUnderWhitelist([string]$chord) {
    if (-not $script:SafetyConfig.whitelistEnabled) { return }
    if ([string]::IsNullOrWhiteSpace($chord)) { return }
    $tokens = @($chord.ToLowerInvariant().Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    $hasWin = $tokens -contains 'win' -or $tokens -contains 'lwin' -or $tokens -contains 'rwin' -or $tokens -contains 'meta'
    $hasAlt = $tokens -contains 'alt' -or $tokens -contains 'lalt' -or $tokens -contains 'ralt' -or $tokens -contains 'menu'
    $hasCtrl = $tokens -contains 'ctrl' -or $tokens -contains 'lctrl' -or $tokens -contains 'rctrl' -or $tokens -contains 'control'
    $hasShift = $tokens -contains 'shift' -or $tokens -contains 'lshift' -or $tokens -contains 'rshift'
    $isEscapeChord = $hasWin -or
        ($hasAlt -and ($tokens -contains 'tab' -or $tokens -contains 'esc' -or $tokens -contains 'escape')) -or
        ($hasCtrl -and $tokens -contains 'esc') -or
        ($hasCtrl -and $tokens -contains 'escape') -or
        ($hasCtrl -and $hasAlt -and ($tokens -contains 'del' -or $tokens -contains 'delete')) -or
        ($hasCtrl -and $hasShift -and ($tokens -contains 'esc' -or $tokens -contains 'escape'))
    if ($isEscapeChord) {
        throw "[WHITELIST_OS_SHORTCUT_BLOCKED] key chord '$chord' is blocked while window whitelist mode is active to prevent leaving the allowed applications. (action_sent=false)"
    }
}

function Assert-KeyboardSafety([object]$intoHwnd, [string]$chord, [string]$what) {
    $targetHwnd = [IntPtr]::Zero
    if ($null -ne $intoHwnd -and "$intoHwnd" -ne '' -and [int64]$intoHwnd -ne 0) {
        $targetHwnd = [IntPtr][int64]$intoHwnd
    } else {
        $targetHwnd = [DshNative]::GetForegroundWindow()
    }
    if ($targetHwnd -ne [IntPtr]::Zero) {
        Assert-WindowAllowedHwnd $targetHwnd $what
    } elseif ($script:SafetyConfig.whitelistEnabled) {
        throw "[WINDOW_NOT_WHITELISTED] $what blocked by active window whitelist: no foreground window is present. (action_sent=false)"
    }
    if (-not [string]::IsNullOrWhiteSpace($chord)) {
        Assert-KeyAllowedUnderWhitelist $chord
    }
}

function Assert-RelativeMoveAllowed([int]$dx, [int]$dy) {
    $pt = New-Object DshNative+POINT
    [void][DshNative]::GetCursorPos([ref]$pt)
    Assert-HudProtectedPoint ($pt.X + $dx) ($pt.Y + $dy) 'relative mouse move'
    if ($script:SafetyConfig.whitelistEnabled) {
        $fg = [DshNative]::GetForegroundWindow()
        Assert-WindowAllowedHwnd $fg 'relative mouse move'
    }
}

function Assert-LaunchAllowed([string]$target, [object]$resolved) {
    if (-not $script:SafetyConfig.whitelistEnabled) { return }
    $rules = @($script:SafetyConfig.rules)
    if ($rules.Count -eq 0) {
        throw "[WINDOW_NOT_WHITELISTED] launch '$target' blocked: active window whitelist is empty. (action_sent=false)"
    }
    $exeName = ''
    try {
        if ($null -ne $resolved -and -not [string]::IsNullOrWhiteSpace("$($resolved.path)")) {
            $exeName = Normalize-ProcessName ([System.IO.Path]::GetFileName("$($resolved.path)"))
        }
    } catch { }
    if ($exeName -eq '') {
        try { $exeName = Normalize-ProcessName ([System.IO.Path]::GetFileName($target)) } catch { $exeName = Normalize-ProcessName $target }
    }
    foreach ($rule in $rules) {
        $rp = Normalize-ProcessName "$($rule.process)"
        if ($rp -ne '' -and ($exeName -eq $rp -or ($rp.Contains('*') -and $exeName -like $rp))) {
            return
        }
    }
    throw "[WINDOW_NOT_WHITELISTED] launch '$target' ($exeName) blocked by active window whitelist. (action_sent=false)"
}
