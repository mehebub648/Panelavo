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
FAILURE_MESSAGE=""

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
failed() { code=$?; write_state failed "${FAILURE_MESSAGE:-Update failed. Review ${LOG_FILE}.}" || true; cleanup; exit "$code"; }
abort() { FAILURE_MESSAGE="$1"; echo "$1"; return 1; }
trap failed ERR
trap cleanup EXIT

[[ "${REPOSITORY}" =~ ^https://[^[:space:]]+\.git$ ]] || abort "The configured update repository is invalid."
[[ "${BRANCH}" =~ ^[A-Za-z0-9._/-]+$ ]] || abort "The configured update branch is invalid."
[ -d "${APP_ROOT}/.data" ] && [ -f "${APP_ROOT}/package.json" ] || abort "The Panelavo application root is invalid."
mkdir "${LOCK_DIR}" 2>/dev/null || abort "An update is already running."
LOCK_ACQUIRED=true
write_state updating
UNWRITABLE_DIR="$(find "${APP_ROOT}" -path "${APP_ROOT}/.data" -prune -o -type d ! -writable -print -quit 2>/dev/null)" \
  || abort "Panelavo could not verify application directory permissions. Run 'sudo bash setup.sh' from a trusted checkout before updating."
[ -z "${UNWRITABLE_DIR}" ] \
  || abort "Panelavo application files are not writable by the panel site user. Run 'sudo bash setup.sh' from a trusted checkout before updating."
TEMP_DIR="$(mktemp -d "${DATA_DIR}/update.XXXXXX")"
SOURCE="${TEMP_DIR}/source"
echo "[$(date -Is)] Fetching ${REPOSITORY} (${BRANCH})"
/usr/bin/git clone --depth 1 --single-branch --branch "${BRANCH}" -- "${REPOSITORY}" "${SOURCE}"
[ "$(node -p "require('${SOURCE}/package.json').name")" = "panelavo" ] || abort "The configured repository is not a Panelavo release."
[ -f "${SOURCE}/ecosystem.config.js" ] && [ -f "${SOURCE}/pnpm-lock.yaml" ] || abort "The release is missing required Panelavo application files."
COMMIT="$(/usr/bin/git -C "${SOURCE}" rev-parse HEAD)"
CURRENT_VERSION="$(node -p "require('${APP_ROOT}/package.json').version ?? ''")"
RELEASE_VERSION="$(node -p "require('${SOURCE}/package.json').version ?? ''")"
VERSION_RELATION="$(CURRENT_VERSION="${CURRENT_VERSION}" RELEASE_VERSION="${RELEASE_VERSION}" node <<'NODE'
const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const current = pattern.exec(process.env.CURRENT_VERSION || '');
const release = pattern.exec(process.env.RELEASE_VERSION || '');
if (!current || !release) process.exit(1);
for (let index = 1; index <= 3; index += 1) {
  const difference = Number(current[index]) - Number(release[index]);
  if (difference !== 0) {
    process.stdout.write(difference < 0 ? 'newer' : 'older');
    process.exit(0);
  }
}
process.stdout.write('same');
NODE
)" || abort "Panelavo could not compare the installed and repository release versions."
if [ "${VERSION_RELATION}" = "older" ]; then
  abort "The configured update repository offers v${RELEASE_VERSION}, older than installed v${CURRENT_VERSION}. Install latest will not downgrade Panelavo."
fi
if [ "${VERSION_RELATION}" = "same" ]; then
  abort "The repository commit differs but still declares installed version v${CURRENT_VERSION}. Publish it with a higher version before updating."
fi

# Host migrations are root-owned and never run from a configurable update
# repository. Refuse the release before build/deploy unless its required
# broker protocol is already installed and healthy.
EXPECTED_BROKER_PROTOCOL="$(node -p "require('${SOURCE}/package.json').panelavo?.brokerProtocolVersion ?? ''")"
CURRENT_BROKER_PROTOCOL="$(node -p "require('${APP_ROOT}/package.json').panelavo?.brokerProtocolVersion ?? ''")"
[[ "${EXPECTED_BROKER_PROTOCOL}" =~ ^[0-9]+$ ]] || abort "The release does not declare a valid broker protocol version."
[ -x "${BROKER_PATH}" ] || abort "This update requires the root-owned Panelavo broker. Run 'sudo bash setup.sh' from a trusted checkout before updating."
if ! BROKER_HEALTH="$(printf '{\"protocolVersion\":%s,\"action\":\"broker-health\"}' "${EXPECTED_BROKER_PROTOCOL}" | /usr/bin/sudo -n "${BROKER_PATH}")"; then
  if [[ "${BROKER_HEALTH}" == *'"code":"BROKER_PROTOCOL_MISMATCH"'* ]]; then
    INSTALLED_BROKER_PROTOCOL="$(BROKER_HEALTH="${BROKER_HEALTH}" node -e 'try { const value = JSON.parse(process.env.BROKER_HEALTH || "{}").data?.protocolVersion; if (Number.isInteger(value)) process.stdout.write(String(value)); } catch {}')"
    if [ -z "${INSTALLED_BROKER_PROTOCOL}" ] && [[ "${CURRENT_BROKER_PROTOCOL}" =~ ^[0-9]+$ ]] && [ "${CURRENT_BROKER_PROTOCOL}" != "${EXPECTED_BROKER_PROTOCOL}" ]; then
      if CURRENT_BROKER_HEALTH="$(printf '{\"protocolVersion\":%s,\"action\":\"broker-health\"}' "${CURRENT_BROKER_PROTOCOL}" | /usr/bin/sudo -n "${BROKER_PATH}")"; then
        INSTALLED_BROKER_PROTOCOL="$(BROKER_HEALTH="${CURRENT_BROKER_HEALTH}" node -e 'try { const value = JSON.parse(process.env.BROKER_HEALTH || "{}").data?.protocolVersion; if (Number.isInteger(value)) process.stdout.write(String(value)); } catch {}')"
      fi
    fi
    if [ -n "${INSTALLED_BROKER_PROTOCOL}" ]; then
      abort "Release v${RELEASE_VERSION} requires broker protocol ${EXPECTED_BROKER_PROTOCOL}, but protocol ${INSTALLED_BROKER_PROTOCOL} is installed. Run trusted 'sudo bash setup.sh' for this release first."
    fi
    abort "Release v${RELEASE_VERSION} requires broker protocol ${EXPECTED_BROKER_PROTOCOL}, but the installed broker could not be verified. Run trusted 'sudo bash setup.sh' for this release first."
  fi
  abort "The installed Panelavo broker is unavailable. Run 'sudo bash setup.sh' from a trusted checkout."
fi
FAILURE_MESSAGE="Release v${RELEASE_VERSION} requires a healthy broker protocol ${EXPECTED_BROKER_PROTOCOL}. Run trusted 'sudo bash setup.sh' for this release first."
BROKER_HEALTH="${BROKER_HEALTH}" EXPECTED_BROKER_PROTOCOL="${EXPECTED_BROKER_PROTOCOL}" RELEASE_VERSION="${RELEASE_VERSION}" node <<'NODE'
const result = JSON.parse(process.env.BROKER_HEALTH || '{}');
const data = result.data || {};
if (!result.ok || data.protocolVersion !== Number(process.env.EXPECTED_BROKER_PROTOCOL) || data.privileged !== true || data.cloudPanelAvailable !== true) {
  console.error(`Release v${process.env.RELEASE_VERSION} requires a healthy broker protocol ${process.env.EXPECTED_BROKER_PROTOCOL}. Run trusted sudo bash setup.sh for this release first.`);
  process.exit(1);
}
NODE
FAILURE_MESSAGE=""

echo "[$(date -Is)] Installing and building ${COMMIT}"
(cd "${SOURCE}" && npx -y pnpm@10.12.1 install --frozen-lockfile && npx -y pnpm@10.12.1 build)
echo "[$(date -Is)] Deploying staged build"
/usr/bin/rsync -a --no-owner --no-group --delete --exclude .git --exclude .data --exclude .env.local "${SOURCE}/" "${APP_ROOT}/"
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
