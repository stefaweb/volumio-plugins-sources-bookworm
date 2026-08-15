#!/bin/bash
# Apply or release per-radio rfkill policy.
# Enumerates by type (bluetooth, wlan), never by index.
# wifi.state / bluetooth.state: on = radio allowed, off = plugin holds a soft block.
# Default (reconcile): soft-block each type whose state is off. Never unblock.
# Mode release / release-wifi / release-bluetooth: soft-unblock those types, then reconcile.

set -eu

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WIFI_STATE_FILE="${PLUGIN_DIR}/wifi.state"
BT_STATE_FILE="${PLUGIN_DIR}/bluetooth.state"
MODE_FILE="${PLUGIN_DIR}/flightmode.mode"
PATH_IN="${PLUGIN_DIR}/units/volumio-flightmode.path.in"
PATH_GEN="${PLUGIN_DIR}/units/volumio-flightmode.path"
RFKILL_CLASS="/sys/class/rfkill"

GENERATE_ONLY=0
if [ "${1:-}" = "--generate-path" ]; then
  GENERATE_ONLY=1
fi

is_watched_type() {
  case "$1" in
    bluetooth|wlan) return 0 ;;
    *) return 1 ;;
  esac
}

list_watched() {
  local d t
  if [ ! -d "${RFKILL_CLASS}" ]; then
    return 0
  fi
  for d in "${RFKILL_CLASS}"/rfkill*; do
    [ -e "${d}/type" ] || continue
    t="$(cat "${d}/type" 2>/dev/null || true)"
    if is_watched_type "${t}"; then
      printf '%s\n' "${d}"
    fi
  done
}

device_type() {
  cat "${1}/type" 2>/dev/null || true
}

generate_path_unit() {
  local tmp insert d
  if [ ! -f "${PATH_IN}" ]; then
    echo "flightmode-apply: missing ${PATH_IN}" >&2
    return 1
  fi
  tmp="${PATH_GEN}.tmp"
  insert="PathChanged=${RFKILL_CLASS}"$'\n'
  while IFS= read -r d; do
    [ -n "${d}" ] || continue
    if [ -e "${d}/soft" ]; then
      insert="${insert}PathChanged=${d}/soft"$'\n'
    fi
    if [ -e "${d}/hard" ]; then
      insert="${insert}PathChanged=${d}/hard"$'\n'
    fi
  done < <(list_watched)

  awk -v insert="${insert}" '
    $0 == "# FLIGHTMODE_PATHS" { printf "%s", insert; next }
    { print }
  ' "${PATH_IN}" > "${tmp}"

  if [ -f "${PATH_GEN}" ] && cmp -s "${tmp}" "${PATH_GEN}"; then
    rm -f "${tmp}"
    return 1
  fi
  mv "${tmp}" "${PATH_GEN}"
  return 0
}

soft_write() {
  local d="$1"
  local value="$2"
  local hard soft
  hard="$(cat "${d}/hard" 2>/dev/null || echo 1)"
  soft="$(cat "${d}/soft" 2>/dev/null || echo "${value}")"
  if [ "${hard}" != "0" ]; then
    return 0
  fi
  if [ "${soft}" = "${value}" ]; then
    return 0
  fi
  echo "${value}" > "${d}/soft" 2>/dev/null || true
}

read_trimmed() {
  local file="$1"
  local fallback="$2"
  if [ -f "${file}" ]; then
    tr -d '[:space:]' < "${file}"
  else
    printf '%s' "${fallback}"
  fi
}

apply_reconcile() {
  local d t
  local wifi bt
  wifi="$(read_trimmed "${WIFI_STATE_FILE}" on)"
  bt="$(read_trimmed "${BT_STATE_FILE}" on)"
  while IFS= read -r d; do
    [ -n "${d}" ] || continue
    t="$(device_type "${d}")"
    if [ "${t}" = "wlan" ] && [ "${wifi}" = "off" ]; then
      soft_write "${d}" 1
    elif [ "${t}" = "bluetooth" ] && [ "${bt}" = "off" ]; then
      soft_write "${d}" 1
    fi
  done < <(list_watched)
}

apply_release_type() {
  local want="$1"
  local d t
  while IFS= read -r d; do
    [ -n "${d}" ] || continue
    t="$(device_type "${d}")"
    if [ "${want}" = "all" ] || [ "${t}" = "${want}" ]; then
      soft_write "${d}" 0
    fi
  done < <(list_watched)
}

PATH_CHANGED=0
if generate_path_unit; then
  PATH_CHANGED=1
fi

if [ "${GENERATE_ONLY}" -eq 1 ]; then
  exit 0
fi

MODE="$(read_trimmed "${MODE_FILE}" reconcile)"

case "${MODE}" in
  release)
    apply_release_type all
    printf '%s\n' 'reconcile' > "${MODE_FILE}" || true
    ;;
  release-wifi)
    apply_release_type wlan
    printf '%s\n' 'reconcile' > "${MODE_FILE}" || true
    ;;
  release-bluetooth)
    apply_release_type bluetooth
    printf '%s\n' 'reconcile' > "${MODE_FILE}" || true
    ;;
  *)
    apply_reconcile
    ;;
esac

if [ "${PATH_CHANGED}" -eq 1 ]; then
  /bin/systemctl daemon-reload >/dev/null 2>&1 || true
  if /bin/systemctl is-enabled --quiet volumio-flightmode.path 2>/dev/null; then
    /bin/systemctl restart volumio-flightmode.path >/dev/null 2>&1 || true
  fi
fi

exit 0
