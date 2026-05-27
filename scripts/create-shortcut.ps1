# Creates a branded Speakflow desktop shortcut with the correct icon.
# Run once from the Speakflow Electrofile root: powershell -File scripts\create-shortcut.ps1

$root    = Split-Path -Parent $PSScriptRoot
$cmdPath = Join-Path $root "launch-speakflow.cmd"
$icoPath = Join-Path $root "assets\icon.ico"
$lnkPath = "$env:USERPROFILE\Desktop\Speakflow.lnk"

if (-not (Test-Path $cmdPath)) {
    Write-Error "launch-speakflow.cmd not found at: $cmdPath"
    exit 1
}
if (-not (Test-Path $icoPath)) {
    Write-Error "icon.ico not found at: $icoPath. Run 'npm run build' first."
    exit 1
}

$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath       = "C:\Windows\System32\cmd.exe"
$lnk.Arguments        = "/c `"$cmdPath`""
$lnk.IconLocation     = "$icoPath,0"
$lnk.WorkingDirectory = $root
$lnk.WindowStyle      = 7   # 7 = minimised (hides the cmd window flash)
$lnk.Save()

Write-Host "Shortcut created: $lnkPath"
