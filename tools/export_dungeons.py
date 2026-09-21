#!/usr/bin/env python3
"""
Generate Data/dungeons.json from the dungeon_export XML dump.

For every dungeon in dungeon_export/index.csv it scans all floor_*.xml and
flags the dungeon as Secret Bazaar capable when at least one floor has

    Chances@hidden_stairs      != 0
    MiscSettings@unk_hidden_stairs in {0, 255}

(The hidden stairs on such floors can lead to a Secret Bazaar.)

Output shape:

    {
      "seed": "a61564cd",             // dungeon PRNG working value after a quicksave
      "dungeons": [
        {"id": 8, "name": "Craggy Coast", "folder": "008_Craggy Coast", "bazaar": true},
        ...
      ]
    }

The grab bag item pools themselves are NOT copied here — the web app reads
them live from dungeon_export/<folder>/floor_001.xml (ItemList type="Unk1")
so the XML dump stays the single source of truth.

Only the Python standard library is used.
"""

import csv
import json
import sys
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parent.parent
EXPORT_DIR = ROOT / "dungeon_export"
INDEX_CSV = EXPORT_DIR / "index.csv"
OUT_PATH = ROOT / "Data" / "dungeons.json"

SEED = "a61564cd"
UNK_HIDDEN_STAIRS_BAZAAR = {0, 255}


def floor_is_bazaar_capable(xml_path: Path) -> bool:
    try:
        root = ElementTree.parse(xml_path).getroot()
    except ElementTree.ParseError as e:
        print(f"WARNING: could not parse {xml_path}: {e}", file=sys.stderr)
        return False
    chances = root.find(".//Chances")
    misc = root.find(".//MiscSettings")
    if chances is None or misc is None:
        return False
    try:
        hidden_stairs = int(chances.get("hidden_stairs", "0"))
        unk_hidden_stairs = int(misc.get("unk_hidden_stairs", "-1"))
    except ValueError:
        return False
    return hidden_stairs != 0 and unk_hidden_stairs in UNK_HIDDEN_STAIRS_BAZAAR


def main() -> None:
    if not INDEX_CSV.exists():
        raise SystemExit(f"ERROR: {INDEX_CSV} not found.")
    dungeons = []
    bazaar_count = 0
    unk_hidden_values: dict[int, int] = {}
    with INDEX_CSV.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            folder = row["folder"]
            dd = EXPORT_DIR / folder
            bazaar = False
            floors = 0
            for xml in sorted(dd.glob("floor_*.xml")):
                floors += 1
                root = ElementTree.parse(xml).getroot()
                misc = root.find(".//MiscSettings")
                if misc is not None:
                    try:
                        v = int(misc.get("unk_hidden_stairs", "-1"))
                    except ValueError:
                        v = -1
                    unk_hidden_values[v] = unk_hidden_values.get(v, 0) + 1
                if floor_is_bazaar_capable(xml):
                    bazaar = True
            if floors == 0:
                print(f"WARNING: {folder} has no floor XMLs", file=sys.stderr)
            bazaar_count += bazaar
            dungeons.append({
                "id": int(row["dungeon_id"]),
                "name": row["dungeon_name"],
                "folder": folder,
                "bazaar": bazaar,
            })

    dungeons.sort(key=lambda d: d["id"])
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps({"seed": SEED, "dungeons": dungeons}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT_PATH.relative_to(ROOT)}: {len(dungeons)} dungeons, "
          f"{bazaar_count} with Secret Bazaar floors")
    hist = ", ".join(f"{k}:{v}" for k, v in sorted(unk_hidden_values.items()))
    print(f"unk_hidden_stairs histogram: {hist}")


if __name__ == "__main__":
    main()
