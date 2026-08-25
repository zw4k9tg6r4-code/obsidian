import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
from fastembed import TextEmbedding

MODEL = "BAAI/bge-small-zh-v1.5"


def read_request():
    return json.load(sys.stdin)


def model_for(request):
    cache_dir = Path(request["dataDir"]) / "models" / "fastembed"
    if not cache_dir.exists() and os.environ.get("LOCALAPPDATA"):
        default_cache = Path(os.environ["LOCALAPPDATA"]) / "CodexSecondBrain" / "models" / "fastembed"
        if default_cache.exists():
            cache_dir = default_cache
    return TextEmbedding(model_name=MODEL, cache_dir=str(cache_dir), threads=4, local_files_only=True)


def safe_checkpoint(connection, mode="TRUNCATE"):
    try:
        row = connection.execute(f"PRAGMA wal_checkpoint({mode})").fetchone()
        if row:
            return {"busy": bool(row[0]), "log": int(row[1]), "checkpointed": int(row[2])}
        return {"busy": False, "log": 0, "checkpointed": 0}
    except Exception as exc:
        return {"busy": True, "error": str(exc)}


def initialize(db_path):
    connection = sqlite3.connect(db_path, timeout=30.0)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    connection.execute("PRAGMA busy_timeout = 30000")
    connection.execute("PRAGMA wal_autocheckpoint = 1000")
    try:
        connection.execute("PRAGMA mmap_size = 268435456")
    except Exception:
        pass

    table_info = connection.execute("PRAGMA table_info(chunks)").fetchall()
    if table_info:
        column_names = {row[1] for row in table_info}
        if "chunk_text_hash" not in column_names:
            connection.execute("ALTER TABLE chunks ADD COLUMN chunk_text_hash TEXT DEFAULT ''")
    else:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS chunks (
              id TEXT PRIMARY KEY,
              source_path TEXT NOT NULL,
              relative_path TEXT NOT NULL,
              title TEXT NOT NULL,
              collections TEXT NOT NULL,
              source_hash TEXT NOT NULL,
              chunk_text_hash TEXT NOT NULL,
              chunk_index INTEGER NOT NULL,
              start_line INTEGER NOT NULL,
              end_line INTEGER NOT NULL,
              dimensions INTEGER NOT NULL,
              embedding BLOB NOT NULL
            )
            """
        )
    connection.execute("CREATE INDEX IF NOT EXISTS idx_chunks_relative ON chunks(relative_path)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_chunks_source_hash ON chunks(source_hash)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_chunks_text_hash ON chunks(chunk_text_hash)")
    return connection


def embed_documents(model, texts):
    if hasattr(model, "passage_embed"):
        return list(model.passage_embed(texts, batch_size=16))
    return list(model.embed(texts, batch_size=16))


def embed_query(model, query):
    if hasattr(model, "query_embed"):
        return list(model.query_embed([query]))[0]
    return list(model.embed([query]))[0]


def sync(request):
    records = request["records"]
    budget_ms = float(request.get("budgetMs", 10000))
    mode = request.get("mode", "auto")
    synced_collections = set(request.get("syncedCollections", []))

    connection = initialize(request["dbPath"])
    try:
        existing_rows = connection.execute(
            "SELECT id, chunk_text_hash, source_hash, relative_path, dimensions, embedding FROM chunks"
        ).fetchall()
        existing_map = {row[0]: row for row in existing_rows}

        # Build text hash cache to reuse embeddings on renamed files or moved chunks
        cached_by_text_hash = {}
        for row in existing_rows:
            th = row[1]
            if th and th not in cached_by_text_hash:
                cached_by_text_hash[th] = (row[4], row[5])  # (dim, blob)

        needed_embed = []
        reused = []
        reused_by_hash = []
        for rec in records:
            if rec["id"] in existing_map:
                reused.append(rec)
            elif rec.get("chunkTextHash") and rec["chunkTextHash"] in cached_by_text_hash:
                dim_cached, blob_cached = cached_by_text_hash[rec["chunkTextHash"]]
                reused_by_hash.append((rec, dim_cached, blob_cached))
            else:
                needed_embed.append(rec)

        embedded_records = []
        pending_records = []
        dim = existing_rows[0][4] if existing_rows else 0

        if mode == "never":
            pending_records = needed_embed
        else:
            model = None
            start_time = time.perf_counter()
            deadline = start_time + (budget_ms / 1000.0)

            if mode == "auto" and budget_ms < 500:
                pending_records = needed_embed
            else:
                cursor = 0
                avg_time_per_item = 0.05
                while cursor < len(needed_embed):
                    now = time.perf_counter()
                    remaining = deadline - now
                    if mode == "auto" and remaining <= 0:
                        pending_records.extend(needed_embed[cursor:])
                        break

                    batch_size = min(16, len(needed_embed) - cursor)
                    if mode == "auto" and cursor > 0 and remaining < (batch_size * avg_time_per_item):
                        batch_size = max(1, int(remaining / avg_time_per_item))
                        if batch_size == 0 or remaining < 0.05:
                            pending_records.extend(needed_embed[cursor:])
                            break

                    batch = needed_embed[cursor : cursor + batch_size]
                    if model is None:
                        model = model_for(request)

                    batch_start = time.perf_counter()
                    batch_vectors = embed_documents(model, [r["text"] for r in batch])
                    batch_elapsed = time.perf_counter() - batch_start
                    avg_time_per_item = 0.7 * avg_time_per_item + 0.3 * (batch_elapsed / max(1, len(batch)))

                    if batch_vectors and dim == 0:
                        dim = int(batch_vectors[0].shape[0])
                    for r, v in zip(batch, batch_vectors):
                        embedded_records.append((r, v))
                    cursor += len(batch)

        # Commit SQLite transaction atomically with executemany
        with connection:
            # 1. Insert newly embedded records
            if embedded_records:
                insert_payload = [
                    (
                        r["id"], r["sourcePath"], r["relativePath"],
                        r["title"], json.dumps(r["collections"], ensure_ascii=False),
                        r["sourceHash"], r.get("chunkTextHash", ""), r["chunkIndex"],
                        r["startLine"], r["endLine"], int(np.asarray(v, dtype=np.float32).shape[0]),
                        np.asarray(v, dtype=np.float32).tobytes(),
                    )
                    for r, v in embedded_records
                ]
                connection.executemany(
                    """INSERT OR REPLACE INTO chunks
                    (id, source_path, relative_path, title, collections, source_hash,
                     chunk_text_hash, chunk_index, start_line, end_line, dimensions, embedding)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    insert_payload,
                )

            # 2. Insert records reused via chunk_text_hash
            if reused_by_hash:
                hash_reuse_payload = [
                    (
                        r["id"], r["sourcePath"], r["relativePath"],
                        r["title"], json.dumps(r["collections"], ensure_ascii=False),
                        r["sourceHash"], r.get("chunkTextHash", ""), r["chunkIndex"],
                        r["startLine"], r["endLine"], d, b,
                    )
                    for r, d, b in reused_by_hash
                ]
                connection.executemany(
                    """INSERT OR REPLACE INTO chunks
                    (id, source_path, relative_path, title, collections, source_hash,
                     chunk_text_hash, chunk_index, start_line, end_line, dimensions, embedding)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    hash_reuse_payload,
                )

            # 3. Update exact reused records' metadata
            if reused:
                update_payload = [
                    (
                        r["sourcePath"], r["relativePath"], r["title"],
                        json.dumps(r["collections"], ensure_ascii=False),
                        r["sourceHash"], r["chunkIndex"], r["startLine"],
                        r["endLine"], r["id"],
                    )
                    for r in reused
                ]
                connection.executemany(
                    """UPDATE chunks SET
                    source_path = ?, relative_path = ?, title = ?, collections = ?,
                    source_hash = ?, chunk_index = ?, start_line = ?, end_line = ?
                    WHERE id = ?""",
                    update_payload,
                )

            # 4. Clean up deleted files and collection migrations
            active_ids = {r["id"] for r in records}
            records_by_id = {r["id"]: r for r in records}
            if synced_collections:
                all_chunks_in_db = connection.execute(
                    "SELECT id, collections, relative_path FROM chunks"
                ).fetchall()
                for cid, coll_json, rel in all_chunks_in_db:
                    chunk_colls = set(json.loads(coll_json))
                    overlap = chunk_colls.intersection(synced_collections)
                    if overlap:
                        if cid in active_ids:
                            new_colls = records_by_id[cid]["collections"]
                            if set(new_colls) != chunk_colls:
                                connection.execute(
                                    "UPDATE chunks SET collections = ? WHERE id = ?",
                                    (json.dumps(new_colls, ensure_ascii=False), cid),
                                )
                        else:
                            remaining_colls = list(chunk_colls - synced_collections)
                            if remaining_colls:
                                connection.execute(
                                    "UPDATE chunks SET collections = ? WHERE id = ?",
                                    (json.dumps(remaining_colls, ensure_ascii=False), cid),
                                )
                            else:
                                connection.execute("DELETE FROM chunks WHERE id = ?", (cid,))

        # Explicit checkpoint outside the commit block (no open transaction)
        checkpoint_status = safe_checkpoint(connection, mode="TRUNCATE")

    finally:
        connection.close()

    return {
        "ok": True,
        "model": MODEL,
        "embedded": len(embedded_records),
        "reused": len(reused) + len(reused_by_hash),
        "pending": len(pending_records),
        "totalChunks": len(records),
        "dimensions": dim,
        "checkpoint": checkpoint_status,
    }


def index(request):
    req = dict(request)
    req["mode"] = "always"
    req["budgetMs"] = 10000000.0
    return sync(req)


def search(request):
    model = model_for(request)
    query_vector = np.asarray(embed_query(model, request["query"]), dtype=np.float32)
    query_norm = float(np.linalg.norm(query_vector))
    query_normed = (query_vector / query_norm) if query_norm > 0 else query_vector

    allowed = set(request["collectionNames"])
    valid_source_hashes = set(request.get("validSourceHashes", []))
    exclude_paths = set(request.get("excludePaths", []))

    connection = sqlite3.connect(request["dbPath"], timeout=30.0)
    try:
        connection.execute("PRAGMA busy_timeout = 30000")
        rows = connection.execute(
            "SELECT source_path, relative_path, title, collections, source_hash, chunk_index, start_line, end_line, dimensions, embedding FROM chunks"
        ).fetchall()
    finally:
        connection.close()

    if not rows:
        return {"ok": True, "model": MODEL, "results": []}

    candidate_rows = []
    vector_list = []
    for row in rows:
        rel_path = row[1]
        if rel_path in exclude_paths:
            continue
        memberships = set(json.loads(row[3]))
        if not memberships.intersection(allowed):
            continue
        source_hash = row[4]
        if valid_source_hashes and source_hash not in valid_source_hashes:
            continue

        vector = np.frombuffer(row[9], dtype=np.float32, count=row[8])
        vector_list.append(vector)
        candidate_rows.append(row)

    if not candidate_rows:
        return {"ok": True, "model": MODEL, "results": []}

    # Vectorized cosine similarity computation via GEMV
    matrix = np.vstack(vector_list)
    matrix_norms = np.linalg.norm(matrix, axis=1)
    matrix_norms[matrix_norms == 0] = 1.0
    normed_matrix = matrix / matrix_norms[:, np.newaxis]
    scores = np.dot(normed_matrix, query_normed)

    limit = int(request.get("limit", 20))
    if len(scores) > limit:
        top_indices = np.argpartition(scores, -limit)[-limit:]
        top_indices = top_indices[np.argsort(-scores[top_indices])]
    else:
        top_indices = np.argsort(-scores)

    scored = []
    for idx in top_indices:
        row = candidate_rows[idx]
        scored.append({
            "filepath": row[0],
            "displayPath": row[1],
            "title": row[2],
            "hash": row[4],
            "chunkIndex": row[5],
            "lineStartHint": row[6],
            "lineEndHint": row[7],
            "score": float(scores[idx]),
            "source": "vec",
        })

    return {"ok": True, "model": MODEL, "results": scored}


def main():
    request = read_request()
    if request["action"] == "index":
        response = index(request)
    elif request["action"] == "sync":
        response = sync(request)
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
