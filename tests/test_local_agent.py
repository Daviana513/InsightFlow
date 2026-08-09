import csv
import tempfile
import unittest
from pathlib import Path

from agent.server import State, inspect_project


class LocalAgentTest(unittest.TestCase):
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
            self.assertEqual(state.update_run(run["id"], "running")["status"], "running")
            self.assertTrue(state.save_review({
                "run_id": run["id"], "record_id": "1", "stage": "human", "decision": "keep"
            })["saved"])


if __name__ == "__main__":
    unittest.main()
