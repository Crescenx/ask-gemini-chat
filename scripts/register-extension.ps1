param(
  [Parameter(Mandatory)][string]$ManifestFile,
  [Parameter(Mandatory)][string]$OwnerScript,
  [string]$WslLauncherFile
)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json
if ($manifest.name -ne 'com.ask_gemini_chat.auth') { throw 'INVALID_NATIVE_HOST_NAME' }
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.ask_gemini_chat.auth'
# Keep an existing checkout authoritative; only migrate our own launcher.
if (Test-Path $key) {
  $existingPath = (Get-Item $key).GetValue('')
  if ($existingPath -ne $ManifestFile) {
    $existing = Get-Content -LiteralPath $existingPath -Raw | ConvertFrom-Json
    $launcher = Get-Content -LiteralPath $existing.path -Raw
    if (!$launcher.Contains($OwnerScript)) { throw 'NATIVE_HOST_OWNED_BY_OTHER_CHECKOUT' }
  }
}
if ($WslLauncherFile) {
  $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($OwnerScript))).Substring(0,16)
  $directory = Join-Path $env:LOCALAPPDATA "ask-gemini-chat\$hash"
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $manifest.path = Join-Path $directory 'host.cmd'
  Copy-Item -LiteralPath $WslLauncherFile -Destination $manifest.path -Force
  $ManifestFile = Join-Path $directory 'com.ask_gemini_chat.auth.json'
  [IO.File]::WriteAllText($ManifestFile, ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $ManifestFile
Write-Output 'Native messaging registered for the current user'
