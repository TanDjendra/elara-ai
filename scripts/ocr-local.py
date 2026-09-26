"""Bounded, local OCR worker. Input bytes arrive on stdin; no source file is kept."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import sys

MAX_BYTES = 25 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_OUTPUT_CHARS = 30_000
MAX_PDF_PAGES = 12


def _engine():
    from rapidocr import RapidOCR

    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return RapidOCR()


def _recognize(engine, image) -> str:
    import numpy as np

    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = engine(np.asarray(image.convert("RGB")))
    lines = result.txts or ()
    return "\n".join(line for line in lines if isinstance(line, str)).strip()[:MAX_OUTPUT_CHARS]


def _image(data: bytes, engine) -> dict:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    with Image.open(io.BytesIO(data)) as source:
        if source.width * source.height > MAX_IMAGE_PIXELS:
            raise ValueError("OCR_IMAGE_TOO_LARGE")
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((3200, 3200))
        return {"text": _recognize(engine, image)}


def _pdf(data: bytes, engine, pages: list[int]) -> dict:
    import pymupdf
    from PIL import Image

    if not pages or len(pages) > MAX_PDF_PAGES or len(set(pages)) != len(pages):
        raise ValueError("OCR_PAGES_INVALID")
    output = []
    with pymupdf.open(stream=data, filetype="pdf") as document:
        if document.needs_pass:
            raise ValueError("OCR_PDF_LOCKED")
        for number in pages:
            if number < 1 or number > document.page_count or number > 50:
                raise ValueError("OCR_PAGES_INVALID")
            page = document[number - 1]
            scale = 2.0
            if page.rect.width * page.rect.height * scale * scale > 8_000_000:
                scale = math.sqrt(8_000_000 / (page.rect.width * page.rect.height))
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            if pixmap.width * pixmap.height > MAX_IMAGE_PIXELS:
                raise ValueError("OCR_IMAGE_TOO_LARGE")
            image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
            output.append({"page": number, "text": _recognize(engine, image)})
    return {"pages": output}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=("image", "pdf"), required=True)
    parser.add_argument("--pages", default="")
    args = parser.parse_args()
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if not data or len(data) > MAX_BYTES:
        raise ValueError("OCR_INPUT_INVALID")
    engine = _engine()
    if args.kind == "image":
        output = _image(data, engine)
    else:
        if not args.pages or not all(item.isascii() and item.isdecimal() for item in args.pages.split(",")):
            raise ValueError("OCR_PAGES_INVALID")
        output = _pdf(data, engine, [int(item) for item in args.pages.split(",")])
    sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # Never print document text, paths, or raw library exceptions.
        sys.stderr.write("OCR_FAILED\n")
        raise SystemExit(1)
