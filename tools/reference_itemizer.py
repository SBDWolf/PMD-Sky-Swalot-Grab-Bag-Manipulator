#!/usr/bin/env python3
"""
Reference Itemizer Orb manip solver (Python).

Mirrors js/itemizer.js exactly. Used to validate the JS implementation and
to double-check specific manips:

    python tools/reference_itemizer.py "008_Craggy Coast" 1 --item 311 --team 3

Model (PRNG quicksave seed a61564cd):
    * positioning moves, 1 turn each:
        swap places with the partner   +17 steps
        any other turn pass            +18 steps
    * the three orb rolls happen FIRST, from the state at the moment of the
      throw (the turn's own advance comes after and is irrelevant):
        1. accuracy check: DungeonRandInt(100) < 65 must hold
        2. category roll:  DungeonRandInt(10000)
        3. item roll:      DungeonRandInt(10000)
      The produced item must equal the target; anything else (or a miss)
      wastes the orb.
    * the item is drawn from the floor's ItemList type="Floor" (same two
      rolls as the grab bag, no Oran common-pull gate); the pools pair with
      the categories via item-id ranges, NOT positionally.
"""

import argparse
import glob
import re
import sys
from pathlib import Path
from xml.etree import ElementTree

MULT = 1566083941
MASK = 0xFFFFFFFF
SWAP = 17
PASS = 18
ACCURACY_PCT = 65
STATS = ("Attack", "Defense", "Sp. Attack", "Sp. Defense")  # (unused here)

ROOT = Path(__file__).resolve().parent.parent
EXPORT_DIR = ROOT / "dungeon_export"

# Canonical EoS item-id -> category-name ranges. Floor lists use the same
# system as the grab bag plus "Thrown - Pierce" (1-6) and "Other"
# (166-186, excluding 183 = Poké). Berries span 69-118 there and Foods 119+.
FLOOR_RANGES = [
    ("Thrown - Pierce", 1, 6),
    ("Thrown - Rock", 7, 12),
    ("Hold", 13, 68),
    ("Berries, Seeds, Vitamins", 69, 118),
    ("Foods, Gummies", 119, 137),
    ("TMs, HMs", 187, 292),
    ("Poké (Money)", 183, 183),
    ("Other", 166, 182),
    ("Other", 184, 186),
    ("Orbs", 301, 359),
    ("Link Box", 360, 362),
]


def lcg(s: int) -> int:
    return (MULT * s + 1) & MASK


def scaled(raw16: int, high: int) -> int:
    return (raw16 * high) >> 16


def pick(cums, roll):
    for i, w in enumerate(cums):
        if w >= roll:
            return i
    return len(cums) - 1


def load_floor_list(folder: str, floor: int):
    path = EXPORT_DIR / folder / f"floor_{int(floor):03d}.xml"
    if not path.exists():
        raise SystemExit(f"ERROR: {path} not found.")
    root = ElementTree.parse(path).getroot()
    il = next((x for x in root.iter("ItemList") if x.get("type") == "Floor"), None)
    if il is None:
        raise SystemExit(f"ERROR: {path} has no ItemList type=Floor.")
    cats = [(c.get("name"), int(c.get("weight"))) for c in il if c.tag == "Category"]
    groups, cur = [], []
    for el in il:
        if el.tag != "Item":
            continue
        try:
            cur.append((int(el.get("id")), int(el.get("weight"))))
        except (TypeError, ValueError):
            continue  # e.g. id="GUARANTEED"
        if cur and cur[-1][1] >= 10000:
            groups.append(sorted(cur, key=lambda e: e[1]))
            cur = []
    if cur:
        groups.append(sorted(cur, key=lambda e: e[1]))

    # Pair the pools with their categories via id ranges (NOT positionally
    # — the XML lists pools in a scrambled order).
    def cat_of(i):
        for name, lo, hi in FLOOR_RANGES:
            if lo <= i <= hi:
                return name
        return None

    used = [False] * len(groups)
    paired = []
    for name, _w in cats:
        best, best_score = None, 0
        for gi, g in enumerate(groups):
            if used[gi]:
                continue
            score = sum(1 for iid, _ in g if cat_of(iid) == name)
            if score > best_score:
                best, best_score = gi, score
        paired.append(groups[best] if best is not None else None)
        if best is not None:
            used[best] = True
    return cats, paired


def orb_outcome(state, cats, groups, target):
    """(hit, item, first_roll, accuracy_roll) for a use from `state`.

    The three rolls run first: accuracy (state+1), category (state+2),
    item (state+3).
    """
    cat_cums = [w for _, w in cats]
    gs = [{"ids": [i for i, _ in g], "cums": [w for _, w in g]} for g in groups]
    s = lcg(state)
    first_roll = s >> 16
    acc = scaled(first_roll, 100)  # 1: accuracy check
    if acc >= ACCURACY_PCT:
        return (False, None, first_roll, acc)
    s = lcg(s)
    ci = pick(cat_cums, scaled(s >> 16, 10000)) if cat_cums else -1  # 2: category
    g = gs[ci] if ci >= 0 else {"ids": []}
    s = lcg(s)
    item = g["ids"][pick(g["cums"], scaled(s >> 16, 10000))] if g["ids"] else None  # 3
    return (item is not None and item == target, item, first_roll, acc)


def solve(folder, floor, target, seed=0xA61564CD, window=4000):
    cats, groups = load_floor_list(folder, floor)
    limit = window
    table_len = limit + SWAP + 1
    states = [0] * table_len
    states[0] = seed
    for j in range(1, table_len):
        states[j] = lcg(states[j - 1])
    ok_at = [False] * table_len
    for j in range(table_len):
        hit, _item, _fr, _ar = orb_outcome(states[j], cats, groups, target)
        ok_at[j] = hit

    INF = 0x3FFFFFFF
    cost = [INF] * (limit + 1)
    parent = [-1] * (limit + 1)
    cost[0] = 0
    for i in range(limit + 1):
        c = cost[i]
        if c >= INF:
            continue
        for code, adv in ((0, SWAP), (1, PASS)):
            ni = i + adv
            if ni <= limit and c + 1 < cost[ni]:
                cost[ni] = c + 1
                parent[ni] = i * 4 + code

    best_i, best_c = -1, INF
    for i in range(limit + 1):
        if ok_at[i] and cost[i] < INF and cost[i] + 1 < best_c:
            best_c, best_i = cost[i] + 1, i
    if best_i < 0:
        raise SystemExit("No solution found.")

    actions = []
    i = best_i
    while i != 0:
        p = parent[i]
        from_i, code = p // 4, p % 4
        assert code <= 1, "corrupt chain"
        actions.append(code)
        i = from_i
    actions.reverse()
    counts = [0, 0]
    for code in actions:
        counts[code] += 1
    assert counts[0] + counts[1] + 1 == best_c, "inconsistent chain"

    hit, item, first_roll, acc = orb_outcome(states[best_i], cats, groups, target)
    return best_c, {
        "n17": counts[0],
        "n18": counts[1],
        "pos": best_i,
        "rng": f"{states[best_i]:08x}",
        "first_roll": first_roll,
        "accuracy_roll": acc,
        "advances": best_i,
    }


def main():
    ap = argparse.ArgumentParser(description="Reference Itemizer Orb manip solver.")
    ap.add_argument("folder", help="dungeon_export folder name, e.g. '008_Craggy Coast'")
    ap.add_argument("floor", type=int, help="floor number (1-based)")
    ap.add_argument("target", type=int, help="item id the orb must produce")
    ap.add_argument("--seed", default="a61564cd")
    ap.add_argument("--window", type=int, default=4000)
    args = ap.parse_args()

    seed = int(args.seed, 16)
    cost, seg = solve(args.folder, args.floor, args.target, seed, args.window)
    print(f"folder={args.folder} floor={args.floor} target={args.target} cost={cost}")
    print(f"  swap x{seg['n17']}, turn pass x{seg['n18']}"
          f" -> use orb at advance {seg['advances']} (PRNG {seg['rng']},"
          f" 1st roll {seg['first_roll']}, accuracy {seg['accuracy_roll']}/100)")
    seg_str = f"{seg['n17']}/{seg['n18']}/{seg['pos']}/{seg['first_roll']}/{seg['accuracy_roll']}"
    print(f"MACHINE cost={cost} seg={seg_str}")


if __name__ == "__main__":
    main()
