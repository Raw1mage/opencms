#!/usr/bin/env bash
# Isolate this beta worktree's runtime state from the main opencode install.
# Without this, bun test / bun run dev in beta will share
# ~/.config/opencode/accounts.json with main and can wipe real accounts
# (see memory feedback_beta_xdg_isolation — 5 codex accounts lost 2026-04-18).
#
# Usage: source this before running anything that touches runtime state.
#   source script/beta-env.sh
#   bun test ...

BETA_XDG_ROOT="${BETA_XDG_ROOT:-/tmp/opencode-beta-xdg}"
export XDG_CONFIG_HOME="${BETA_XDG_ROOT}/config"
export XDG_DATA_HOME="${BETA_XDG_ROOT}/data"
export XDG_STATE_HOME="${BETA_XDG_ROOT}/state"
mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME/opencode" "$XDG_STATE_HOME/opencode"

echo "[beta-env] isolated runtime root: $BETA_XDG_ROOT" >&2
