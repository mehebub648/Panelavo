#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${1:-}"
BRANCH="${2:-main}"
APP_ROOT="${3:-}"
DATA_DIR="${PANEL_DATA_DIR:-${APP_ROOT}/.data}"
STATE_FILE="${DATA_DIR}/update-state.json"
LOG_FILE="${DATA_DIR}/update.log"
LOCK_DIR="${DATA_DIR}/update.lock"
TEMP_DIR=""
LOCK_ACQUIRED=false
BROKER_PATH="/usr/local/libexec/panelavo/panelavo-broker"

mkdir -p "${DATA_DIR}"
exec >>"${LOG_FILE}" 2>&1
write_state() {
  STATUS="$1" ERROR_TEXT="${2:-}" REPOSITORY="${REPOSITORY}" BRANCH="${BRANCH}" APP_ROOT="${APP_ROOT}" STATE_FILE="${STATE_FILE}" node <<'NODE'
const fs = require('node:fs');
let old = {}; try { old = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8')); } catch {}
let version = 'unknown'; try { version = JSON.parse(fs.readFileSync(process.env.APP_ROOT + '/package.json', 'utf8')).version; } catch {}
const next = { ...old, status: process.env.STATUS, currentVersion: version, repository: process.env.REPOSITORY, branch: process.env.BRANCH, logFile: process.env.APP_ROOT + '/.data/update.log' };
if (process.env.ERROR_TEXT) next.error = process.env.ERROR_TEXT; else delete next.error;
if (process.env.STATUS === 'updating') next.startedAt ||= new Date().toISOString();
if (process.env.STATUS === 'complete' || process.env.STATUS === 'failed') next.completedAt = new Date().toISOString();
fs.writeFileSync(process.env.STATE_FILE + '.tmp', JSON.stringify(next), { mode: 0o600 });
fs.renameSync(process.env.STATE_FILE + '.tmp', process.env.STATE_FILE);
NODE
}
cleanup() { [ -n "${TEMP_DIR}" ] && rm -rf "${TEMP_DIR}"; [ "${LOCK_ACQUIRED}" = true ] && rmdir "${LOCK_DIR}" 2>/dev/null || true; }
failed() { code=$?; write_state failed "Update failed. Review ${LOG_FILE}." || true; cleanup; exit "$code"; }
trap failed ERR
trap cleanup EXIT

[[ "${REPOSITORY}" =~ ^https://[^[:space:]]+\.git$ ]] || { echo "Invalid repository URL"; false; }
[[ "${BRANCH}" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Invalid branch"; false; }
[ -d "${APP_ROOT}/.data" ] && [ -f "${APP_ROOT}/package.json" ] || { echo "Invalid application root"; false; }
mkdir "${LOCK_DIR}" 2>/dev/null || { echo "An update is already running"; false; }
LOCK_ACQUIRED=true
write_state updating
TEMP_DIR="$(mktemp -d "${DATA_DIR}/update.XXXXXX")"
SOURCE="${TEMP_DIR}/source"
echo "[$(date -Is)] Fetching ${REPOSITORY} (${BRANCH})"
/usr/bin/git clone --depth 1 --single-branch --branch "${BRANCH}" -- "${REPOSITORY}" "${SOURCE}"
[ "$(node -p "require('${SOURCE}/package.json').name")" = "panelavo" ] || { echo "Repository is not Panelavo"; false; }
[ -f "${SOURCE}/ecosystem.config.js" ] && [ -f "${SOURCE}/pnpm-lock.yaml" ] || { echo "Required application files are missing"; false; }
COMMIT="$(/usr/bin/git -C "${SOURCE}" rev-parse HEAD)"

# Host migrations are root-owned and never run from a configurable update
# repository. Refuse the release before build/deploy unless its required
# broker protocol is already installed and healthy.
EXPECTED_BROKER_PROTOCOL="$(node -p "require('${SOURCE}/package.json').panelavo?.brokerProtocolVersion ?? ''")"
[[ "${EXPECTED_BROKER_PROTOCOL}" =~ ^[0-9]+$ ]] || { echo "Release does not declare a broker protocol version"; false; }
[ -x "${BROKER_PATH}" ] || { echo "This update requires the root-owned Panelavo broker. Run 'sudo bash setup.sh' from a trusted checkout before updating."; false; }
BROKER_HEALTH="$(printf '{\"protocolVersion\":%s,\"action\":\"broker-health\"}' "${EXPECTED_BROKER_PROTOCOL}" | /usr/bin/sudo -n "${BROKER_PATH}")" || { echo "The installed Panelavo broker is unavailable. Run 'sudo bash setup.sh' from a trusted checkout."; false; }
BROKER_HEALTH="${BROKER_HEALTH}" EXPECTED_BROKER_PROTOCOL="${EXPECTED_BROKER_PROTOCOL}" node <<'NODE'
const result = JSON.parse(process.env.BROKER_HEALTH || '{}');
const data = result.data || {};
if (!result.ok || data.protocolVersion !== Number(process.env.EXPECTED_BROKER_PROTOCOL) || data.privileged !== true || data.cloudPanelAvailable !== true) {
  console.error('The installed Panelavo broker is incompatible with this release. Run sudo bash setup.sh from a trusted checkout.');
  process.exit(1);
}
NODE

echo "[$(date -Is)] Installing and building ${COMMIT}"
(cd "${SOURCE}" && npx -y pnpm@10.12.1 install --frozen-lockfile && npx -y pnpm@10.12.1 build)
echo "[$(date -Is)] Deploying staged build"
/usr/bin/rsync -a --delete --exclude .git --exclude .data --exclude .env.local "${SOURCE}/" "${APP_ROOT}/"
INSTALLED_COMMIT="${COMMIT}" STATE_FILE="${STATE_FILE}" APP_ROOT="${APP_ROOT}" node <<'NODE'
const fs = require('node:fs'); const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
state.installedCommit = process.env.INSTALLED_COMMIT; state.remoteCommit = process.env.INSTALLED_COMMIT;
state.status = 'reloading';
try { state.currentVersion = JSON.parse(fs.readFileSync(process.env.APP_ROOT + '/package.json', 'utf8')).version; } catch {}
fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state), { mode: 0o600 });
NODE
echo "[$(date -Is)] Reloading Panelavo"
/usr/local/bin/pm2 save
# PM2 terminates the old panel's process tree during reload, including this
# worker. Clean staging first and let the new process complete the persisted
# reloading handoff by comparing its PID with previousPid.
cleanup
TEMP_DIR=""
LOCK_ACQUIRED=false
/usr/local/bin/pm2 startOrReload "${APP_ROOT}/ecosystem.config.js"
