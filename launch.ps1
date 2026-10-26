# Starts ProjectManager. Same as: npm run launch
# When something outside ends the launcher (Stop-Process leaves exit code -1), it is started again,
# up to 10 times: another project's cleanup once matched every "launch.mjs" on the machine (PM-332).
# A normal exit, Ctrl+C or a failed start (exit code 1) ends here as before.
$Host.UI.RawUI.WindowTitle = 'ProjectManager'
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$restarts = 0
while ($true) {
  node scripts/launch.mjs @args
  $code = $LASTEXITCODE
  if ($code -ne -1 -or $restarts -ge 10) { exit $code }
  $restarts++
  Write-Host "[launch] The launcher was ended from outside (exit code -1). Starting it again ($restarts/10)..."
  # The old server stops itself within a few seconds once its launcher is gone.
  Start-Sleep -Seconds 5
}
