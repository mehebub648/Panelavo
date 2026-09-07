#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/self-update.sh"
BASH_BIN="$(command -v bash)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

# Execute the actual preflight in isolated PATHs, without running an update.
PREFLIGHT="$(sed -n '/^PM2_BIN=/,/^UNWRITABLE_DIR=/{ /^UNWRITABLE_DIR=/d; p; }' "${SCRIPT}")"
[ -n "${PREFLIGHT}" ]
for location in shared distribution; do
  mkdir "${TEST_DIR}/${location}"
  printf '#!/bin/sh\nexit 0\n' > "${TEST_DIR}/${location}/pm2"
  chmod 755 "${TEST_DIR}/${location}/pm2"
  resolved="$(PATH="${TEST_DIR}/${location}" "${BASH_BIN}" -c 'set -e; abort() { echo "$1" >&2; exit 42; }; eval "$1"; printf "%s" "$PM2_BIN"' test "${PREFLIGHT}")"
  [ "${resolved}" = "${TEST_DIR}/${location}/pm2" ]
done

mkdir "${TEST_DIR}/missing"
code=0
PATH="${TEST_DIR}/missing" "${BASH_BIN}" -c 'set -e; abort() { echo "$1" >&2; exit 42; }; eval "$1"' test "${PREFLIGHT}" 2>"${TEST_DIR}/error" || code=$?
[ "${code}" -eq 42 ]
grep -Fq 'PM2 is unavailable' "${TEST_DIR}/error"
grep -Fq '"${PM2_BIN}" save' "${SCRIPT}"
grep -Fq '"${PM2_BIN}" startOrReload "${APP_ROOT}/ecosystem.config.js" --only panelavo' "${SCRIPT}"
preflight_line="$(grep -n '^PM2_BIN=' "${SCRIPT}" | cut -d: -f1)"
clone_line="$(grep -n '^/usr/bin/git clone' "${SCRIPT}" | cut -d: -f1)"
[ "${preflight_line}" -lt "${clone_line}" ]
echo 'Self-update PM2 preflight and reload checks passed.'
