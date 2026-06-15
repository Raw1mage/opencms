#!/usr/bin/env bash

set -euo pipefail

user_name="${1:-}"
if [[ -z "${user_name}" ]]; then
  echo "[opencms-daemon-launch] missing username" >&2
  exit 1
fi

uid_value="$(id -u "${user_name}" 2>/dev/null || true)"
if [[ -z "${uid_value}" ]]; then
  echo "[opencms-daemon-launch] failed to resolve uid for ${user_name}" >&2
  exit 1
fi

passwd_line="$(getent passwd "${user_name}" || true)"
if [[ -z "${passwd_line}" ]]; then
  echo "[opencms-daemon-launch] failed to resolve passwd entry for ${user_name}" >&2
  exit 1
fi

home_dir="$(printf '%s' "${passwd_line}" | cut -d: -f6)"
if [[ -z "${home_dir}" || "${home_dir}" != /* ]]; then
  home_dir="/home/${user_name}"
fi

# ── Allowlist: save daemon-relevant vars, then wipe all OPENCODE_* ──
# This prevents the daemon from inheriting gateway-only vars (worker flags,
# routing flags, per-user-daemon management) that make it think it's a gateway.
_save_bin="${OPENCODE_BIN:-/usr/local/bin/opencode}"
_save_bun_bin="${OPENCODE_BUN_BIN:-}"
_save_transport="${OPENCODE_USER_DAEMON_TRANSPORT:-http}"
_save_global_fs="${OPENCODE_ALLOW_GLOBAL_FS_BROWSE:-}"
_save_frontend_path="${OPENCODE_FRONTEND_PATH:-}"
_save_repo_root="${OPENCODE_REPO_ROOT:-}"
_save_webctl_path="${OPENCODE_WEBCTL_PATH:-}"
# TEMP RCA probe (issue_20260615): allow the session cache-coherence probe flag
# through the wipe so it reaches the daemon. Remove with the probe.
_save_coherence_probe="${OPENCODE_SESSION_COHERENCE_PROBE:-}"

# Read port config before wiping
port_base="${OPENCODE_PER_USER_DAEMON_PORT_BASE:-41000}"
port_span="${OPENCODE_PER_USER_DAEMON_PORT_SPAN:-20000}"
if ! [[ "${port_base}" =~ ^[0-9]+$ ]]; then port_base=41000; fi
if ! [[ "${port_span}" =~ ^[0-9]+$ ]] || [[ "${port_span}" -le 0 ]]; then port_span=20000; fi
port="$((port_base + (uid_value % port_span)))"

# Wipe ALL OPENCODE_* inherited from gateway EnvironmentFiles
while IFS= read -r var; do
  unset "${var}"
done < <(env | grep -oP '^OPENCODE_\w+' || true)

# ── Re-export only what the daemon needs ──
export HOME="${home_dir}"
export XDG_CONFIG_HOME="${home_dir}/.config"
export XDG_DATA_HOME="${home_dir}/.local/share"
export XDG_STATE_HOME="${home_dir}/.local/state"
export XDG_CACHE_HOME="${home_dir}/.cache"
export OPENCODE_WEB_NO_OPEN=1
export OPENCODE_USER_DAEMON_MODE=1
[[ -n "${_save_bun_bin}" ]] && export OPENCODE_BUN_BIN="${_save_bun_bin}"
[[ -n "${_save_global_fs}" ]] && export OPENCODE_ALLOW_GLOBAL_FS_BROWSE="${_save_global_fs}"
[[ -n "${_save_frontend_path}" ]] && export OPENCODE_FRONTEND_PATH="${_save_frontend_path}"
[[ -n "${_save_repo_root}" ]] && export OPENCODE_REPO_ROOT="${_save_repo_root}"
[[ -n "${_save_webctl_path}" ]] && export OPENCODE_WEBCTL_PATH="${_save_webctl_path}"
[[ -n "${_save_coherence_probe}" ]] && export OPENCODE_SESSION_COHERENCE_PROBE="${_save_coherence_probe}"

mkdir -p "${XDG_CONFIG_HOME}" "${XDG_DATA_HOME}" "${XDG_STATE_HOME}" "${XDG_CACHE_HOME}"

read -r -a opencode_cmd <<< "${_save_bin}"
if [[ "${#opencode_cmd[@]}" -eq 0 ]]; then
  opencode_cmd=(/usr/local/bin/opencode)
fi

if [[ "${_save_transport}" == "unix" ]]; then
  runtime_dir="/run/user/${uid_value}"
  socket_dir="${runtime_dir}/opencode"
  socket_path="${socket_dir}/daemon.sock"
  mkdir -p "${socket_dir}"
  chmod 700 "${socket_dir}"
  rm -f "${socket_path}"
  export XDG_RUNTIME_DIR="${runtime_dir}"
  exec "${opencode_cmd[@]}" serve --unix-socket "${socket_path}"
fi

exec "${opencode_cmd[@]}" serve --hostname 127.0.0.1 --port "${port}"
