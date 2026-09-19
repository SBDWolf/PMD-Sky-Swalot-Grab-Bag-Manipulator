#!/usr/bin/env python3
"""
Reference Secret Bazaar manip solver (Python).

Mirrors the web tool's JS solver (js/solver.js) exactly. Used to validate
the JS implementation and to double-check specific manips.

Usage:
    python tools/reference_solve.py "Data\\grab bag manip bot sky peak.txt" --team 4 --items 89:3
    python tools/reference_solve.py Data/tables/sky-peak.json --team 2 --items 73:1 --items 89:1

Model:
    * table position p (1-indexed): talking to Swalot yields item table[p]
    * partner talk: +3 positions, cost 40 (10x a 4-turn dash)
    * pass 1 turn (1 dash tile or 1 attack): +t positions, cost 1
      (t = 6/7/8/9 for team sizes 1/2/3/4)
    * collecting a requested item (talking to Swalot): +3 positions, cost 0
    * you may chain collects in one run; you never talk to Swalot for
      an unwanted item
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_table import LINE_RE  # noqa: E402


def load_table(path):
    """Load items (and rng sequence when available) from a .txt or .json table."""
    p = Path(path)
    if p.suffix == ".json":
        t = json.loads(p.read_text(encoding="utf-8"))
        return list(t["items"]), list(t.get("rng", []))
    items, rngs = [], []
    for raw in p.read_text(encoding="utf-8-sig").splitlines():
        if not raw.strip():
            continue
        m = LINE_RE.match(raw)
        if not m:
            raise SystemExit(f"ERROR: unparseable line in {p.name}: {raw!r}")
        rngs.append(m.group(2).lower())
        items.append(int(m.group(3)))
    if not items:
        raise SystemExit(f"ERROR: {p.name} contains no data lines.")
    return items, rngs


def solve(items, team, reqs, c_partner=40, c_turn=1, c_collect=0):
    """
    Layered DP over (position, remaining-qty-vector). All transitions advance
    the position strictly, so one forward pass is an exact shortest path.

    Returns (total_cost, segments, total_turns, total_partners) where each
    segment is (partner_count, turn_count, item_id, collected_position).
    """
    N = len(items)
    t = 5 + team  # turn advance: 6/7/8/9
    S = 1
    for _, q in reqs:
        S *= q + 1
    if N * S > 10_000_000:
        raise SystemExit("ERROR: request too large for the solver (state space cap); reduce quantities.")
    stride = []
    acc = 1
    for _, q in reqs:
        stride.append(acc)
        acc *= q + 1
    qty = [q for _, q in reqs]
    req_index = {i: k for k, (i, _) in enumerate(reqs)}

    INF = float("inf")
    start_idx = sum(q * st for q, st in zip(qty, stride))  # full remaining vector
    cost = {start_idx: 0}
    parent = {}
    by_pos = [[] for _ in range(N)]
    by_pos[0].append(start_idx)
    past_best = None  # (cost, prev_key, action) for terminal states past the table

    def relax(ni, nidx, nc, key, action):
        nonlocal past_best
        if ni < N:
            nkey = ni * S + nidx
            if nc < cost.get(nkey, INF):
                cost[nkey] = nc
                parent[nkey] = (key, action)
                by_pos[ni].append(nidx)
        elif nidx == 0:
            if past_best is None or nc < past_best[0]:
                past_best = (nc, key, action)

    for i in range(N):
        base = i * S
        for idx in by_pos[i]:
            key = base + idx
            c = cost.get(key)
            if c is None:
                continue
            k = req_index.get(items[i], -1)
            if k >= 0 and (idx // stride[k]) % (qty[k] + 1) > 0:
                relax(i + 3, idx - stride[k], c + c_collect, key, 2)
            relax(i + 3, idx, c + c_partner, key, 0)
            relax(i + t, idx, c + c_turn, key, 1)

    best = None  # (cost, key, final_action_or_None)
    for i in range(N):
        c = cost.get(i * S)
        if c is not None and (best is None or c < best[0]):
            best = (c, i * S, None)
    if past_best is not None and (best is None or past_best[0] < best[0]):
        best = past_best
    if best is None:
        raise SystemExit("No solution found.")

    c, key, last_action = best
    chain = []
    if last_action is not None:
        chain.append((key, last_action))
    while key in parent:
        key, action = parent[key]
        chain.append((key, action))
    chain.reverse()

    segments = []
    cur_p = cur_t = 0
    for key, action in chain:
        i = key // S
        if action == 0:
            cur_p += 1
        elif action == 1:
            cur_t += 1
        else:
            segments.append((cur_p, cur_t, items[i], i + 1))
            cur_p = cur_t = 0
    total_turns = sum(s[1] for s in segments)
    total_partners = sum(s[0] for s in segments)
    return c, segments, total_turns, total_partners


def main():
    ap = argparse.ArgumentParser(description="Reference Secret Bazaar manip solver.")
    ap.add_argument("table", help="path to a .txt (original format) or .json (Data/tables) file")
    ap.add_argument("--team", type=int, required=True, choices=(1, 2, 3, 4))
    ap.add_argument("--items", action="append", required=True, metavar="ID:QTY",
                    help="required item (repeatable), e.g. --items 89:3")
    ap.add_argument("--partner-cost", type=int, default=40)
    ap.add_argument("--turn-cost", type=int, default=1)
    ap.add_argument("--collect-cost", type=int, default=0)
    args = ap.parse_args()

    reqs = []
    for spec in args.items:
        try:
            i, q = (int(x) for x in spec.split(":"))
        except ValueError:
            raise SystemExit(f"ERROR: --items expects ID:QTY, got {spec!r}")
        if q < 1 or i < 0:
            raise SystemExit(f"ERROR: bad requirement {spec!r} (qty must be >= 1)")
        reqs.append((i, q))

    items, rngs = load_table(args.table)
    missing = sorted({i for i, _ in reqs} - set(items))
    if missing:
        raise SystemExit(f"ERROR: item(s) {missing} never appear in this table.")

    c, segments, total_turns, total_partners = solve(
        items, args.team, reqs, args.partner_cost, args.turn_cost, args.collect_cost
    )
    print(f"table={Path(args.table).name} team={args.team} advance={5 + args.team}")
    print(f"requirements: " + ", ".join(f"{i}x{q}" for i, q in reqs))
    print(f"cost={c} (turns={total_turns}, partners={total_partners})")
    for n, (p, t_, item, pos) in enumerate(segments, 1):
        rng = rngs[pos - 1] if pos - 1 < len(rngs) else "?"
        print(f"  {n}. partner x{p}, turn x{t_} -> collect {item} at position {pos} (PRNG {rng})")
    seg_str = "|".join(f"{p}/{t_}/{item}/{pos}" for p, t_, item, pos in segments)
    print(f"MACHINE cost={c} segs={seg_str}")


if __name__ == "__main__":
    main()
