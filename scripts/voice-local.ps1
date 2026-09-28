param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $text = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 900) { throw 'VOICE_TEXT_INVALID' }
  $speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $speech.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female)
    $speech.SetOutputToWaveFile($OutputPath)
    $speech.Speak($text)
  } finally { $speech.Dispose() }
} catch {
  [Console]::Error.Write('VOICE_LOCAL_FAILED')
  exit 1
}
