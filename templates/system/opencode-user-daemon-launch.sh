#!/usr/bin/env bash

set -euo pipefail

user_name="${1:-}"
if [[ -z "${user_name}" ]]; then
  echo "[opencode-user-daemon-launch] missing username" >&2
  exit 1
fi

uid_value="$(id -u "${user_name}" 2>/dev/null || true)"
if [[ -z "${uid_value}" ]]; then
  echo "[opencode-user-daemon-launch] failed to resolve uid for ${user_name}" >&2
  exit 1
fi

passwd_line="$(getent passwd "${user_name}" || true)"
if [[ -z "${passwd_line}" ]]; then
  echo "[opencode-user-daemon-launch] failed to resolve passwd entry for ${user_name}" >&2
  exit 1
fi

home_dir="$(printf '%s' "${passwd_line}" | cut -d: -f6)"
if [[ -z "${home_dir}" || "${home_dir}" != /* ]]; then
  home_dir="/home/${user_name}"
fi

port_base="${OPENCODE_PER_USER_DAEMON_PORT_BASE:-41000}"
port_span="${OPENCODE_PER_USER_DAEMON_PORT_SPAN:-20000}"
if ! [[ "${port_base}" =~ ^[0-9]+$ ]]; then
  port_base=41000
fi
if ! [[ "${port_span}" =~ ^[0-9]+$ ]] || [[ "${port_span}" -le 0 ]]; then
  port_span=20000
fi

port="$((port_base + (uid_value % port_span)))"

export HOME="${home_dir}"
export XDG_CONFIG_HOME="${home_dir}/.config"
export XDG_DATA_HOME="${home_dir}/.local/share"
export XDG_STATE_HOME="${home_dir}/.local/state"
export XDG_CACHE_HOME="${home_dir}/.cache"
export OPENCODE_WEB_NO_OPEN=1
export OPENCODE_USER_DAEMON_MODE=1

mkdir -p "${XDG_CONFIG_HOME}" "${XDG_DATA_HOME}" "${XDG_STATE_HOME}" "${XDG_CACHE_HOME}"

exec /usr/local/bin/opencode serve --hostname 127.0.0.1 --port "${port}"
