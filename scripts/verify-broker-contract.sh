#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BROKER_PATH="/usr/local/libexec/panelavo/panelavo-broker"

grep -Fq 'BROKER_ROOT="/usr/local/libexec/panelavo"' "${ROOT}/setup.sh"
grep -Fq 'BROKER_PATH="${BROKER_ROOT}/panelavo-broker"' "${ROOT}/setup.sh"
grep -Fq "${BROKER_PATH}" "${ROOT}/scripts/self-update.sh"
grep -Fq 'brokerProtocolVersion' "${ROOT}/package.json"

package_protocol="$(cd "${ROOT}" && node -p "require('./package.json').panelavo.brokerProtocolVersion")"
client_protocol="$(sed -n 's/^export const CLOUDPANEL_BROKER_PROTOCOL_VERSION = \([0-9][0-9]*\);$/\1/p' "${ROOT}/src/server/cloudpanel/live-client.ts")"
bridge_protocol="$(sed -n 's/^const PANELAVO_BROKER_PROTOCOL_VERSION = \([0-9][0-9]*\);$/\1/p' "${ROOT}/scripts/cloudpanel-bridge.php")"
if [ -z "${package_protocol}" ] || [ "${package_protocol}" != "${client_protocol}" ] || [ "${package_protocol}" != "${bridge_protocol}" ]; then
  echo "broker protocol versions are not synchronized" >&2
  exit 1
fi

if grep -Eq 'NOPASSWD:.*(/usr/bin/php|/usr/bin/clpctl)([ ,]|$)' "${ROOT}/setup.sh"; then
  echo "setup.sh grants unsafe raw PHP or clpctl sudo access" >&2
  exit 1
fi

grep -Fq '/api/health/ready' "${ROOT}/setup.sh"

check_line="$(grep -n 'EXPECTED_BROKER_PROTOCOL=' "${ROOT}/scripts/self-update.sh" | head -n 1 | cut -d: -f1)"
build_line="$(grep -n 'Installing and building' "${ROOT}/scripts/self-update.sh" | head -n 1 | cut -d: -f1)"
deploy_line="$(grep -n 'Deploying staged build' "${ROOT}/scripts/self-update.sh" | head -n 1 | cut -d: -f1)"
if [ "${check_line}" -ge "${build_line}" ] || [ "${check_line}" -ge "${deploy_line}" ]; then
  echo "self-update checks the broker too late" >&2
  exit 1
fi

echo "Panelavo broker source contract verified."
