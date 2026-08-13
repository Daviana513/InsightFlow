import csv
import tempfile
import unittest
from pathlib import Path

from agent.server import PUBLIC_SITE_ORIGIN, State, inspect_project, training_readiness, trusted_origin


class LocalAgentTest(unittest.TestCase):
    def test_training_button_gate_requires_both_classes_and_distinct_posts(self):
        ready = training_readiness(
            {"infographic": 20, "not_infographic": 20},
            {"infographic": 5, "not_infographic": 5},
        )
        self.assertTrue(ready["ready"])
        not_ready = training_readiness(
            {"infographic": 20, "not_infographic": 19},
            {"infographic": 5, "not_infographic": 4},
        )
        self.assertFalse(not_ready["ready"])
        self.assertEqual(not_ready["missing_images"]["not_infographic"], 1)
        self.assertEqual(not_ready["missing_posts"]["not_infographic"], 1)

    def test_only_local_pages_and_the_official_site_are_trusted(self):
        self.assertEqual(trusted_origin(PUBLIC_SITE_ORIGIN), PUBLIC_SITE_ORIGIN)
        self.assertEqual(trusted_origin("http://localhost:3000"), "http://localhost:3000")
        self.assertIsNone(trusted_origin("https://example.com"))

    def test_project_run_and_review_are_persisted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = root / "images"
            images.mkdir()
            (images / "one.jpg").write_bytes(b"sample")
            metadata = root / "source.csv"
            with metadata.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=["record_id", "image_path", "caption"])
                writer.writeheader()
                writer.writerow({"record_id": "1", "image_path": "one.jpg", "caption": "demo"})

            inspected = inspect_project(str(images), str(metadata))
            self.assertTrue(inspected["ready"])
            self.assertEqual(inspected["image_count"], 1)
            self.assertEqual(inspected["record_count"], 1)

            state = State()
            state.open_project(str(images), str(metadata))
            run = state.create_run(0.1)
            self.assertEqual(run["status"], "ready")
            preprocessed = state.preprocess_run(run["id"])
            self.assertEqual(preprocessed["run"]["stage"], "openclip")
            self.assertEqual(preprocessed["summary"]["passed"], 1)
            self.assertEqual(state.openclip_summary(run["id"])["summary"]["scored"], 0)
            self.assertTrue(state.save_training_label({"record_id": "1", "label": "infographic"})["saved"])
            candidates = state.list_training_candidates(run["id"])
            self.assertEqual(candidates["items"][0]["label"], "infographic")
            self.assertFalse(candidates["readiness"]["ready"])
            with state.connect() as db:
                db.execute(
                    "UPDATE records SET clip_probability = 0.75, clip_status = 'scored' WHERE run_id = ?",
                    (run["id"],),
                )
            summary = state.openclip_summary(run["id"])["summary"]
            self.assertEqual(summary["scored"], 1)
            self.assertEqual(summary["candidates"], 1)
            self.assertEqual(state.update_run(run["id"], "running")["status"], "running")
            self.assertTrue(state.save_review({
                "run_id": run["id"], "record_id": "1", "stage": "human", "decision": "keep"
            })["saved"])
            task = state.create_review_task({"name": "AI 关键词复核", "template": "ai_keyword"})
            self.assertEqual(task["total"], 1)
            page = state.get_review_item(task["id"], 0, "all")
            self.assertEqual(page["item"]["rows"][0]["record_id"], "1")
            saved = state.save_review_item(task["id"], "1", {"decision": "no_evidence", "note": "人工确认"})
            self.assertEqual(saved["reviewed"], 1)
            filename, exported = state.export_review_task(task["id"])
            self.assertIn("reviewed.csv", filename)
            self.assertIn("no_evidence", exported.decode("utf-8"))

    def test_instagram_carousel_fields_form_a_stable_record_id(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = root / "images"
            images.mkdir()
            (images / "slide.jpg").write_bytes(b"sample")
            metadata = root / "source.csv"
            with metadata.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=["post_shortcode", "image_index", "image_path"])
                writer.writeheader()
                writer.writerow({"post_shortcode": "ABC123", "image_index": "2", "image_path": "slide.jpg"})

            inspected = inspect_project(str(images), str(metadata))
            self.assertTrue(inspected["ready"])
            self.assertEqual(inspected["mapping"]["record_id"], "post_shortcode + image_index")


if __name__ == "__main__":
    unittest.main()
