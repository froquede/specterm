# A program that grabs the mouse and records what the terminal sends it.
#
# The e2e suite's POSIX recorder is `printf` + `stty raw` + `cat`, none of which
# PowerShell has. The console also hides mouse reports from a program that
# hasn't asked for them: ConPTY only hands the escape sequences through as input
# once the program switches on virtual-terminal input, which is what this does
# before reading.
#
# The log is created before anything is printed, so the harness can wait for it
# to exist instead of guessing how long PowerShell takes to start.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File mouse-recorder.ps1 <log> <seconds> [motion]
param([string]$Log, [int]$Seconds = 2, [string]$Motion = "")

Add-Type -Namespace SpectermE2E -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
'@

$modes = if ($Motion -eq "motion") { 1000, 1002, 1003, 1006 } else { 1000, 1002, 1006 }
$esc = [char]27
$set = { param($flag) ($modes | ForEach-Object { "$esc[?$_$flag" }) -join "" }

$stdin = [SpectermE2E.Console]::GetStdHandle(-10)
$saved = 0
[void][SpectermE2E.Console]::GetConsoleMode($stdin, [ref]$saved)
# ENABLE_VIRTUAL_TERMINAL_INPUT alone: no line editing, no echo, no Ctrl+C handling.
[void][SpectermE2E.Console]::SetConsoleMode($stdin, 0x200)

[IO.File]::WriteAllText($Log, "")
[Console]::Write("$esc[2J$esc[H" + (& $set "h") + "GRAB_MARKER`r`n")

$seen = New-Object System.Text.StringBuilder
$end = (Get-Date).AddSeconds($Seconds)
try {
  while ((Get-Date) -lt $end) {
    $got = $false
    while ([Console]::KeyAvailable) {
      [void]$seen.Append([Console]::ReadKey($true).KeyChar)
      $got = $true
    }
    if ($got) { [IO.File]::WriteAllText($Log, $seen.ToString()) }
    Start-Sleep -Milliseconds 20
  }
} finally {
  [Console]::Write((& $set "l"))
  [void][SpectermE2E.Console]::SetConsoleMode($stdin, $saved)
}
