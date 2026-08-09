#!/usr/bin/env python3
"""Train a grouped OpenCLIP image classifier from reviewed local images."""

from __future__ import annotations

import argparse
import csv
import json
import shutil
from pathlib import Path

from openclip_runner import MODEL_NAME, MODEL_WEIGHTS, device_name, emit


def metric_block(y_true, probabilities, threshold: float) -> dict:
    from sklearn.metrics import accuracy_score, precision_recall_fscore_support

    predictions = (probabilities >= threshold).astype(int)
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_true, predictions, average="binary", zero_division=0
    )
    return {
        "threshold": threshold,
        "accuracy": round(float(accuracy_score(y_true, predictions)), 4),
        "precision": round(float(precision), 4),
        "recall": round(float(recall), 4),
        "f1": round(float(f1), 4),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    args = parser.parse_args()

    import joblib
    import numpy as np
    import open_clip
    import torch
    from PIL import Image
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import confusion_matrix, roc_auc_score
    from sklearn.model_selection import StratifiedGroupKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    with args.input.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    labels = np.array([1 if row["label"] == "infographic" else 0 for row in rows], dtype=int)
    groups = np.array([row["post_shortcode"] for row in rows])
    if len(set(labels)) != 2:
        raise ValueError("训练集必须同时包含信息图和非信息图")

    device = device_name(args.device)
    emit(type="status", message="正在载入 OpenCLIP 图像编码器", processed=0, total=len(rows), device=device)
    model, _, preprocess = open_clip.create_model_and_transforms(
        MODEL_NAME, pretrained=MODEL_WEIGHTS, device=device
    )
    model.eval()
    embeddings = []
    processed = 0
    for start in range(0, len(rows), args.batch_size):
        batch = rows[start:start + args.batch_size]
        tensors = []
        for row in batch:
            with Image.open(row["image_path"]) as image:
                tensors.append(preprocess(image.convert("RGB")))
        with torch.no_grad():
            features = model.encode_image(torch.stack(tensors).to(device)).float()
            features = features / features.norm(dim=-1, keepdim=True)
        embeddings.append(features.cpu().numpy().astype(np.float32, copy=False))
        processed += len(batch)
        emit(
            type="progress",
            message=f"正在提取图片特征：{processed} / {len(rows)}",
            processed=processed,
            total=len(rows),
        )
    features = np.concatenate(embeddings)

    splitter = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=42)
    folds = list(splitter.split(features, labels, groups))
    test_indices = folds[0][1]
    validation_indices = folds[1][1]
    train_indices = np.concatenate([folds[index][1] for index in range(2, 5)])
    for name, indices in (("训练", train_indices), ("验证", validation_indices), ("测试", test_indices)):
        if len(set(labels[indices])) != 2:
            raise ValueError(f"{name}集缺少一个类别，请增加来自不同帖子的标注图片")

    emit(type="status", message="正在训练分类器并评估", processed=len(rows), total=len(rows))
    classifier = make_pipeline(
        StandardScaler(),
        LogisticRegression(
            class_weight="balanced", solver="liblinear", C=0.3, max_iter=2000, random_state=42
        ),
    )
    classifier.fit(features[train_indices], labels[train_indices])
    probabilities = classifier.predict_proba(features[test_indices])[:, 1]
    test_labels = labels[test_indices]
    metrics = {
        "model_version": args.version,
        "embedding_model": f"{MODEL_NAME}:{MODEL_WEIGHTS}",
        "sample_counts": {
            "labeled_images": len(rows),
            "positive_images": int(labels.sum()),
            "negative_images": int((labels == 0).sum()),
            "train_images": len(train_indices),
            "validation_images": len(validation_indices),
            "test_images": len(test_indices),
        },
        "test_metrics_at_0_50": metric_block(test_labels, probabilities, 0.5),
        "test_metrics_at_0_10": metric_block(test_labels, probabilities, 0.1),
        "roc_auc": round(float(roc_auc_score(test_labels, probabilities)), 4),
        "confusion_matrix_at_0_50": confusion_matrix(test_labels, probabilities >= 0.5).tolist(),
    }

    args.output_dir.mkdir(parents=True, exist_ok=False)
    joblib.dump(classifier, args.output_dir / "infographic_classifier.pkl")
    (args.output_dir / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    shutil.copyfile(args.input, args.output_dir / "training_manifest.csv")
    emit(type="complete", processed=len(rows), total=len(rows), metrics=metrics)


if __name__ == "__main__":
    main()
