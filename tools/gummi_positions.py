#!/usr/bin/env python3
"""
Extract the PRNG advance counts at which eating a gummi lands on the target
stat (or an omniboost).

This is the raw "good eat" list, not an optimal path: every Advances value
(from the gummi debug column) whose boost rolls give an acceptable outcome.
You can sit on any listed advance count before eating — with the partner on
"Let's go together" every count >= 3 (and 0) is reachable from the quicksave
using swaps/walk-aways/stands (+3/+4/+5).

The list is dense: a boost happens 25% of the time, and within a boost the
omniboost is 1/16 and each stat 15/64, so roughly 1 in 13.5 positions
qualifies for one stat.

    python tools/gummi_positions.py --stat 0            # Attack or omni
    python tools/gummi_positions.py --omni-only
    python tools/gummi_positions.py --count 1000
"""

import argparse

MULT = 1566083941
MASK = 0xFFFFFFFF
SEED = 0xA61564CD
STATS = ("Attack", "Defense", "Sp. Attack", "Sp. Defense")


def lcg(s: int) -> int:
    return (MULT * s + 1) & MASK


def scaled(raw16: int, high: int) -> int:
    return (raw16 * high) >> 16


def main() -> None:
    ap = argparse.ArgumentParser(
        description="List every advance count that yields an acceptable gummi boost.")
    ap.add_argument("--stat", type=int, default=0, choices=(0, 1, 2, 3),
                    help="stat to optimize for (0 Atk, 1 Def, 2 SpA, 3 SpD)")
    ap.add_argument("--omni-only", action="store_true")
    ap.add_argument("--count", type=int, default=1000,
                    help="how many positions to list")
    ap.add_argument("--seed", default="a61564cd")
    args = ap.parse_args()

    seed = int(args.seed, 16)
    mode = "omniboost only" if args.omni_only else f"{STATS[args.stat]} or omniboost"
    print(f"# gummi eat positions ({mode}, seed {args.seed})")

    state = seed
    j = 0  # advances since the quicksave at the moment of eating
    found = 0
    while found < args.count:
        s = lcg(state)  # the first roll draws from the state one step after j
        first = s >> 16
        if scaled(first, 100) < 25:  # a boost happens at all
            s2 = lcg(s)
            omni = scaled(s2 >> 16, 16) == 10
            stat = None if omni else scaled(lcg(s2) >> 16, 4)
            if omni if args.omni_only else (omni or stat == args.stat):
                print(j)
                found += 1
        state = lcg(state)
        j += 1


if __name__ == "__main__":
    main()
