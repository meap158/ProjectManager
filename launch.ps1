# Starts ProjectManager. Same as: npm run launch
$Host.UI.RawUI.WindowTitle = 'ProjectManager'
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
node scripts/launch.mjs @args
exit $LASTEXITCODE
