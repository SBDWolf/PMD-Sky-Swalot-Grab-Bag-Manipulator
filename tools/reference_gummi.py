#!/usr/bin/env python3
"""
Reference gummi stat-boost manip solver (Python).

Mirrors js/gummi.js exactly. Used to validate the JS implementation and to
double-check specific manips:

    python tools/reference_gummi.py --count 3 --stat 0
    python tools/reference_gummi.py --count 2 --omni-only

Model (all from the quicksave PRNG state a61564cd):
    * every action costs 1 turn and advances the PRNG by a fixed number of
      LCG steps. Partner modes:
        together ("Let's go together", the partner follows you):
            swap places with partner       +3
            walk away (partner follows)    +4
            stand still / walk next to it  +5
            eat a gummi                    rolls FIRST, then +5 (a stand)
        wait ("Wait there", the partner stays put):
            swap places with partner       +3
            any other turn pass            +4
            eat a gummi                    rolls FIRST, then +4 (a turn pass)
      --start offsets the advance count the manipulation begins at
    * gummi boost rolls (from the state after `count` advances, i.e. the
      moment you eat):
        1. DungeonRandOutcome(25): boost at all?  (upper16*100 >> 16 < 25)
        2. DungeonRandInt(16) == 10 -> omniboost (2 rolls total)
        3. else DungeonRandInt(4): 0/1/2/3 = Atk/Def/SpA/SpD (3 rolls total)
        a failed boost roll stops after roll 1 (1 roll total)
    * every fed gummi must land on an acceptable outcome (target stat or
      omniboost; omniboost only in --omni-only mode)
"""

import argparse

MULT = 1566083941
MASK = 0xFFFFFFFF
STATS = ("Attack", "Defense", "Sp. Attack", "Sp. Defense")


def lcg(s: int) -> int:
    return (MULT * s + 1) & MASK


def scaled(raw16: int, high: int) -> int:
    return (raw16 * high) >> 16


def gummi_outcome(state: int):
    """(boosted, omni, stat, rolls, first_roll) for a gummi whose rolls start at `state`.

    first_roll is the raw 16-bit value the first (25% outcome) roll returns,
    drawn from the state one LCG step after `state`.
    """
    s = lcg(state)
    first_roll = s >> 16
    if scaled(s >> 16, 100) >= 25:
        return (False, False, None, 1, first_roll)
    s = lcg(s)
    if scaled(s >> 16, 16) == 10:
        return (True, True, None, 2, first_roll)
    s = lcg(s)
    return (True, False, scaled(s >> 16, 4), 3, first_roll)


def solve(count, target, omni_only, seed=0xA61564CD, window=None,
          start=0, partner="together"):
    if window is None:
        window = min(60_000, max(4_000, int(((100 if omni_only else 22) * count + 400) * 1.5)))
    eat_adv = 4 if partner == "wait" else 5
    moves = (3, 4) if partner == "wait" else (3, 4, 5)
    end = start + window
    table_len = end + 9

    states = [0] * table_len
    states[0] = seed
    for j in range(1, table_len):
        states[j] = lcg(states[j - 1])
    rolls_at = [0] * table_len
    accept_at = [0] * table_len
    for j in range(start, table_len):
        boosted, omni, stat, rolls, _first_roll = gummi_outcome(states[j])
        rolls_at[j] = rolls
        ok = boosted and (omni if omni_only else (omni or stat == target))
        accept_at[j] = 1 if ok else 0

    INF = 0x3FFFFFFF
    cost = [[INF] * (end + 1) for _ in range(count + 1)]
    parent = [[-1] * (end + 1) for _ in range(count + 1)]
    cost[0][start] = 0

    for k in range(count):
        ck, pk = cost[k], parent[k]
        nk, npk = cost[k + 1], parent[k + 1]
        for i in range(start, end + 1):
            c = ck[i]
            if c >= INF:
                continue
            for m, adv in enumerate(moves):
                ni = i + adv
                if ni > end:
                    continue
                if c + 1 < ck[ni]:
                    ck[ni] = c + 1
                    pk[ni] = i * 4 + m
            # the gummi's rolls run from the state you eat at, then the eat
            # turn's own advance (+5 together / +4 in Wait there) follows
            if accept_at[i]:
                ni = i + rolls_at[i] + eat_adv
                if ni <= end and c + 1 < nk[ni]:
                    nk[ni] = c + 1
                    npk[ni] = i * 4 + 3

    best_i, best_c = -1, INF
    for i in range(start, end + 1):
        if cost[count][i] < best_c:
            best_c, best_i = cost[count][i], i
    if best_i < 0:
        raise SystemExit("No solution found.")

    # Rebuild the full action chain (start offset -> best). Moves stay within
    # a layer (k unchanged); an eat (code 3) steps from layer k-1 into k.
    actions = []
    k, i = count, best_i
    while not (k == 0 and i == start):
        p = parent[k][i]
        from_i, code = p // 4, p % 4
        actions.append(code)
        i = from_i
        if code == 3:
            k -= 1
    actions.reverse()

    # Split the chain at each eat: the moves before an eat position it.
    segs = []
    counts = [0, 0, 0]
    for code in actions:
        if code == 3:
            g = len(segs)
            prev_end = (start if g == 0
                        else segs[-1]["pos"] + segs[-1]["rolls"] + eat_adv)
            from_i = prev_end + counts[0] * 3 + counts[1] * 4 + counts[2] * 5
            j = from_i  # rolls run from the state you eat at
            boosted, omni, stat, rolls, first_roll = gummi_outcome(states[j])
            segs.append({
                "n3": counts[0],
                "n4": counts[1],
                "n5": counts[2],
                "omni": omni,
                "stat": None if omni else stat,
                "pos": j,
                "rolls": rolls,
                "rng": f"{states[j]:08x}",
                # debug: raw 16-bit value the first (25% outcome) roll returns
                # (drawn from the state one LCG step after `pos`) and the
                # number of PRNG advances since the quicksave when eating.
                "first_roll": first_roll,
                "advances": j,
            })
            counts = [0, 0, 0]
        else:
            counts[code] += 1
    total_moves = sum(s["n3"] + s["n4"] + s["n5"] for s in segs)
    assert total_moves + count == best_c, "inconsistent chain"
    return best_c, segs


def main():
    ap = argparse.ArgumentParser(description="Reference gummi stat-boost manip solver.")
    ap.add_argument("--count", type=int, default=1, help="gummies to feed")
    ap.add_argument("--stat", type=int, default=0, choices=(0, 1, 2, 3),
                    help="stat to optimize for (0 Atk, 1 Def, 2 SpA, 3 SpD)")
    ap.add_argument("--omni-only", action="store_true")
    ap.add_argument("--seed", default="a61564cd")
    ap.add_argument("--window", type=int, default=None)
    ap.add_argument("--start", type=int, default=0,
                    help="PRNG advances done before the manipulation starts")
    ap.add_argument("--partner", choices=("together", "wait"), default="together")
    args = ap.parse_args()

    seed = int(args.seed, 16)
    cost, segs = solve(args.count, args.stat, args.omni_only, seed, args.window,
                       args.start, args.partner)
    mode = "omniboost only" if args.omni_only else STATS[args.stat]
    print(f"count={args.count} mode={mode} partner={args.partner} "
          f"start={args.start} cost={cost}")
    for n, s in enumerate(segs, 1):
        outcome = "Omniboost" if s["omni"] else STATS[s["stat"]]
        print(f"  {n}. swap x{s['n3']}, walk-away x{s['n4']}, stand x{s['n5']}"
              f" -> {outcome} (rolls start at step {s['pos']}, PRNG {s['rng']},"
              f" 1st roll {s['first_roll']} at advance {s['advances'] + 1})")
    seg_str = "|".join(
        f"{s['n3']}/{s['n4']}/{s['n5']}/{1 if s['omni'] else 0}/"
        f"{-1 if s['stat'] is None else s['stat']}/{s['pos']}/"
        f"{s['first_roll']}/{s['advances']}"
        for s in segs
    )
    print(f"MACHINE cost={cost} segs={seg_str}")


if __name__ == "__main__":
    main()
