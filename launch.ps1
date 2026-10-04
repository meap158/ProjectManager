# Starts ProjectManager. Same as: npm run launch
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
node scripts/launch.mjs @args
exit $LASTEXITCODE
