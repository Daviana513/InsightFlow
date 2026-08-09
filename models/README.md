# Local classifier model

InsightFlow expects the active English classifier at:

`.models/en_infographic_v3_balanced/infographic_classifier.pkl`

The `.models` directory is intentionally excluded from Git because a joblib model is a local executable artifact. Only use a classifier you trained or trust. Its matching `metrics.json` can be placed beside it.
