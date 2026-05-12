#!/usr/bin/env python3
"""
reduce-cohort.py — combine per-session burn-rate / effectiveness CSVs into a cohort summary

Usage: ./reduce-cohort.py <cohort_label> <session_id...>

Reads the corresponding {burn,effect}/${sid}.csv files from ~/measure-rebind-data/.
Output (single-row TSV summary to stdout):
  cohort_label, n_sessions, total_rounds, total_input_tokens, total_output_tokens,
  median_burn_rate_tokens_per_min, p95_burn_rate, total_chain_init_dispatches,
  median_stuck_episodes_per_session, p95_stuck_episodes
"""
import csv
import os
import statistics
import sys

DATA_DIR = os.path.expanduser("~/measure-rebind-data")


def read_burn(sid: str):
    path = os.path.join(DATA_DIR, "burn", f"{sid}.csv")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))


def read_effect(sid: str):
    path = os.path.join(DATA_DIR, "effect", f"{sid}.csv")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))


def main():
    if len(sys.argv) < 3:
        print("usage: reduce-cohort.py <cohort_label> <session_id...>", file=sys.stderr)
        sys.exit(1)
    cohort = sys.argv[1]
    sids = sys.argv[2:]

    burn_rates_per_min = []  # tokens/min per bucket across all sessions
    total_rounds = 0
    total_input = 0
    total_output = 0
    stuck_per_session = []
    chain_init_count = 0

    for sid in sids:
        burn = read_burn(sid)
        for row in burn:
            rounds = int(row["rounds"])
            total_rounds += rounds
            input_t = int(row["input_tokens"])
            output_t = int(row["output_tokens"])
            total_input += input_t
            total_output += output_t
            if rounds > 0:
                burn_rates_per_min.append(input_t + output_t)

        effect = read_effect(sid)
        chain_init_count += len(effect)
        session_stuck = sum(int(r["window_stuck_episodes"]) for r in effect)
        stuck_per_session.append(session_stuck)

    def p(xs, q):
        if not xs:
            return 0
        xs = sorted(xs)
        idx = max(0, min(len(xs) - 1, int(len(xs) * q)))
        return xs[idx]

    cols = ["cohort_label", "n_sessions", "total_rounds", "total_input_tokens",
            "total_output_tokens", "median_burn_tokens_per_min",
            "p95_burn_tokens_per_min", "total_chain_init_dispatches",
            "median_stuck_per_session", "p95_stuck_per_session"]
    print("\t".join(cols))
    print("\t".join(str(x) for x in [
        cohort, len(sids), total_rounds, total_input, total_output,
        statistics.median(burn_rates_per_min) if burn_rates_per_min else 0,
        p(burn_rates_per_min, 0.95),
        chain_init_count,
        statistics.median(stuck_per_session) if stuck_per_session else 0,
        p(stuck_per_session, 0.95),
    ]))


if __name__ == "__main__":
    main()
