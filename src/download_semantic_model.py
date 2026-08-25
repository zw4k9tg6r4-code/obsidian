import argparse
import json
from pathlib import Path

from fastembed import TextEmbedding


MODEL = "BAAI/bge-small-zh-v1.5"
EXPECTED_DIMENSIONS = 512


def embed_one(model, text):
    return next(iter(model.embed([text], batch_size=1)))


def main():
    parser = argparse.ArgumentParser(description="Download and verify the pinned local semantic model.")
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--accept-model-download", action="store_true")
    args = parser.parse_args()

    if not args.accept_model_download:
        raise PermissionError("Explicit --accept-model-download consent is required.")

    cache_dir = Path(args.cache_dir).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)

    online_model = TextEmbedding(
        model_name=MODEL,
        cache_dir=str(cache_dir),
        threads=4,
        local_files_only=False,
    )
    online_dimensions = len(embed_one(online_model, "中文语义模型下载校验"))
    if online_dimensions != EXPECTED_DIMENSIONS:
        raise ValueError(f"Unexpected semantic dimensions: {online_dimensions}")

    offline_model = TextEmbedding(
        model_name=MODEL,
        cache_dir=str(cache_dir),
        threads=4,
        local_files_only=True,
    )
    offline_dimensions = len(embed_one(offline_model, "中文语义模型离线校验"))
    if offline_dimensions != EXPECTED_DIMENSIONS:
        raise ValueError(f"Offline semantic verification failed: {offline_dimensions}")

    print(json.dumps({
        "ok": True,
        "model": MODEL,
        "dimensions": offline_dimensions,
        "offlineVerified": True,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
