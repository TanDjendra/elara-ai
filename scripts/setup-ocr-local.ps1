$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$python = Join-Path $workspace '.runtime\document-tools-venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  & (Join-Path $PSScriptRoot 'setup-documents-local.ps1')
}
& $python -m pip install --disable-pip-version-check --no-input -r (Join-Path $PSScriptRoot 'ocr-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install local OCR dependencies' }
& $python -c 'from rapidocr import RapidOCR; import onnxruntime, pymupdf; RapidOCR(); print("ELARA local OCR ready")'
if ($LASTEXITCODE -ne 0) { throw 'Local OCR models could not be loaded' }
