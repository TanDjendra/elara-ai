$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$venv = Join-Path $workspace '.runtime\document-tools-venv'
$python = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  python -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the local document environment' }
}
& $python -m pip install --disable-pip-version-check --no-input -r (Join-Path $PSScriptRoot 'document-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install local document dependencies' }
& $python -c 'import docx, pymupdf, openpyxl; print("ELARA document tools ready")'
if ($LASTEXITCODE -ne 0) { throw 'Local document dependencies could not be imported' }
