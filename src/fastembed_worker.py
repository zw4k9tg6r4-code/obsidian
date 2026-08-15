import json
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np
from fastembed import TextEmbedding


MODEL = "BAAI/bge-small-zh-v1.5"


def read_request():
    return json.load(sys.stdin)


def model_for(request):
    cache_dir = Path(request["dataDir"]) / "models" / "fastembed"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return TextEmbedding(model_name=MODEL, cache_dir=str(cache_dir), threads=4)


def initialize(db_path):
    connection = sqlite3.connect(db_path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS chunks (
          id TEXT PRIMARY KEY,
          source_path TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          title TEXT NOT NULL,
          collections TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          dimensions INTEGER NOT NULL,
          embedding BLOB NOT NULL
        )
        """
    )
    connection.execute("CREATE INDEX IF NOT EXISTS idx_chunks_relative ON chunks(relative_path)")
    return connection


def embed_documents(model, texts):
    if hasattr(model, "passage_embed"):
        return list(model.passage_embed(texts, batch_size=16))
    return list(model.embed(texts, batch_size=16))


def embed_query(model, query):
    if hasattr(model, "query_embed"):
        return list(model.query_embed([query]))[0]
    return list(model.embed([query]))[0]


def index(request):
    records = request["records"]
    model = model_for(request)
    vectors = embed_documents(model, [record["text"] for record in records])
    connection = initialize(request["dbPath"])
    try:
        with connection:
            connection.execute("DELETE FROM chunks")
            for record, vector in zip(records, vectors):
                array = np.asarray(vector, dtype=np.float32)
                connection.execute(
                    """INSERT INTO chunks
                    (id, source_path, relative_path, title, collections, source_hash,
                     chunk_index, start_line, end_line, dimensions, embedding)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        record["id"], record["sourcePath"], record["relativePath"],
                        record["title"], json.dumps(record["collections"], ensure_ascii=False),
                        record["sourceHash"], record["chunkIndex"], record["startLine"],
                        record["endLine"], int(array.shape[0]), array.tobytes(),
                    ),
                )
    finally:
        connection.close()
    return {"ok": True, "model": MODEL, "chunks": len(records), "dimensions": int(vectors[0].shape[0]) if vectors else 0}


def search(request):
    model = model_for(request)
    query_vector = np.asarray(embed_query(model, request["query"]), dtype=np.float32)
    allowed = set(request["collectionNames"])
    connection = sqlite3.connect(request["dbPath"])
    try:
        rows = connection.execute(
            "SELECT source_path, relative_path, title, collections, source_hash, chunk_index, start_line, end_line, dimensions, embedding FROM chunks"
        ).fetchall()
    finally:
        connection.close()

    scored = []
    for row in rows:
        memberships = set(json.loads(row[3]))
        if not memberships.intersection(allowed):
            continue
        vector = np.frombuffer(row[9], dtype=np.float32, count=row[8])
        denominator = float(np.linalg.norm(query_vector) * np.linalg.norm(vector))
        score = float(np.dot(query_vector, vector) / denominator) if denominator else 0.0
        scored.append({
            "filepath": row[0],
            "displayPath": row[1],
            "title": row[2],
            "hash": row[4],
            "chunkIndex": row[5],
            "lineStartHint": row[6],
            "lineEndHint": row[7],
            "score": score,
            "source": "vec",
        })
    scored.sort(key=lambda item: item["score"], reverse=True)
    return {"ok": True, "model": MODEL, "results": scored[: int(request.get("limit", 20))]}


def main():
    request = read_request()
    if request["action"] == "index":
        response = index(request)
    elif request["action"] == "search":
        response = search(request)
    elif request["action"] == "probe":
        model = model_for(request)
        vector = embed_query(model, "本地语义检索健康检查")
        response = {"ok": True, "model": MODEL, "dimensions": int(vector.shape[0])}
    else:
        raise ValueError(f"Unknown action: {request['action']}")
    json.dump(response, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        raise

