#!/usr/bin/env bash
set -euo pipefail

TARGET_USER="betaman"
BETA_DIR="/home/pkcs12/projects/opencode-beta"

if ! command -v sudo >/dev/null 2>&1; then
  echo "Error: sudo is not installed." >&2
  exit 1
fi

if [ ! -d "$BETA_DIR" ]; then
  echo "Error: beta directory not found: $BETA_DIR" >&2
  exit 1
fi

exec sudo -u "$TARGET_USER" -H bash -lc "cd '$BETA_DIR' && bun run dev"
