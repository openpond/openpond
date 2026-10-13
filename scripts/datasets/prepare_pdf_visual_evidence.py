"""Add source-derived rendered-page OCR to a PDF's existing text/widget evidence.

Every page is rendered, including pages with substantial extractable text. That
text may contain only the template while filled answers are painted as paths or
images. Output remains unqualified until a review binds each exact raster/text.
This offline authoring tool never reads task answers, fixtures or verifiers.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess


def digest(data):
    return hashlib.sha256(data).hexdigest()


def add_visual_evidence(source, existing, output_directory, tesseract="tesseract"):
    import pymupdf

    source = Path(source)
    raw = source.read_bytes()
    if existing.get("sha256") != digest(raw) or existing.get("file") != source.name:
        raise ValueError("Prepared evidence does not bind the supplied PDF bytes/name")
    result = copy.deepcopy(existing)
    directory = Path(output_directory)
    directory.mkdir(parents=True, exist_ok=True)
    engine = subprocess.run([tesseract, "--version"], check=True, capture_output=True, text=True).stdout.splitlines()[0]
    with pymupdf.open(stream=raw, filetype="pdf") as document:
        if document.is_encrypted:
            raise ValueError("Encrypted source requires an authorized decrypted input")
        expected_pages = list(range(1, len(document) + 1))
        if [page.get("page") for page in result.get("pages", [])] != expected_pages:
            raise ValueError("Prepared evidence omits or duplicates PDF pages")
        for pdf_page, page in zip(document, result["pages"]):
            raster = pdf_page.get_pixmap(dpi=300, alpha=False).tobytes("png")
            raster_path = directory / f"page-{page['page']}.png"
            raster_path.write_bytes(raster)
            text = subprocess.run(
                [tesseract, str(raster_path), "stdout", "-l", "eng", "--dpi", "300", "--psm", "6"],
                check=True, capture_output=True, text=True, timeout=120,
            ).stdout
            if not text.strip():
                raise ValueError(f"Rendered page {page['page']} has no OCR evidence; visual review required")
            page["visualText"] = text
            page["visualExtraction"] = {
                "engine": engine, "renderer": f"PyMuPDF {pymupdf.VersionBind}",
                "dpi": 300, "pageSegmentationMode": 6,
                "renderedPageSha256": digest(raster), "textSha256": digest(text.encode()),
            }
            page["needsVisualReview"] = True
    result["pageCount"] = len(result["pages"])
    result["preparationVersion"] = "pdf-rendered-ocr-v1"
    result.pop("visualReview", None)
    return result


def qualify_visual_review(evidence, review):
    """Reject stale/partial review; text length never substitutes for visual QA."""
    result = copy.deepcopy(evidence)
    if review.get("sourceSha256") != result.get("sha256"):
        raise ValueError("Visual review belongs to different source bytes")
    pages = result.get("pages", [])
    reviewed = review.get("pages", [])
    if not pages or [row.get("page") for row in reviewed] != [page["page"] for page in pages]:
        raise ValueError("Visual review must cover every page once in order")
    for page, row in zip(pages, reviewed):
        visual = page.get("visualExtraction", {})
        text = page.get("visualText", "")
        if (not visual or not text.strip() or row.get("reviewed") is not True
                or row.get("renderedPageSha256") != visual.get("renderedPageSha256")
                or row.get("textSha256") != visual.get("textSha256")
                or digest(text.encode()) != visual.get("textSha256")):
            raise ValueError(f"Page {page['page']} lacks review of its exact rendered OCR evidence")
        page["needsVisualReview"] = False
    result["visualReview"] = {"status": "reviewed", "reviewHash": digest(json.dumps(review, sort_keys=True).encode())}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--output-directory", required=True)
    parser.add_argument("--tesseract", default="tesseract")
    parser.add_argument("--review", help="Review manifest of the exact generated page/text hashes")
    args = parser.parse_args()
    output = Path(args.output_directory)
    evidence = add_visual_evidence(args.source, json.loads(Path(args.evidence).read_text()), output, args.tesseract)
    if args.review:
        evidence = qualify_visual_review(evidence, json.loads(Path(args.review).read_text()))
    (output / "evidence.json").write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"sourceSha256": evidence["sha256"], "pages": len(evidence["pages"]),
                      "reviewed": evidence.get("visualReview", {}).get("status") == "reviewed"}))


if __name__ == "__main__":
    main()
