"""A long text template must not qualify missing or stale visual source evidence."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from prepare_pdf_visual_evidence import add_visual_evidence, digest, qualify_visual_review


class VisualEvidenceBoundary(unittest.TestCase):
    def test_long_template_still_requires_rendered_ocr_and_exact_complete_review(self):
        import pymupdf

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "mixed.pdf"
            with pymupdf.open() as document:
                page = document.new_page()
                page.insert_text((30, 30), "Template label " * 20)
                page.draw_rect(pymupdf.Rect(30, 50, 100, 70))
                document.save(source)
            template = "Template labels without filled answers " * 100
            original = {"file": source.name, "sha256": digest(source.read_bytes()),
                        "pages": [{"page": 1, "text": template, "formValues": []}]}
            from subprocess import CompletedProcess
            with patch("prepare_pdf_visual_evidence.subprocess.run", side_effect=[
                CompletedProcess([], 0, stdout="tesseract test\n"),
                CompletedProcess([], 0, stdout="Visible source content\n"),
            ]) as runner:
                prepared = add_visual_evidence(source, original, directory)
            self.assertEqual(runner.call_count, 2)
            self.assertEqual(prepared["pages"][0]["text"], template)
            self.assertTrue(prepared["pages"][0]["needsVisualReview"])
            self.assertNotIn("visualReview", prepared)
            review = {"sourceSha256": prepared["sha256"], "pages": [{"page": 1, "reviewed": True,
                **{key: prepared["pages"][0]["visualExtraction"][key] for key in ["renderedPageSha256", "textSha256"]}}]}
            self.assertEqual(qualify_visual_review(prepared, review)["visualReview"]["status"], "reviewed")
            for bad in [{**review, "pages": []}, {**review, "sourceSha256": "wrong"}]:
                with self.assertRaises(ValueError): qualify_visual_review(prepared, bad)
            changed = copy.deepcopy(prepared)
            changed["pages"][0]["visualText"] = "Changed OCR"
            with self.assertRaises(ValueError): qualify_visual_review(changed, review)
            self.assertNotIn("visualText", original["pages"][0])


if __name__ == "__main__":
    unittest.main()
