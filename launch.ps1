# Starts ProjectManager. Same as: npm run launch
$Host.UI.RawUI.WindowTitle = 'ProjectManager - Server'
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
node scripts/launch.mjs @args
exit $LASTEXITCODE
