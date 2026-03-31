import csv
import json
import struct
from pathlib import Path

MODEL_ID = "Xenova/bge-small-zh-v1.5"
DIMENSION = 512

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
SEARCH_DIR = DATA_DIR / "search"

PRIMARY_SOURCE_CSV = DATA_DIR / "ci.with_embeddings.csv"
IDIOM_SOURCE_CSV = DATA_DIR / "idiom.with_embeddings.csv"
APPEND_SOURCE_CSV = DATA_DIR / "yusuo.append.csv"
APPEND_GLOB = "yusuo.append.*.csv"
META_JSON = SEARCH_DIR / "yusuo.search.meta.json"
EMBEDDINGS_BIN = SEARCH_DIR / "yusuo.search.embeddings.bin"
MANIFEST_JSON = SEARCH_DIR / "yusuo.search.manifest.json"


def iter_source_files() -> list[Path]:
    sources = []

    if PRIMARY_SOURCE_CSV.exists():
        sources.append(PRIMARY_SOURCE_CSV)

    if IDIOM_SOURCE_CSV.exists():
        sources.append(IDIOM_SOURCE_CSV)

    if APPEND_SOURCE_CSV.exists():
        sources.append(APPEND_SOURCE_CSV)

    for path in sorted(DATA_DIR.glob(APPEND_GLOB)):
        if path not in sources:
            sources.append(path)

    return sources


def iter_embedding_rows(source_path: Path):
    with source_path.open("r", encoding="utf-8-sig", newline="") as src:
        reader = csv.DictReader(src)
        for row_number, row in enumerate(reader, start=2):
            embedding = row.get("embedding", "")
            if not embedding:
                continue

            vector = json.loads(embedding)
            if not isinstance(vector, list):
                continue

            yield row_number, row, vector


def main() -> None:
    count = 0
    dimension = None
    source_files = iter_source_files()

    if not source_files:
        raise ValueError("No source CSV files were found.")

    SEARCH_DIR.mkdir(parents=True, exist_ok=True)

    with META_JSON.open("w", encoding="utf-8") as meta_out, \
        EMBEDDINGS_BIN.open("wb") as emb_out:
        meta_out.write("[\n")
        first = True

        for source_path in source_files:
            print(f"Reading source: {source_path}")

            for row_number, row, vector in iter_embedding_rows(source_path):
                if dimension is None:
                    dimension = len(vector)
                elif len(vector) != dimension:
                    raise ValueError(
                        f"Inconsistent embedding length in {source_path} at row {row_number}: "
                        f"expected {dimension}, got {len(vector)}"
                    )

                meta_row = {
                    "id": count,
                    "headword": row.get("headword", ""),
                    "pinyin_tone": row.get("pinyin_tone", ""),
                    "pinyin_plain": row.get("pinyin_plain", ""),
                    "definition": row.get("definition", ""),
                }

                if not first:
                    meta_out.write(",\n")
                meta_out.write(json.dumps(meta_row, ensure_ascii=False))
                first = False

                emb_out.write(struct.pack(f"<{len(vector)}e", *vector))
                count += 1

        meta_out.write("\n]\n")

    if dimension is None:
        raise ValueError("No valid embeddings were found in the source CSV files.")

    manifest = {
        "model": MODEL_ID,
        "dimension": dimension,
        "count": count,
        "meta": META_JSON.name,
        "embeddings": EMBEDDINGS_BIN.name,
        "dtype": "float16",
        "sources": [path.name for path in source_files],
    }
    MANIFEST_JSON.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"Built search index for {count} rows at {dimension} dimensions.")
    print(f"Meta: {META_JSON}")
    print(f"Embeddings: {EMBEDDINGS_BIN}")
    print(f"Manifest: {MANIFEST_JSON}")


if __name__ == "__main__":
    main()
