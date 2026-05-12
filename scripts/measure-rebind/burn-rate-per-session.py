#!/usr/bin/env python3
"""
burn-rate-per-session.py — per-minute token consumption from runtime event journal

Usage: ./burn-rate-per-session.py <session_id> [bucket_minutes=1]

Output (CSV to stdout):
  session_id, minute_bucket_iso, rounds, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, total_tokens
"""
import json
import os
import sys
from datetime import datetime
from collections import defaultdict

HOME = os.path.expanduser("~")
JOURNAL_DIR = os.path.join(HOME, ".local/share/opencode/storage/session_runtime_event")


def main():
    if len(sys.argv) < 2:
        print("usage: burn-rate-per-session.py <session_id> [bucket_minutes=1]", file=sys.stderr)
        sys.exit(1)
    sid = sys.argv[1]
    bucket_min = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    bucket_ms = bucket_min * 60 * 1000

    path = os.path.join(JOURNAL_DIR, f"{sid}.json")
    if not os.path.exists(path):
        print(f"error: journal not found at {path}", file=sys.stderr)
        sys.exit(1)

    with open(path) as f:
        events = json.load(f)

    # bucket[bucket_start_ms] = aggregate dict
    buckets = defaultdict(lambda: {
        "rounds": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 0,
    })

    for e in events:
        if e.get("eventType") != "session.round.telemetry":
            continue
        ts = int(e.get("ts", 0))
        bucket = (ts // bucket_ms) * bucket_ms
        p = e.get("payload", {})
        agg = buckets[bucket]
        agg["rounds"] += 1
        agg["input_tokens"] += int(p.get("inputTokens", 0) or 0)
        agg["output_tokens"] += int(p.get("outputTokens", 0) or 0)
        agg["cache_read_tokens"] += int(p.get("cacheReadTokens", 0) or 0)
        agg["cache_write_tokens"] += int(p.get("cacheWriteTokens", 0) or 0)
        agg["total_tokens"] += int(p.get("totalTokens", 0) or 0)

    # CSV header
    cols = ["session_id", "bucket_iso", "rounds", "input_tokens", "output_tokens",
            "cache_read_tokens", "cache_write_tokens", "total_tokens"]
    print(",".join(cols))
    for bucket in sorted(buckets):
        iso = datetime.fromtimestamp(bucket / 1000).strftime("%Y-%m-%dT%H:%M:%S")
        agg = buckets[bucket]
        row = [sid, iso, str(agg["rounds"]), str(agg["input_tokens"]),
               str(agg["output_tokens"]), str(agg["cache_read_tokens"]),
               str(agg["cache_write_tokens"]), str(agg["total_tokens"])]
        print(",".join(row))


if __name__ == "__main__":
    main()
