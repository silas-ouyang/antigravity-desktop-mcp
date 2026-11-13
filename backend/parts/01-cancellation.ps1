# Cooperative cancellation, Win32 Named Event E-Stop wakeup (<1ms), deadline tracking, and delivery checks.
# Loaded early in worker.ps1 before any native/UIA/action parts.

$script:CancelFile = ''
if (-not [string]::IsNullOrWhiteSpace("$($env:AGY_DESKTOP_CANCEL_FILE)")) {
    $script:CancelFile = "$($env:AGY_DESKTOP_CANCEL_FILE)"
} elseif (-not [string]::IsNullOrWhiteSpace("$($env:DSH_COMPUTER_USE_CANCEL_FILE)")) {
    $script:CancelFile = "$($env:DSH_COMPUTER_USE_CANCEL_FILE)"
}

$script:CancelEvent = $null
$script:CancelEventName = ''
if (-not [string]::IsNullOrWhiteSpace("$($env:AGY_DESKTOP_CANCEL_EVENT)")) {
    $script:CancelEventName = "$($env:AGY_DESKTOP_CANCEL_EVENT)"
    try {
        $script:CancelEvent = [System.Threading.EventWaitHandle]::OpenExisting($script:CancelEventName)
    } catch {
        try {
            $script:CancelEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::ManualReset, $script:CancelEventName)
        } catch {
            $script:CancelEvent = $null
        }
    }
}

$script:DeadlineAtMs = [int64]0
$script:SafetyEstopLatched = $false
if ("$($env:AGY_DESKTOP_ESTOP_LATCHED)" -eq '1') {
    $script:SafetyEstopLatched = $true
}

function Get-CancelReasonTag {
    if ($script:SafetyEstopLatched) { return 'ESTOP' }
    if (-not [string]::IsNullOrEmpty($script:CancelFile)) {
        try {
            if ([System.IO.File]::Exists($script:CancelFile)) {
                $raw = [System.IO.File]::ReadAllText($script:CancelFile, [System.Text.Encoding]::UTF8).Trim()
                if ($raw.StartsWith('ESTOP', [System.StringComparison]::OrdinalIgnoreCase)) { return 'ESTOP' }
                return 'CANCELED'
            }
        } catch {
            # Ignore transient file share while writer closes
        }
    }
    if ($null -ne $script:CancelEvent) {
        try {
            if ($script:CancelEvent.WaitOne(0)) { return 'ESTOP' }
        } catch { }
    }
    return ''
}

function Test-CancelRequested {
    if ($script:SafetyEstopLatched) { return $true }
    if ($null -ne $script:CancelEvent) {
        try {
            if ($script:CancelEvent.WaitOne(0)) { return $true }
        } catch { }
    }
    if (-not [string]::IsNullOrEmpty($script:CancelFile)) {
        try {
            if ([System.IO.File]::Exists($script:CancelFile)) { return $true }
        } catch { }
    }
    return $false
}

function Clear-CancelRequest {
    # Intentionally NOT resetting CancelEvent or deleting ESTOP cancelFile from worker.
    # Only the EStopOverlay (on explicit user RESUME) or the Node supervisor (before
    # dispatching a clean non-latched request after settlement) clears cancel signals.
    if ([string]::IsNullOrEmpty($script:CancelFile)) { return }
    try {
        if ([System.IO.File]::Exists($script:CancelFile)) {
            $raw = [System.IO.File]::ReadAllText($script:CancelFile, [System.Text.Encoding]::UTF8).Trim()
            if (-not $raw.StartsWith('ESTOP', [System.StringComparison]::OrdinalIgnoreCase)) {
                # Node already owns file deletion; leave ESTOP untouched
            }
        }
    } catch { }
}

function Assert-NotCancelled([string]$where) {
    $tag = Get-CancelReasonTag
    if ($tag -eq 'ESTOP') {
        throw "[USER_ABORTED] action aborted by user E-Stop ($where; action_sent=unknown). Resume from the floating E-Stop HUD before sending desktop input."
    }
    if ($tag -ne '' -or (Test-CancelRequested)) {
        throw "[CANCELED] action canceled ($where)"
    }
}

function Set-DeadlineAt([int64]$atMs) { $script:DeadlineAtMs = $atMs }

function Clear-Deadline() { $script:DeadlineAtMs = [int64]0 }

function Get-DeadlineRemainingMs {
    if ($script:DeadlineAtMs -le 0) { return [int64](-1) }
    return [int64]($script:DeadlineAtMs - [int64]$script:Clock.ElapsedMilliseconds)
}

function Assert-WithinDeadline([string]$where) {
    if ($script:DeadlineAtMs -le 0) { return }
    $remaining = $script:DeadlineAtMs - [int64]$script:Clock.ElapsedMilliseconds
    if ($remaining -le 0) {
        throw "[DEADLINE_EXHAUSTED] this call's budget ran out $where; nothing further was sent to the desktop, and the steps that already ran did happen. Observe the result with desktop_screenshot or desktop_ui before deciding anything else -- do not repeat this step blindly."
    }
}

function Assert-CanSend([string]$where) {
    Assert-NotCancelled $where
    Assert-WithinDeadline $where
}

function Test-InputDelivery([int]$sent, [int]$expected, [string]$what) {
    if ($expected -le 0 -or $sent -eq $expected) {
        return [ordered]@{
            partial = $false
            sent    = $sent
            needed  = $expected
        }
    }
    if ($sent -le 0) {
        throw "SendInput delivered no input events for $what (sent 0 of $expected; the desktop may be locked, UAC may be active, or the target is at a higher integrity level). (action_sent=false)"
    }
    return [ordered]@{
        partial = $true
        sent    = $sent
        needed  = $expected
        note    = "SendInput delivered only $sent of $expected input events for $what (a UAC prompt, lock screen, or UIPI boundary interrupted the middle of the call)"
    }
}

function Assert-InputDelivered([int]$sent, [int]$expected, [string]$what, [string]$where) {
    $delivery = Test-InputDelivery $sent $expected $what
    if ($delivery.partial) {
        throw "[PARTIAL_INPUT] $($delivery.note) ($where; action_sent=true, outcome=unknown). Do not repeat this step as it stands: some of it is already in the application, so observe the desktop (desktop_screenshot or desktop_ui) and decide from what is actually there."
    }
    return $delivery
}

function Wait-Cancellable([int]$ms, [int]$sliceMs = 100) {
    if ($ms -le 0) { return }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)
    while ($true) {
        Assert-NotCancelled "during a $($ms) ms wait"
        Assert-WithinDeadline "during a $($ms) ms wait"
        $rem = [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if ($rem -le 0) { break }
        $dRem = Get-DeadlineRemainingMs
        if ($dRem -ge 0 -and $dRem -lt $rem) { $rem = [int]$dRem }
        if ($rem -le 0) { Assert-WithinDeadline "during a $($ms) ms wait"; break }
        if ($null -ne $script:CancelEvent) {
            $signaled = $false
            try { $signaled = $script:CancelEvent.WaitOne($rem) } catch { $signaled = $false }
            if ($signaled) {
                Assert-NotCancelled "during a $($ms) ms wait"
            }
        } else {
            $chunk = [Math]::Min($sliceMs, $rem)
            [System.Threading.Thread]::Sleep($chunk)
        }
    }
    Assert-NotCancelled "after a $($ms) ms wait"
    Assert-WithinDeadline "after a $($ms) ms wait"
}
