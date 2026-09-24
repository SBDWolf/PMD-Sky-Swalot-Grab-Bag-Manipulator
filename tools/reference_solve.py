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
    * partner talk: +3 positions, cost 40 (10x a 4-turn dash) — needs a
      partner, so it is unavailable (and never used) at team size 1
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

STATS_T = ("Attack", "Defense", "Sp. Attack", "Sp. Defense")

MULT = 1566083941
MASK32 = 0xFFFFFFFF


def lcg(s: int) -> int:
    return (MULT * s + 1) & MASK32


def scaled(raw16: int, high: int) -> int:
    return (raw16 * high) >> 16


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


def gummi_outcome(state):
    """(boosted, omni, stat, rolls) for a gummi whose rolls start at `state`."""
    s = lcg(state)
    if scaled(s >> 16, 100) >= 25:
        return (False, False, None, 1)
    s = lcg(s)
    if scaled(s >> 16, 16) == 10:
        return (True, True, None, 2)
    s = lcg(s)
    return (True, False, scaled(s >> 16, 4), 3)


def solve(items, team, reqs, c_partner=40, c_turn=1, c_collect=0,
          c_gummi=0, gummies=0, target=0, omni_only=False, rngs=None):
    """
    Layered DP over (position, remaining-qty-vector). All transitions advance
    the position strictly, so one forward pass is an exact shortest path.

    Gummies (fed between item purchases) join the requirement vector as a
    pseudo item (id -1): eating at position i consumes rolls_i steps first
    (1/2/3 by outcome), then the eat turn passes like any turn (+t).

    Returns (total_cost, segments, total_turns, total_partners) where each
    segment is (partner_count, turn_count, item_id, collected_position).
    Gummi segments carry item_id None and (omni, stat) extras.
    """
    N = len(items)
    t = 5 + team  # turn advance: 6/7/8/9
    has_partner = team > 1  # alone (team 1): no partner talk move
    reqs = list(reqs)
    if gummies > 0:
        reqs = reqs + [(-1, gummies)]
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
    gummi_dim = req_index.get(-1)
    gummi_stride = stride[gummi_dim] if gummi_dim is not None else 0

    rolls_at = [0] * N
    gummi_ok_at = [0] * N
    if gummies > 0:
        if not rngs or len(rngs) < N:
            raise SystemExit("ERROR: gummi feeding needs the table's PRNG states (rng).")
        for i in range(N):
            boosted, omni, stat, rolls = gummi_outcome(int(rngs[i], 16))
            rolls_at[i] = rolls
            ok = boosted and (omni if omni_only else (omni or stat == target))
            gummi_ok_at[i] = 1 if ok else 0

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
            if gummies > 0 and gummi_ok_at[i] and (idx // gummi_stride) % (gummies + 1) > 0:
                # eat: gummi rolls first, then the eat turn's own advance (+t)
                relax(i + rolls_at[i] + t, idx - gummi_stride, c + c_gummi, key, 3)
            if has_partner:
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
            rng = rngs[i] if rngs and i < len(rngs) else None
            if action == 3:  # eat gummi
                boosted, omni, stat, _rolls = gummi_outcome(int(rng, 16))
                segments.append({
                    "partner": cur_p, "turn": cur_t, "action": "gummi",
                    "item": None, "omni": omni, "stat": None if omni else stat,
                    "pos": i + 1, "rng": rng,
                })
            else:  # collect
                segments.append({
                    "partner": cur_p, "turn": cur_t, "action": "collect",
                    "item": items[i], "omni": False, "stat": None,
                    "pos": i + 1, "rng": rng,
                })
            cur_p = cur_t = 0
    total_turns = sum(s["turn"] for s in segments)
    total_partners = sum(s["partner"] for s in segments)
    return c, segments, total_turns, total_partners


def main():
    ap = argparse.ArgumentParser(description="Reference Secret Bazaar manip solver.")
    ap.add_argument("table", help="path to a .txt (original format) or .json (Data/tables) file")
    ap.add_argument("--team", type=int, required=True, choices=(1, 2, 3, 4))
    ap.add_argument("--items", action="append", default=[], metavar="ID:QTY",
                    help="required item (repeatable), e.g. --items 89:3")
    ap.add_argument("--gummies", type=int, default=0,
                    help="gummies to feed piggybacked onto the same run")
    ap.add_argument("--stat", type=int, default=0, choices=(0, 1, 2, 3),
                    help="gummi stat to optimize for (0 Atk, 1 Def, 2 SpA, 3 SpD)")
    ap.add_argument("--omni-only", action="store_true")
    ap.add_argument("--partner-cost", type=int, default=40)
    ap.add_argument("--turn-cost", type=int, default=1)
    ap.add_argument("--collect-cost", type=int, default=0)
    ap.add_argument("--gummi-cost", type=int, default=0)
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
    missing = sorted({i for i, _ in reqs if i >= 0} - set(items))
    if missing:
        raise SystemExit(f"ERROR: item(s) {missing} never appear in this table.")
    if not reqs and args.gummies < 1:
        raise SystemExit("ERROR: no requirements given (--items / --gummies).")

    c, segments, total_turns, total_partners = solve(
        items, args.team, reqs, args.partner_cost, args.turn_cost, args.collect_cost,
        args.gummi_cost, args.gummies, args.stat, args.omni_only, rngs,
    )
    print(f"table={Path(args.table).name} team={args.team} advance={5 + args.team}")
    print(f"requirements: " + ", ".join(f"{i}x{q}" for i, q in reqs))
    print(f"cost={c} (turns={total_turns}, partners={total_partners})")
    for n, s in enumerate(segments, 1):
        if s["action"] == "gummi":
            outcome = "Omniboost" if s["omni"] else STATS_T[s["stat"]]
            print(f"  {n}. partner x{s['partner']}, turn x{s['turn']}"
                  f" -> eat gummi -> {outcome} at position {s['pos']} (PRNG {s['rng']})")
        else:
            print(f"  {n}. partner x{s['partner']}, turn x{s['turn']}"
                  f" -> collect {s['item']} at position {s['pos']} (PRNG {s['rng']})")
    seg_str = "|".join(
        (
            f"{s['partner']}/{s['turn']}/"
            + (f"G/{-1 if s['omni'] else s['stat']}" if s["action"] == "gummi"
               else f"{s['item']}/0")
            + f"/{s['pos']}"
        )
        for s in segments
    )
    print(f"MACHINE cost={c} segs={seg_str}")


if __name__ == "__main__":
    main()
