#!/usr/bin/env bash
# detect-stuck-episodes.sh — find consecutive identical tool calls in a session
#
# Usage: ./detect-stuck-episodes.sh <session_id> [min_consecutive=3]
#
# Output: TSV with columns
#   session_id, tool, arg (truncated 80 chars), consecutive_count,
#   start_ts (local), end_ts (local)

set -euo pipefail

SID="${1:?session_id required}"
MIN_N="${2:-3}"
SDB="$HOME/.local/share/opencode/storage/session/${SID}.db"

if [ ! -f "$SDB" ]; then
  echo "error: session db not found at $SDB" >&2
  exit 1
fi

# Walk the parts table in rowid order, group by adjacent same (tool, arg),
# emit only groups with count >= MIN_N. Done in awk because sqlite GROUP BY
# loses ordering semantics needed for "consecutive" detection.

sqlite3 -readonly "$SDB" "
SELECT
  json_extract(payload_json,'\$.tool') AS tool,
  substr(coalesce(
    json_extract(payload_json,'\$.state.input.filePath'),
    json_extract(payload_json,'\$.state.input.path'),
    json_extract(payload_json,'\$.state.input.command'),
    json_extract(payload_json,'\$.state.input.pattern'),
    ''
  ), 1, 80) AS arg,
  cast(json_extract(payload_json,'\$.state.time.end') as integer) AS ts_ms
FROM parts
WHERE type='tool'
  AND json_extract(payload_json,'\$.state.status')='completed'
ORDER BY rowid;
" | awk -F'|' -v sid="$SID" -v min_n="$MIN_N" '
BEGIN { OFS = "\t"; prev_tool=""; prev_arg=""; count=0; start_ts=0 }
{
  tool=$1; arg=$2; ts=$3
  if (tool == prev_tool && arg == prev_arg) {
    count++
    end_ts = ts
  } else {
    if (count >= min_n) {
      printf "%s\t%s\t%s\t%d\t%s\t%s\n", sid, prev_tool, prev_arg, count, strftime("%H:%M:%S", start_ts/1000), strftime("%H:%M:%S", end_ts/1000)
    }
    prev_tool=tool; prev_arg=arg; count=1; start_ts=ts; end_ts=ts
  }
}
END {
  if (count >= min_n) {
    printf "%s\t%s\t%s\t%d\t%s\t%s\n", sid, prev_tool, prev_arg, count, strftime("%H:%M:%S", start_ts/1000), strftime("%H:%M:%S", end_ts/1000)
  }
}'
