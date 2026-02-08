#!/bin/bash
# deep-grep.sh: Reliably extract context from large logs without UI placeholders.

LOG_FILE=$1
PATTERN=$2
LINES=${3:-10}

if [ -z "$LOG_FILE" ] || [ -z "$PATTERN" ]; then
  echo "Usage: $0 <log_file> <pattern> [lines]"
  exit 1
fi

# Search for the pattern and get the last occurrence with context
# We use tail to avoid huge outputs and cat to ensure raw streaming
grep -a -C "$LINES" "$PATTERN" "$LOG_FILE" | grep -v "INFO evaluate" | grep -v "INFO evaluated" | tail -n $((LINES * 2))
