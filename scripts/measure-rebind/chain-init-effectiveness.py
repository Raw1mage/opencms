#!/usr/bin/env python3
"""
chain-init-effectiveness.py — forward-window measurement of chain.init.injected events

For each chain.init.injected event in a session's runtime event journal, compute
forward-window metrics: rounds completed, token consumption, stuck-episode count.

Usage: ./chain-init-effectiveness.py <session_id> [window_minutes=30]

Output (CSV to stdout):
  session_id, init_ts_iso, event_kind, digest_entry_count, body_char_count,
  chain_break_class, window_rounds, window_input_tokens, window_output_tokens,
  window_stuck_episodes (count of consecutive same-tool-arg runs >= 3 in window)
"""
import json
import os
import sqlite3
import sys
from datetime import datetime

HOME = os.path.expanduser("~")
JOURNAL_DIR = os.path.join(HOME, ".local/share/opencode/storage/session_runtime_event")
DB_DIR = os.path.join(HOME, ".local/share/opencode/storage/session")


def stuck_episodes_in_window(sid: str, start_ms: int, end_ms: int, min_n: int = 3) -> int:
    """Count consecutive same (tool, arg) runs of length >= min_n inside [start_ms, end_ms]."""
    db_path = os.path.join(DB_DIR, f"{sid}.db")
    if not os.path.exists(db_path):
        return 0
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cur = conn.execute("""
            SELECT
                json_extract(payload_json,'$.tool'),
                substr(coalesce(
                    json_extract(payload_json,'$.state.input.filePath'),
                    json_extract(payload_json,'$.state.input.path'),
                    json_extract(payload_json,'$.state.input.command'),
                    json_extract(payload_json,'$.state.input.pattern'),
                    ''
                ), 1, 80),
                cast(json_extract(payload_json,'$.state.time.end') as integer)
            FROM parts
            WHERE type='tool'
              AND json_extract(payload_json,'$.state.status')='completed'
              AND cast(json_extract(payload_json,'$.state.time.end') as integer) BETWEEN ? AND ?
            ORDER BY rowid
        """, (start_ms, end_ms))
        rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        return 0

    episodes = 0
    prev_tool = prev_arg = None
    count = 0
    for tool, arg, _ts in rows:
        if tool == prev_tool and arg == prev_arg:
            count += 1
        else:
            if count >= min_n:
                episodes += 1
            prev_tool, prev_arg = tool, arg
            count = 1
    if count >= min_n:
        episodes += 1
    return episodes


def main():
    if len(sys.argv) < 2:
        print("usage: chain-init-effectiveness.py <session_id> [window_minutes=30]",
              file=sys.stderr)
        sys.exit(1)
    sid = sys.argv[1]
    window_min = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    window_ms = window_min * 60 * 1000

    journal = os.path.join(JOURNAL_DIR, f"{sid}.json")
    if not os.path.exists(journal):
        print(f"error: journal not found at {journal}", file=sys.stderr)
        sys.exit(1)

    with open(journal) as f:
        events = json.load(f)

    init_events = [e for e in events if e.get("eventType") == "chain.init.injected"]
    rounds = [e for e in events if e.get("eventType") == "session.round.telemetry"]

    cols = ["session_id", "init_ts_iso", "event_kind", "digest_entry_count",
            "body_char_count", "chain_break_class", "window_rounds",
            "window_input_tokens", "window_output_tokens", "window_stuck_episodes"]
    print(",".join(cols))

    for ev in init_events:
        start_ms = int(ev["ts"])
        end_ms = start_ms + window_ms
        p = ev.get("payload", {})

        # rounds in window
        in_win = [r for r in rounds if start_ms < int(r["ts"]) <= end_ms]
        rounds_count = len(in_win)
        inp = sum(int(r.get("payload", {}).get("inputTokens", 0) or 0) for r in in_win)
        outp = sum(int(r.get("payload", {}).get("outputTokens", 0) or 0) for r in in_win)
        stuck = stuck_episodes_in_window(sid, start_ms, end_ms)

        iso = datetime.fromtimestamp(start_ms / 1000).strftime("%Y-%m-%dT%H:%M:%S")
        row = [sid, iso,
               p.get("eventKind", ""),
               str(p.get("digestEntryCount", 0)),
               str(p.get("bodyCharCount", 0)),
               p.get("chainBreakClass", ""),
               str(rounds_count), str(inp), str(outp), str(stuck)]
        print(",".join(str(c) for c in row))


if __name__ == "__main__":
    main()
