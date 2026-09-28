param([ValidateSet('protect','unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $inputText = [Console]::In.ReadToEnd()
  if ($Mode -eq 'protect') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($inputText)
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($result))
  } else {
    $bytes = [Convert]::FromBase64String($inputText.Trim())
    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))
  }
} catch {
  [Console]::Error.Write('CALENDAR_CREDENTIAL_UNAVAILABLE')
  exit 1
}
