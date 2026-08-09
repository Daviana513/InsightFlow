#!/usr/bin/env python3
"""Score a local image manifest with OpenCLIP and a saved classifier."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


MODEL_NAME = "ViT-B-32"
MODEL_WEIGHTS = "laion2b_s34b_b79k"


def emit(**payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def device_name(requested: str) -> str:
    import torch

    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--classifier", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    args = parser.parse_args()

    import joblib
    import numpy as np
    import open_clip
    import torch
    from PIL import Image

    with args.input.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    device = device_name(args.device)
    emit(type="status", message="正在载入 OpenCLIP 模型", device=device, total=len(rows))
    model, _, preprocess = open_clip.create_model_and_transforms(
        MODEL_NAME, pretrained=MODEL_WEIGHTS, device=device
    )
    classifier = joblib.load(args.classifier)
    model.eval()
    processed = 0

    for start in range(0, len(rows), args.batch_size):
        batch_rows = rows[start:start + args.batch_size]
        tensors = []
        valid_rows = []
        results = []
        for row in batch_rows:
            try:
                with Image.open(row["image_path"]) as image:
                    tensors.append(preprocess(image.convert("RGB")))
                valid_rows.append(row)
            except Exception as error:
                results.append({"record_id": row["record_id"], "error": f"{type(error).__name__}: {error}"})
                processed += 1
        if tensors:
            with torch.no_grad():
                features = model.encode_image(torch.stack(tensors).to(device)).float()
                features = features / features.norm(dim=-1, keepdim=True)
            probabilities = classifier.predict_proba(features.cpu().numpy().astype(np.float32, copy=False))[:, 1]
            for row, probability in zip(valid_rows, probabilities):
                results.append({"record_id": row["record_id"], "probability": round(float(probability), 8)})
                processed += 1
        emit(type="batch", items=results, processed=processed, total=len(rows))

    emit(type="complete", processed=processed, total=len(rows))


if __name__ == "__main__":
    main()
