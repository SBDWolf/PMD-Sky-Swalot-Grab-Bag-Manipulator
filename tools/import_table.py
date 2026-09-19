#!/usr/bin/env python3
"""
Import a Secret Bazaar grab bag table (original "manip bot" .txt format)
into the web tool's data directory.

Input line format (one per line):
    Iteration: <n> - Initial RNG: <hex> - Item bought: <item id>

Usage:
    python tools/import_table.py "Data\\grab bag manip bot new dungeon.txt" \
        --dungeon "New Dungeon" [--dungeon "Alias Dungeon"] [--id new-dungeon] [--replace]

    python tools/import_table.py --list

What it does:
  * Validates that iteration numbers are exactly 1..N (this catches files
    that accidentally contain two concatenated tables, which produce a
    clear error instead of silently importing garbage).
  * Writes Data/tables/<id>.json  ->  {"id", "version", "length", "items[]", "rng[]"}
  * Merges the given dungeon names into Data/registry.json (existing order
    is preserved; new entries are appended).

Only the Python standard library is used.
"""

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "Data"
TABLES_DIR = DATA_DIR / "tables"
REGISTRY_PATH = DATA_DIR / "registry.json"

LINE_RE = re.compile(
    r"^\s*Iteration:\s*(\d+)\s*-\s*Initial RNG:\s*([0-9a-fA-F]+)\s*-\s*Item bought:\s*(\d+)\s*$"
)

FILE_PREFIX = "grab bag manip bot "


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "table"


def parse_table(path: Path) -> tuple[list[int], list[str]]:
    """Parse a .txt file in the original format. Returns (items, rng)."""
    text = path.read_text(encoding="utf-8-sig")
    items: list[int] = []
    rngs: list[str] = []
    for lineno, raw in enumerate(text.splitlines(), start=1):
        if not raw.strip():
            continue
        m = LINE_RE.match(raw)
        if not m:
            raise SystemExit(
                f"ERROR: {path.name} line {lineno} does not match the expected format "
                f"'Iteration: <n> - Initial RNG: <hex> - Item bought: <id>':\n  {raw!r}"
            )
        iteration = int(m.group(1))
        rngs.append(m.group(2).lower())
        items.append(int(m.group(3)))
        if iteration != len(items):
            if iteration == 1 and len(items) > 1:
                raise SystemExit(
                    f"ERROR: {path.name} iteration numbers restart at 1 on line {lineno} "
                    f"after {len(items)} iterations. The file looks like TWO tables "
                    f"concatenated into one file. Split them into separate files and "
                    f"import each one separately."
                )
            raise SystemExit(
                f"ERROR: {path.name} line {lineno}: expected iteration {len(items)}, "
                f"found {iteration} (iterations must be exactly 1..N, no gaps or duplicates)."
            )
    if not items:
        raise SystemExit(f"ERROR: {path.name} contains no data lines.")
    return items, rngs


def load_registry() -> dict:
    if REGISTRY_PATH.exists():
        reg = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    else:
        reg = {"dungeons": []}
    if "dungeons" not in reg or not isinstance(reg["dungeons"], list):
        raise SystemExit(f"ERROR: {REGISTRY_PATH} is malformed (missing 'dungeons' list).")
    return reg


def save_registry(reg: dict) -> None:
    REGISTRY_PATH.write_text(json.dumps(reg, indent=2) + "\n", encoding="utf-8")


def write_table(table_id: str, items: list[int], rngs: list[str]) -> Path:
    version = hashlib.sha1(" ".join(map(str, items)).encode("ascii")).hexdigest()
    out = {
        "id": table_id,
        "version": version,
        "length": len(items),
        "items": items,
        "rng": rngs,
    }
    TABLES_DIR.mkdir(parents=True, exist_ok=True)
    path = TABLES_DIR / f"{table_id}.json"
    path.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    return path


def update_registry(reg: dict, table_id: str, dungeon_names: list[str], replace: bool) -> list[str]:
    """Merge dungeon entries into the registry. Returns a list of change descriptions."""
    changes: list[str] = []
    for name in dungeon_names:
        existing = next((d for d in reg["dungeons"] if d["name"] == name), None)
        if existing is None:
            reg["dungeons"].append({"name": name, "table": table_id})
            changes.append(f'added dungeon "{name}" -> table "{table_id}"')
        elif existing["table"] == table_id:
            changes.append(f'dungeon "{name}" already pointed at "{table_id}" (unchanged)')
        else:
            if not replace:
                raise SystemExit(
                    f"ERROR: dungeon \"{name}\" already exists in the registry and points at "
                    f"table \"{existing['table']}\" (this file maps to \"{table_id}\"). "
                    f"Re-run with --replace to re-point it."
                )
            existing["table"] = table_id
            changes.append(f'updated dungeon "{name}": re-pointed to table "{table_id}"')
    return changes


def list_state() -> None:
    print("Registry (Data/registry.json):")
    if REGISTRY_PATH.exists():
        reg = load_registry()
        for d in reg["dungeons"]:
            print(f"  {d['name']:<28} -> table {d['table']}")
        if not reg["dungeons"]:
            print("  (empty)")
    else:
        print("  (no registry yet)")
    print("\nTable files (Data/tables/):")
    if TABLES_DIR.exists():
        for f in sorted(TABLES_DIR.glob("*.json")):
            t = json.loads(f.read_text(encoding="utf-8"))
            print(f"  {t['id']:<28} length {t['length']:<6} version {t['version'][:12]}")
    else:
        print("  (none)")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("file", nargs="?", help="path to a .txt file in the original format")
    ap.add_argument(
        "--dungeon",
        action="append",
        default=None,
        help='dungeon name to expose in the web tool (repeatable; one table can serve '
        'multiple dungeons, e.g. --dungeon "Crystal Cave" --dungeon "Crystal Crossing")',
    )
    ap.add_argument("--id", dest="table_id", default=None, help="table id (default: derived from name)")
    ap.add_argument("--replace", action="store_true", help="overwrite an existing table / re-point an existing dungeon")
    ap.add_argument("--list", action="store_true", help="show the current registry and table files, then exit")
    args = ap.parse_args()

    if args.list:
        list_state()
        return
    if not args.file:
        ap.error("a .txt file is required (or use --list)")

    src = Path(args.file)
    if not src.is_file():
        raise SystemExit(f"ERROR: file not found: {src}")

    items, rngs = parse_table(src)

    if args.table_id:
        table_id = slugify(args.table_id)
    elif args.dungeon:
        table_id = slugify(args.dungeon[0])
    else:
        base = src.stem
        if base.startswith(FILE_PREFIX):
            base = base[len(FILE_PREFIX):]
        table_id = slugify(base)

    dungeon_names = args.dungeon
    if not dungeon_names:
        base = src.stem
        if base.startswith(FILE_PREFIX):
            base = base[len(FILE_PREFIX):]
        # "amp plains" -> "Amp Plains"
        dungeon_names = [w.capitalize() for w in base.split()]

    out_path = TABLES_DIR / f"{table_id}.json"
    if out_path.exists() and not args.replace:
        old = json.loads(out_path.read_text(encoding="utf-8"))
        same = old.get("items") == items and old.get("rng") == rngs
        if same:
            print(f"Table {table_id} is up to date (content unchanged); refreshing registry mappings only.")
        else:
            raise SystemExit(
                f"ERROR: Data/tables/{table_id}.json already exists with different content. "
                f"Re-run with --replace to overwrite it."
            )

    write_table(table_id, items, rngs)

    reg = load_registry()
    changes = update_registry(reg, table_id, dungeon_names, args.replace)
    save_registry(reg)

    c = Counter(items)
    print(f"Imported {src.name}")
    print(f"  table id      : {table_id}")
    print(f"  length        : {len(items)} iterations")
    print(f"  unique items  : {len(c)}")
    print(f"  top items     : {c.most_common(5)}")
    print(f"  item 70 share : {c.get(70, 0) / len(items):.1%} (usually the 'no item' draw)")
    print(f"  written to    : {out_path.relative_to(ROOT)}")
    for ch in changes:
        print(f"  registry      : {ch}")


if __name__ == "__main__":
    main()
