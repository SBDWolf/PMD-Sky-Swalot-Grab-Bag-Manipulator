#!/usr/bin/env python3
"""
Convert the game's item list into Data/items.json.

Input line format (one per line, tabs or spaces):
    0x<hex id>  <English name>  <Japanese name>

The hex id is the same item id the dungeon tables use (in decimal); the
English name (2nd column) becomes the item name verbatim — the Japanese
name is ignored, and "$$$" rows (items that are never drawn) are kept
with the name "$$$".

Usage:
    python tools/import_items.py [Data\\item-names.txt] [--out Data\\items.json] [--dry-run]

What it does:
  * Converts each hex id to a decimal string key.
  * Merges into the existing Data/items.json: names come from the list
    (authoritative), existing "icon" values are preserved, and existing
    entries for ids not present in the list are kept (so manual edits
    survive re-runs).
  * Writes Data/items.json -> {"70": {"name": "Oran Berry"}, ...} with
    keys sorted numerically.

Only the Python standard library is used.
"""

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "Data"
SRC_DEFAULT = DATA_DIR / "item-names.txt"
OUT_DEFAULT = DATA_DIR / "items.json"


def parse_names(path: Path) -> dict[int, str]:
    """Parse the item list file into {decimal id: name}."""
    text = path.read_text(encoding="utf-8-sig")
    names: dict[int, str] = {}
    for lineno, raw in enumerate(text.splitlines(), start=1):
        if not raw.strip():
            continue
        parts = raw.split()
        if len(parts) < 3 or not parts[0].lower().startswith("0x"):
            raise SystemExit(
                f"ERROR: {path.name} line {lineno} does not match the expected "
                f"format '0x<hex> <English name> <Japanese name>':\n  {raw!r}"
            )
        item_id = int(parts[0][2:], 16)
        name = " ".join(parts[1:-1])
        if item_id in names:
            raise SystemExit(
                f"ERROR: {path.name} line {lineno}: duplicate item id {item_id} (0x{item_id:x})."
            )
        names[item_id] = name
    if not names:
        raise SystemExit(f"ERROR: {path.name} contains no item lines.")
    return names


def load_existing(path: Path) -> dict[int, dict]:
    """Load an existing items.json (if any) as {id: entry}."""
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"ERROR: cannot parse existing {path}: {e}")
    if not isinstance(data, dict):
        raise SystemExit(f"ERROR: existing {path} is not a JSON object of id -> entry.")
    by_id: dict[int, dict] = {}
    for key, entry in data.items():
        try:
            iid = int(key)
        except ValueError:
            raise SystemExit(f"ERROR: existing {path} has a non-numeric id key {key!r}.")
        if iid in by_id:
            raise SystemExit(f"ERROR: existing {path} has duplicate id {iid}.")
        if not isinstance(entry, dict):
            raise SystemExit(f"ERROR: existing {path} entry for id {iid} is not an object.")
        by_id[iid] = entry
    return by_id


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "source",
        nargs="?",
        default=str(SRC_DEFAULT),
        help="item list .txt file (default: Data/item-names.txt)",
    )
    ap.add_argument("--out", default=str(OUT_DEFAULT), help="output JSON (default: Data/items.json)")
    ap.add_argument("--dry-run", action="store_true", help="parse and report, but do not write anything")
    args = ap.parse_args()

    src = Path(args.source)
    if not src.is_file():
        raise SystemExit(f"ERROR: file not found: {src}")
    out = Path(args.out)

    names = parse_names(src)
    existing = load_existing(out)

    merged: dict[int, dict] = {}
    for iid in set(names) | set(existing):
        entry = dict(existing.get(iid, {}))
        if iid in names:
            entry["name"] = names[iid]
        if entry:
            merged[iid] = entry

    out_data = {str(iid): merged[iid] for iid in sorted(merged)}
    dollars = sum(1 for n in names.values() if n == "$$$")
    kept = len(set(existing) - set(names))

    if args.dry_run:
        print("DRY RUN - nothing written.")
    else:
        out.write_text(json.dumps(out_data, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {len(out_data)} entries to {out}.")
    print(f"  parsed {src.name}: {len(names)} items ({dollars} named '$$$')")
    if kept:
        print(f"  kept {kept} existing entr(y/ies) for ids not in the list")


if __name__ == "__main__":
    main()
