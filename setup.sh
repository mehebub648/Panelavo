#!/usr/bin/env bash
#
# panelavo — standalone provisioning script.
#
# Turns a fresh Debian/Ubuntu server into a fully working panel host:
#   1. Detects the OS and installs CloudPanel if it is not present.
#   2. Creates the initial panelavo Super Admin in CloudPanel.
#   3. Installs the latest Node.js with nvm, publishes a complete shared copy
#      under /usr/local, and installs a shared PM2 that every user can run.
#   4. Creates a CloudPanel Node.js site owned by a dedicated system user,
#      deploys this application into it, builds it, and hosts it with PM2
#      (systemd resurrect on boot).
#
# Usage (from the repo root, as root):
#   sudo bash setup.sh
#
# Optional environment overrides:
#   PANEL_ADDRESS_MODE=sslip|custom address mode (inferred when omitted)
#   PANEL_BASE_DOMAIN=example.com    custom base domain; sslip mode uses sslip.io
#                                    (site-<id>.<ip>.<base>); reconfigurable
#                                    later from the panel
#   PANEL_UPDATE_REPOSITORY=https://git.example/panelavo.git
#                                    public updater source; otherwise an HTTPS
#                                    .git origin is used when available
#   PANEL_DOMAIN=panel.example.com   panel site domain
#                                    (default panel.<ip>.<base-domain>)
#   DB_MANAGER_DOMAIN=...            database manager (phpMyAdmin) site domain
#                                    (default database.<ip>.<base-domain>,
#                                    using the selected address mode)
#   PANEL_SITE_USER=panelavo         CloudPanel site/system user for panelavo
#   ADMIN_USER=admin                 Super Admin username
#   ADMIN_PASSWORD=...               Super Admin password (default random)
#   ADMIN_EMAIL=...                  Super Admin e-mail
#   DB_ENGINE=MYSQL_8.4              CloudPanel database engine override
#   KEEP_FAIL2BAN_SSHD_RUNNING=true Temporarily exempt this SSH client from
#                                   fail2ban (the jail stays active by default)
#   FAIL2BAN_SSHD_PREPAUSED=true    Jail was stopped in the provider console;
#                                   setup must restore it when finished
#   ENABLE_UFW=true                 Explicitly activate ufw after rules are
#                                   prepared (default: never activate remotely)
#   UFW_CONSOLE_RECOVERY_READY=true Required with ENABLE_UFW=true over SSH;
#                                   confirms provider-console recovery access
#   DATABASE_GATEWAY_CERTIFICATE_FILE=/root/wildcard-fullchain.pem
#   DATABASE_GATEWAY_PRIVATE_KEY_FILE=/root/wildcard-key.pem
#   DATABASE_GATEWAY_CA_FILE=/root/wildcard-ca.pem
#                                   optional public wildcard TLS identity;
#                                   otherwise setup creates a private Panelavo CA
#
# The panel listener is private on 127.0.0.1:10443. Public access is available
# only through the HTTPS CloudPanel/Nginx site once DNS points at the server.

set -euo pipefail

SITE_USER="${PANEL_SITE_USER:-panelavo}"
APP_PORT="10443"
NODEJS_SITE_VERSION="22"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_PREFIX="[panelavo-setup]"

log()  { echo -e "\033[1;32m${LOG_PREFIX}\033[0m $*"; }
warn() { echo -e "\033[1;33m${LOG_PREFIX}\033[0m $*" >&2; }
die()  { echo -e "\033[1;31m${LOG_PREFIX}\033[0m $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Run this script as root: sudo bash setup.sh"
[ -f "${SRC_DIR}/package.json" ] || die "Run setup.sh from the application directory (package.json not found)."
[[ "${SITE_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "PANEL_SITE_USER must be a valid Linux user name."

# Protect the connection running this installer. Mobile/carrier NAT addresses
# can change during a session, so allowlisting one source address is not a
# reliable maintenance strategy. By default, pause only fail2ban's sshd jail
# and restore it on every normal or error exit. The SSH service remains up.
# sudo may remove SSH_CONNECTION. Recover it from this process's ancestors,
# where the login shell/sshd child still has the original value.
detect_ssh_connection() {
  local value="${SSH_CONNECTION:-}" pid data
  if [ -n "${value}" ]; then printf '%s\n' "${value}"; return; fi
  pid="${PPID}"
  while [[ "${pid}" =~ ^[0-9]+$ ]] && [ "${pid}" -gt 1 ]; do
    data="$(tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -1 || true)"
    if [ -n "${data}" ]; then printf '%s\n' "${data}"; return; fi
    pid="$(awk '/^PPid:/ {print $2}' "/proc/${pid}/status" 2>/dev/null || true)"
  done
}

SSH_CONNECTION_VALUE="$(detect_ssh_connection)"
SSH_CLIENT_IP="${SSH_CONNECTION_VALUE%% *}"
SSH_SERVER_PORT="$(awk '{print $4}' <<<"${SSH_CONNECTION_VALUE}")"
[ -n "${SSH_SERVER_PORT}" ] || SSH_SERVER_PORT="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}' || true)"
[ "${ENABLE_UFW:-false}" != "true" ] \
  || [ -z "${SSH_CONNECTION_VALUE}" ] \
  || [ "${UFW_CONSOLE_RECOVERY_READY:-false}" = "true" ] \
  || die "Refusing to activate ufw over SSH without UFW_CONSOLE_RECOVERY_READY=true and tested provider-console recovery access."
FAIL2BAN_SSH_GUARD_ADDED=false
FAIL2BAN_SSH_JAIL_PAUSED=false

remove_ssh_guard() {
  if [ "${FAIL2BAN_SSH_JAIL_PAUSED}" = "true" ]; then
    if fail2ban-client start sshd >/dev/null 2>&1 || fail2ban-client reload --restart sshd >/dev/null 2>&1; then
      log "Restored fail2ban's sshd jail."
    else
      warn "Could not restart fail2ban's sshd jail; run: fail2ban-client reload --restart sshd"
    fi
    FAIL2BAN_SSH_JAIL_PAUSED=false
    [ -n "${SSH_CLIENT_IP}" ] && fail2ban-client set sshd unbanip "${SSH_CLIENT_IP}" >/dev/null 2>&1 || true
  elif [ "${FAIL2BAN_SSH_GUARD_ADDED}" = "true" ]; then
    fail2ban-client set sshd delignoreip "${SSH_CLIENT_IP}" >/dev/null 2>&1 || true
  fi
  if [ -n "${SETUP_CREDENTIALS_FILE:-}" ] && [ -f "${SETUP_CREDENTIALS_FILE}" ]; then
    warn "Setup did not finish; generated credentials remain in ${SETUP_CREDENTIALS_FILE} (root-only). Rerun setup to continue."
  fi
}
trap remove_ssh_guard EXIT INT TERM

if command -v fail2ban-client >/dev/null 2>&1 && fail2ban-client status sshd >/dev/null 2>&1; then
  if [ "${KEEP_FAIL2BAN_SSHD_RUNNING:-false}" = "true" ]; then
    [ -n "${SSH_CLIENT_IP}" ] || die "Could not detect the current SSH client IP for the requested fail2ban exemption."
    fail2ban-client set sshd unbanip "${SSH_CLIENT_IP}" >/dev/null 2>&1 || true
    if fail2ban-client get sshd ignoreip 2>/dev/null | tr ' ' '\n' | grep -Fqx "${SSH_CLIENT_IP}"; then
      log "Current SSH client ${SSH_CLIENT_IP} is already exempt from fail2ban."
    elif fail2ban-client set sshd addignoreip "${SSH_CLIENT_IP}" >/dev/null 2>&1; then
      FAIL2BAN_SSH_GUARD_ADDED=true
      log "Protected current SSH client ${SSH_CLIENT_IP} from fail2ban during setup."
    else
      die "Could not protect the current SSH client in fail2ban."
    fi
  else
    log "Leaving fail2ban's sshd jail active during setup."
  fi
elif [ "${FAIL2BAN_SSHD_PREPAUSED:-false}" = "true" ] && command -v fail2ban-client >/dev/null 2>&1; then
  FAIL2BAN_SSH_JAIL_PAUSED=true
  log "Using the fail2ban sshd maintenance window opened in the provider console; the jail will be restored automatically."
fi

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# 1. OS detection
# ---------------------------------------------------------------------------
[ -f /etc/os-release ] || die "Unsupported OS: /etc/os-release missing."
. /etc/os-release
OS_ID="${ID:-}"
OS_VERSION="${VERSION_ID:-}"

case "${OS_ID}-${OS_VERSION}" in
  ubuntu-22.04) DEFAULT_DB="MYSQL_8.0" ;;
  ubuntu-24.04) DEFAULT_DB="MYSQL_8.4" ;;
  ubuntu-26.04) DEFAULT_DB="MYSQL_8.4" ;;
  debian-11)    DEFAULT_DB="MARIADB_11.4" ;;
  debian-12)    DEFAULT_DB="MARIADB_12.3" ;;
  debian-13)    DEFAULT_DB="MARIADB_12.3" ;;
  *) die "Unsupported OS: ${PRETTY_NAME:-unknown}. CloudPanel supports Ubuntu 22.04/24.04/26.04 and Debian 11/12/13." ;;
esac
DB_ENGINE="${DB_ENGINE:-$DEFAULT_DB}"
log "Detected ${PRETTY_NAME} — CloudPanel DB engine: ${DB_ENGINE}"

# ---------------------------------------------------------------------------
# 2. Base packages
# ---------------------------------------------------------------------------
log "Installing base packages ..."
apt-get update -y
apt-get install -y curl wget sudo ca-certificates rsync openssl git acl uidmap dbus-user-session slirp4netns unattended-upgrades

# Security updates install through the OS-maintained mechanism. Reboots remain
# an operator decision so a package update cannot unexpectedly stop websites.
cat > /etc/apt/apt.conf.d/52panelavo-unattended-upgrades <<'APTCONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
APTCONF
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 2b. Rootless Docker host provisioning
#     Installs Docker Engine + rootless extras from Docker's official APT
#     repository so every CloudPanel site user can start their OWN private
#     rootless daemon with no further root action. Host package installs remain
#     a root boundary; pre-installing them here is what lets a site-write user
#     self-initialize their per-user runtime from the panel without a Super
#     Admin. Panelavo only ever uses each site user's rootless socket, never the
#     rootful daemon. uidmap/dbus-user-session/slirp4netns are installed above.
# ---------------------------------------------------------------------------
log "Provisioning rootless Docker runtime ..."
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
  DOCKER_CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
  [ -n "${DOCKER_CODENAME}" ] || die "Could not determine the APT distribution codename for Docker's repository."
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${OS_ID} ${DOCKER_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
fi
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras fuse-overlayfs
log "Rootless Docker runtime provisioned."

# ---------------------------------------------------------------------------
# 3. Public IP
# ---------------------------------------------------------------------------
SERVER_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
[ -n "${SERVER_IP}" ] || SERVER_IP="$(hostname -I | awk '{print $1}')"
[ -n "${SERVER_IP}" ] || die "Could not determine the server IP address."
log "Server IP: ${SERVER_IP}"

# Preserve an existing installation when rerunning without address overrides.
# Read only the two plain setting values; never source the application env.
if [ -z "${PANEL_BASE_DOMAIN:-}" ]; then
  for EXISTING_ENV in "/home/${SITE_USER}/htdocs/"*/.env.local; do
    [ -f "${EXISTING_ENV}" ] || continue
    EXISTING_BASE_DOMAIN="$(sed -n 's/^PANEL_BASE_DOMAIN=//p' "${EXISTING_ENV}" | head -1)"
    [ -n "${EXISTING_BASE_DOMAIN}" ] || continue
    PANEL_BASE_DOMAIN="${EXISTING_BASE_DOMAIN}"
    PANEL_ADDRESS_MODE="${PANEL_ADDRESS_MODE:-$(sed -n 's/^PANEL_ADDRESS_MODE=//p' "${EXISTING_ENV}" | head -1)}"
    PANEL_DOMAIN="${PANEL_DOMAIN:-$(basename "$(dirname "${EXISTING_ENV}")")}"
    break
  done
fi

# ---------------------------------------------------------------------------
# 3b. Interactive configuration (base domain + first Super Admin)
#     Values already provided through the environment are never asked again.
#
#     sslip.io is the default. Custom mode waits for one wildcard A record.
# ---------------------------------------------------------------------------
if [ -t 0 ]; then
  if [ -z "${PANEL_BASE_DOMAIN:-}" ]; then
    read -r -p "${LOG_PREFIX} Address mode: 1) sslip.io (recommended)  2) custom domain [1]: " PANEL_ADDRESS_MODE_INPUT
    case "${PANEL_ADDRESS_MODE_INPUT:-1}" in
      1|sslip) PANEL_ADDRESS_MODE=sslip; PANEL_BASE_DOMAIN=sslip.io ;;
      2|custom)
        PANEL_ADDRESS_MODE=custom
        while [ -z "${PANEL_BASE_DOMAIN:-}" ]; do
          read -r -p "${LOG_PREFIX} Custom base domain (example: example.com): " PANEL_BASE_DOMAIN_INPUT
          PANEL_BASE_DOMAIN="${PANEL_BASE_DOMAIN_INPUT:-}"
          [ -n "${PANEL_BASE_DOMAIN}" ] || warn "A base domain is required."
        done ;;
      *) die "Choose address mode 1 or 2." ;;
    esac
  fi
  if [ -z "${ADMIN_USER:-}" ]; then
    read -r -p "${LOG_PREFIX} Super Admin username [admin]: " ADMIN_USER_INPUT
    ADMIN_USER="${ADMIN_USER_INPUT:-admin}"
  fi
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    while true; do
      read -r -s -p "${LOG_PREFIX} Super Admin password (blank = generate): " ADMIN_PASSWORD_INPUT; echo
      if [ -z "${ADMIN_PASSWORD_INPUT}" ]; then break; fi
      if [ "${#ADMIN_PASSWORD_INPUT}" -lt 8 ]; then warn "Use at least 8 characters."; continue; fi
      read -r -s -p "${LOG_PREFIX} Confirm password: " ADMIN_PASSWORD_CONFIRM; echo
      [ "${ADMIN_PASSWORD_INPUT}" = "${ADMIN_PASSWORD_CONFIRM}" ] && { ADMIN_PASSWORD="${ADMIN_PASSWORD_INPUT}"; break; }
      warn "Passwords did not match — try again."
    done
  fi
fi
PANEL_BASE_DOMAIN="${PANEL_BASE_DOMAIN:-sslip.io}"
PANEL_ADDRESS_MODE="${PANEL_ADDRESS_MODE:-$([ "${PANEL_BASE_DOMAIN}" = "sslip.io" ] && echo sslip || echo custom)}"
case "${PANEL_ADDRESS_MODE}" in sslip|custom) ;; *) die "PANEL_ADDRESS_MODE must be sslip or custom." ;; esac
[ "${PANEL_ADDRESS_MODE}" != "sslip" ] || PANEL_BASE_DOMAIN=sslip.io

SOURCE_UPDATE_REPOSITORY="$(git -C "${SRC_DIR}" remote get-url origin 2>/dev/null || true)"
case "${SOURCE_UPDATE_REPOSITORY}" in
  https://*.git) ;;
  *) SOURCE_UPDATE_REPOSITORY="" ;;
esac
PANEL_UPDATE_REPOSITORY="${PANEL_UPDATE_REPOSITORY:-$SOURCE_UPDATE_REPOSITORY}"

# The panel and database manager follow the selected address mode and each
# receives its own trusted certificate,
# replacing links into CloudPanel's self-signed, firewalled port 8443).
PANEL_DOMAIN="${PANEL_DOMAIN:-panel.${SERVER_IP}.${PANEL_BASE_DOMAIN}}"
DB_MANAGER_DOMAIN="${DB_MANAGER_DOMAIN:-database.${SERVER_IP}.${PANEL_BASE_DOMAIN}}"
DATABASE_GATEWAY_SUFFIX="${DATABASE_GATEWAY_SUFFIX:-${SERVER_IP}.${PANEL_BASE_DOMAIN}}"

if [ -n "${PANEL_BASE_DOMAIN}" ]; then
  WILDCARD_RECORD="*.${SERVER_IP}.${PANEL_BASE_DOMAIN}"
  if [ "${PANEL_ADDRESS_MODE}" = "sslip" ]; then
    WILDCARD_PROBE="panel.${SERVER_IP}.sslip.io"
  else
    WILDCARD_PROBE="site-20001.${SERVER_IP}.${PANEL_BASE_DOMAIN}"
  fi
  
  wildcard_points_here() {
    local ips
    ips="$(getent ahostsv4 "${WILDCARD_PROBE}" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
    case " ${ips} " in *" ${SERVER_IP} "*) return 0 ;; *) return 1 ;; esac
  }

  log "Checking if ${WILDCARD_PROBE} points to this server (${SERVER_IP}) ..."
  if [ "${PANEL_ADDRESS_MODE}" = "custom" ]; then
    while ! wildcard_points_here; do
      warn "Waiting for A ${WILDCARD_RECORD} -> ${SERVER_IP} to resolve ..."
      sleep 10
    done
  else
    for _ in 1 2 3 4 5; do
      if wildcard_points_here; then break; fi
      sleep 2
    done
  fi

  if wildcard_points_here; then
    log "Address DNS looks ready: ${WILDCARD_PROBE} -> ${SERVER_IP}"
  else
    warn "Address DNS is not pointing here yet."
    die "The sslip.io hostname ${WILDCARD_PROBE} did not resolve to ${SERVER_IP}. Check outbound DNS and try again."
  fi
fi
SETUP_CREDENTIALS_FILE="/root/.panelavo-setup-credentials"
PENDING_ADMIN_USER=""
PENDING_ADMIN_PASSWORD=""
PENDING_SITE_USER=""
PENDING_SITE_USER_PASSWORD=""
if [ -e "${SETUP_CREDENTIALS_FILE}" ]; then
  [ "$(stat -c '%u:%a' "${SETUP_CREDENTIALS_FILE}")" = "0:600" ] || die "Refusing unsafe setup credential handoff: ${SETUP_CREDENTIALS_FILE} must be root-owned with mode 600."
  PENDING_ADMIN_USER="$(sed -n 's/^ADMIN_USER_B64=//p' "${SETUP_CREDENTIALS_FILE}" | head -1 | base64 -d)"
  PENDING_ADMIN_PASSWORD="$(sed -n 's/^ADMIN_PASSWORD_B64=//p' "${SETUP_CREDENTIALS_FILE}" | head -1 | base64 -d)"
  PENDING_SITE_USER="$(sed -n 's/^SITE_USER_B64=//p' "${SETUP_CREDENTIALS_FILE}" | head -1 | base64 -d)"
  PENDING_SITE_USER_PASSWORD="$(sed -n 's/^SITE_USER_PASSWORD_B64=//p' "${SETUP_CREDENTIALS_FILE}" | head -1 | base64 -d)"
fi

ADMIN_PASSWORD_EXPLICIT=false
[ -n "${ADMIN_PASSWORD:-}" ] && ADMIN_PASSWORD_EXPLICIT=true
ADMIN_USER="${ADMIN_USER:-${PENDING_ADMIN_USER:-admin}}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@${PANEL_DOMAIN}}"
if [ -z "${ADMIN_PASSWORD:-}" ] && [ "${PENDING_ADMIN_USER}" = "${ADMIN_USER}" ]; then
  ADMIN_PASSWORD="${PENDING_ADMIN_PASSWORD}"
fi
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)!Aa1}"
log "panelavo domain: ${PANEL_DOMAIN} — Super Admin: ${ADMIN_USER}"

write_setup_credentials() {
  local temporary="${SETUP_CREDENTIALS_FILE}.tmp"
  (
    umask 077
    {
      if [ "${ADMIN_PASSWORD}" != "(unchanged)" ]; then
        printf 'ADMIN_USER_B64=%s\n' "$(printf '%s' "${ADMIN_USER}" | base64 -w0)"
        printf 'ADMIN_PASSWORD_B64=%s\n' "$(printf '%s' "${ADMIN_PASSWORD}" | base64 -w0)"
      fi
      if [ -n "${SITE_USER_PASSWORD:-}" ] && [ "${SITE_USER_PASSWORD}" != "(unchanged)" ]; then
        printf 'SITE_USER_B64=%s\n' "$(printf '%s' "${SITE_USER}" | base64 -w0)"
        printf 'SITE_USER_PASSWORD_B64=%s\n' "$(printf '%s' "${SITE_USER_PASSWORD}" | base64 -w0)"
      fi
    } > "${temporary}"
  )
  chmod 600 "${temporary}"
  mv -f "${temporary}" "${SETUP_CREDENTIALS_FILE}"
}

# ---------------------------------------------------------------------------
# 4. CloudPanel
# ---------------------------------------------------------------------------
if command -v clpctl >/dev/null 2>&1; then
  log "CloudPanel is already installed ($(clpctl --version 2>/dev/null | head -1 || echo 'version unknown')) — skipping installation."
else
  log "Installing CloudPanel (this takes several minutes) ..."
  apt-get -y upgrade
  curl -sS https://installer.cloudpanel.io/ce/v2/install.sh -o /tmp/cloudpanel-install.sh
  DB_ENGINE="${DB_ENGINE}" bash /tmp/cloudpanel-install.sh
  rm -f /tmp/cloudpanel-install.sh
  command -v clpctl >/dev/null 2>&1 || die "CloudPanel installation failed (clpctl not found)."
  log "CloudPanel installed."
fi

# ---------------------------------------------------------------------------
# 5. Initial Super Admin (backed by CloudPanel's admin role)
# ---------------------------------------------------------------------------
CLOUDPANEL_USERS="$(clpctl user:list 2>/dev/null)" || die "Could not list existing CloudPanel users."
EXISTING_USERNAME_ROLE="$(printf '%s\n' "${CLOUDPANEL_USERS}" | awk -F'|' -v wanted="${ADMIN_USER}" '
  function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
  /^\|/ { username=trim($2); role=tolower(trim($6)); if (username == wanted) { print role; exit } }
')"
EXISTING_USERNAME_STATUS="$(printf '%s\n' "${CLOUDPANEL_USERS}" | awk -F'|' -v wanted="${ADMIN_USER}" '
  function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
  /^\|/ { username=trim($2); status=tolower(trim($7)); if (username == wanted) { print status; exit } }
')"
EXISTING_EMAIL_USER="$(printf '%s\n' "${CLOUDPANEL_USERS}" | awk -F'|' -v wanted="${ADMIN_EMAIL}" '
  function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
  /^\|/ { username=trim($2); email=trim($5); if (email == wanted) { print username; exit } }
')"
EXISTING_EMAIL_ROLE="$(printf '%s\n' "${CLOUDPANEL_USERS}" | awk -F'|' -v wanted="${ADMIN_EMAIL}" '
  function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
  /^\|/ { email=trim($5); role=tolower(trim($6)); if (email == wanted) { print role; exit } }
')"
EXISTING_EMAIL_STATUS="$(printf '%s\n' "${CLOUDPANEL_USERS}" | awk -F'|' -v wanted="${ADMIN_EMAIL}" '
  function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
  /^\|/ { email=trim($5); status=tolower(trim($7)); if (email == wanted) { print status; exit } }
')"

if [ -n "${EXISTING_USERNAME_ROLE}" ]; then
  [ "${EXISTING_USERNAME_ROLE}" = "admin" ] || die "CloudPanel user '${ADMIN_USER}' already exists without the Admin role. Choose a different ADMIN_USER."
  [ "${EXISTING_USERNAME_STATUS}" = "active" ] || die "CloudPanel Admin '${ADMIN_USER}' is not active. Activate it or choose a different ADMIN_USER."
  if [ "${ADMIN_PASSWORD_EXPLICIT}" = "true" ]; then
    log "Resetting the existing Super Admin '${ADMIN_USER}' password requested through ADMIN_PASSWORD ..."
    clpctl user:reset:password --userName="${ADMIN_USER}" --password="${ADMIN_PASSWORD}"
  elif [ "${PENDING_ADMIN_USER}" = "${ADMIN_USER}" ] && [ -n "${PENDING_ADMIN_PASSWORD}" ]; then
    log "Super Admin '${ADMIN_USER}' already exists — reusing the pending setup credential."
  else
    log "Super Admin '${ADMIN_USER}' already exists — leaving the account untouched."
    ADMIN_PASSWORD="(unchanged)"
  fi
elif [ -n "${EXISTING_EMAIL_USER}" ]; then
  [ "${EXISTING_EMAIL_ROLE}" = "admin" ] || die "CloudPanel email '${ADMIN_EMAIL}' already belongs to a non-Admin user. Choose a different ADMIN_EMAIL."
  [ "${EXISTING_EMAIL_STATUS}" = "active" ] || die "CloudPanel Admin '${EXISTING_EMAIL_USER}' is not active. Activate it or choose a different ADMIN_EMAIL."
  log "Super Admin email '${ADMIN_EMAIL}' already belongs to '${EXISTING_EMAIL_USER}' — reusing that account."
  ADMIN_USER="${EXISTING_EMAIL_USER}"
  ADMIN_PASSWORD="(unchanged)"
else
  log "Creating Super Admin '${ADMIN_USER}' in CloudPanel ..."
  write_setup_credentials
  clpctl user:add \
    --userName="${ADMIN_USER}" \
    --email="${ADMIN_EMAIL}" \
    --firstName="Server" \
    --lastName="Admin" \
    --password="${ADMIN_PASSWORD}" \
    --role=admin \
    --timezone=UTC \
    --status=1
fi

# ---------------------------------------------------------------------------
# 6. Latest Node.js via nvm + shared Node/PM2 in /usr/local
# ---------------------------------------------------------------------------
export NVM_DIR="/root/.nvm"
if [ ! -s "${NVM_DIR}/nvm.sh" ]; then
  log "Installing nvm for root ..."
  NVM_VERSION="$(curl -fsS --max-time 10 https://api.github.com/repos/nvm-sh/nvm/releases/latest 2>/dev/null | grep -oP '"tag_name":\s*"\K[^"]+' || true)"
  NVM_VERSION="${NVM_VERSION:-v0.40.3}"
  curl -fsS "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
fi
# shellcheck disable=SC1091
. "${NVM_DIR}/nvm.sh"

log "Installing latest Node.js via nvm ..."
nvm install node >/dev/null
nvm alias default node >/dev/null
NODE_BIN="$(dirname "$(nvm which default)")"
log "Node.js $("${NODE_BIN}/node" -v) installed for root."

# A symlink into /root/.nvm is unusable by site users because /root is not
# traversable. Publish the complete distribution (bin + lib) in /usr/local so
# npm/npx relative links and their JavaScript entrypoints remain available.
NODE_ROOT="$(dirname "${NODE_BIN}")"
SHARED_NODE_ROOT="/usr/local/lib/panelavo-node"
log "Publishing shared Node.js runtime in ${SHARED_NODE_ROOT} ..."
mkdir -p "${SHARED_NODE_ROOT}"
rsync -a --delete "${NODE_ROOT}/" "${SHARED_NODE_ROOT}/"
chmod -R a+rX "${SHARED_NODE_ROOT}"

# Expose the Node commands required by setup to every user (PM2, builds, and
# systemd). Corepack is optional because recent Node.js releases may omit it;
# setup invokes the pinned pnpm version through npx instead.
for bin in node npm npx; do
  [ -e "${SHARED_NODE_ROOT}/bin/${bin}" ] || die "Shared Node.js command is missing: ${bin}"
  ln -sf "${SHARED_NODE_ROOT}/bin/${bin}" "/usr/local/bin/${bin}"
done
if [ -e "${SHARED_NODE_ROOT}/bin/corepack" ]; then
  ln -sf "${SHARED_NODE_ROOT}/bin/corepack" /usr/local/bin/corepack
else
  rm -f /usr/local/bin/corepack
fi

sudo -u nobody env PATH="/usr/local/bin:/usr/bin:/bin" node --version >/dev/null 2>&1 || die "Shared Node.js runtime is not executable by non-root users."
sudo -u nobody env PATH="/usr/local/bin:/usr/bin:/bin" npx --version >/dev/null 2>&1 || die "Shared npx is not executable by non-root users."

PM2_ROOT="/usr/local/lib/node_modules/pm2"
if ! sudo -u nobody test -x /usr/local/bin/pm2; then
  log "Installing shared PM2 into /usr/local ..."
  (umask 022; "${SHARED_NODE_ROOT}/bin/npm" install -g --prefix /usr/local pm2 >/dev/null)
fi
[ -d "${PM2_ROOT}" ] || die "Shared PM2 installation is missing: ${PM2_ROOT}"
chmod a+rx /usr/local/lib/node_modules
chmod -R a+rX "${PM2_ROOT}"
sudo -u nobody test -x /usr/local/bin/pm2 || die "Shared PM2 is not executable by non-root users."
PM2_VERSION="$("${SHARED_NODE_ROOT}/bin/node" -p "require('${PM2_ROOT}/package.json').version")"
[ -n "${PM2_VERSION}" ] || die "Shared PM2 version could not be read."
log "PM2 ${PM2_VERSION} available system-wide."

# ---------------------------------------------------------------------------
# 7. CloudPanel site owned by the panelavo system user
# ---------------------------------------------------------------------------
SITE_ROOT="/home/${SITE_USER}/htdocs/${PANEL_DOMAIN}"
if [ "${PENDING_SITE_USER}" = "${SITE_USER}" ] && [ -n "${PENDING_SITE_USER_PASSWORD}" ]; then
  SITE_USER_PASSWORD="${PENDING_SITE_USER_PASSWORD}"
else
  SITE_USER_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)!Aa1"
fi
if [ -d "${SITE_ROOT}" ]; then
  log "Site ${PANEL_DOMAIN} already exists — skipping site creation."
  if [ "${PENDING_SITE_USER}" != "${SITE_USER}" ] || [ -z "${PENDING_SITE_USER_PASSWORD}" ]; then
    SITE_USER_PASSWORD="(unchanged)"
  fi
else
  log "Creating Node.js site ${PANEL_DOMAIN} (site user: ${SITE_USER}) ..."
  write_setup_credentials
  clpctl site:add:nodejs \
    --domainName="${PANEL_DOMAIN}" \
    --nodejsVersion="${NODEJS_SITE_VERSION}" \
    --appPort="${APP_PORT}" \
    --siteUser="${SITE_USER}" \
    --siteUserPassword="${SITE_USER_PASSWORD}"
fi
id "${SITE_USER}" >/dev/null 2>&1 || die "System user ${SITE_USER} was not created by CloudPanel."

# ---------------------------------------------------------------------------
# 7b. Database manager: a standalone phpMyAdmin in its own CloudPanel PHP
#     site on database.<ip>.<base>. The selected address mode resolves the
#     domain, so it gets a real Let's Encrypt certificate in step 12 and the
#     panel's database links never touch CloudPanel's self-signed, firewalled
#     port 8443. Users sign in with their own database credentials, so MySQL
#     itself enforces per-site scope. Failures only warn: the panel works
#     without the manager, its database links are simply hidden.
# ---------------------------------------------------------------------------
DB_MANAGER_PROVISIONED=false
DB_MANAGER_USER="${DB_MANAGER_USER:-${SITE_USER:0:28}-db}"
DB_MANAGER_ROOT="/home/${DB_MANAGER_USER}/htdocs/${DB_MANAGER_DOMAIN}"
# Prefer the newest PHP no later than 8.4: phpMyAdmin's support for the
# newest PHP series lags, and a too-new runtime only produces deprecation
# noise. Fall back to the newest installed version if nothing older exists.
PHP_SITE_VERSION="$(find /etc/php -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | grep -E '^[0-9]+\.[0-9]+$' | sort -V | awk -v max=8.4 'BEGIN{split(max,m,".")} {split($0,v,"."); if (v[1]<m[1] || (v[1]==m[1] && v[2]<=m[2])) last=$0} END{print last}' || true)"
[ -n "${PHP_SITE_VERSION}" ] || PHP_SITE_VERSION="$(find /etc/php -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | grep -E '^[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)"
if [ -z "${PHP_SITE_VERSION}" ]; then
  warn "No CloudPanel PHP runtime found under /etc/php — skipping the phpMyAdmin database manager."
else
  if [ -d "${DB_MANAGER_ROOT}" ]; then
    log "Database manager site ${DB_MANAGER_DOMAIN} already exists — skipping site creation."
  else
    log "Creating PHP site ${DB_MANAGER_DOMAIN} for the database manager (PHP ${PHP_SITE_VERSION}) ..."
    clpctl site:add:php \
      --domainName="${DB_MANAGER_DOMAIN}" \
      --phpVersion="${PHP_SITE_VERSION}" \
      --vhostTemplate='Generic' \
      --siteUser="${DB_MANAGER_USER}" \
      --siteUserPassword="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)!Aa1" \
      || warn "Could not create ${DB_MANAGER_DOMAIN}; the panel's database Manage links will stay hidden."
  fi
  if [ -d "${DB_MANAGER_ROOT}" ] && [ ! -f "${DB_MANAGER_ROOT}/config.inc.php" ]; then
    log "Installing phpMyAdmin into ${DB_MANAGER_ROOT} ..."
    PMA_TMP="$(mktemp -d)"
    if curl -fsSL --max-time 300 https://www.phpmyadmin.net/downloads/phpMyAdmin-latest-all-languages.tar.gz -o "${PMA_TMP}/pma.tar.gz" \
      && tar -xzf "${PMA_TMP}/pma.tar.gz" -C "${PMA_TMP}"; then
      PMA_DIR="$(find "${PMA_TMP}" -mindepth 1 -maxdepth 1 -type d -name 'phpMyAdmin-*' | head -1)"
      if [ -n "${PMA_DIR}" ]; then
        rm -rf "${DB_MANAGER_ROOT:?}"/* 2>/dev/null || true
        rsync -a "${PMA_DIR}/" "${DB_MANAGER_ROOT}/"
        mkdir -p "${DB_MANAGER_ROOT}/tmp"
        PMA_SECRET="$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 32)"
        # Cookie auth against local MySQL only; no root logins, no arbitrary
        # servers. Database users created from the panel sign in directly.
        cat > "${DB_MANAGER_ROOT}/config.inc.php" <<PMACONF
<?php
declare(strict_types=1);
\$cfg['blowfish_secret'] = '${PMA_SECRET}';
\$i = 1;
\$cfg['Servers'][\$i]['auth_type'] = 'cookie';
\$cfg['Servers'][\$i]['host'] = '127.0.0.1';
\$cfg['Servers'][\$i]['AllowNoPassword'] = false;
\$cfg['Servers'][\$i]['AllowRoot'] = false;
\$cfg['AllowArbitraryServer'] = false;
\$cfg['TempDir'] = __DIR__ . '/tmp';
\$cfg['VersionCheck'] = false;
PMACONF
        chown -R "${DB_MANAGER_USER}:${DB_MANAGER_USER}" "${DB_MANAGER_ROOT}"
        chmod 600 "${DB_MANAGER_ROOT}/config.inc.php"
        log "phpMyAdmin installed for ${DB_MANAGER_DOMAIN}."
      else
        warn "The phpMyAdmin archive had an unexpected layout; skipping the database manager."
      fi
    else
      warn "Could not download phpMyAdmin; the panel's database Manage links will stay hidden."
    fi
    rm -rf "${PMA_TMP}"
  fi
  # Panelavo -> phpMyAdmin single sign-on (idempotent, also upgrades existing
  # installs): the root broker drops one-time credential tokens into the
  # manager site user's private ~/.pma-signon directory; signon.php consumes
  # them and phpMyAdmin server 2 authenticates from that signon session.
  if [ -f "${DB_MANAGER_ROOT}/config.inc.php" ]; then
    install -o "${DB_MANAGER_USER}" -g "${DB_MANAGER_USER}" -m 0644 \
      "${SRC_DIR}/scripts/pma-signon.php" "${DB_MANAGER_ROOT}/signon.php"
    install -d -o "${DB_MANAGER_USER}" -g "${DB_MANAGER_USER}" -m 0700 \
      "/home/${DB_MANAGER_USER}/.pma-signon"
    if ! grep -q "PanelavoSignon" "${DB_MANAGER_ROOT}/config.inc.php"; then
      cat >> "${DB_MANAGER_ROOT}/config.inc.php" <<'PMASIGNON'
$i++;
$cfg['Servers'][$i]['auth_type'] = 'signon';
$cfg['Servers'][$i]['host'] = '127.0.0.1';
$cfg['Servers'][$i]['SignonSession'] = 'PanelavoSignon';
$cfg['Servers'][$i]['SignonURL'] = 'signon.php';
$cfg['Servers'][$i]['AllowNoPassword'] = false;
$cfg['Servers'][$i]['AllowRoot'] = false;
PMASIGNON
    fi
    # Large SQL imports: PHP-FPM reads .user.ini from the docroot, so stock
    # 2M/8M upload limits and the 300s phpMyAdmin execution cap would reject
    # or abort dumps that the panel's users legitimately upload.
    install -o "${DB_MANAGER_USER}" -g "${DB_MANAGER_USER}" -m 0644 /dev/null "${DB_MANAGER_ROOT}/.user.ini"
    cat > "${DB_MANAGER_ROOT}/.user.ini" <<'PMAINI'
upload_max_filesize = 512M
post_max_size = 512M
memory_limit = 512M
max_execution_time = 3600
max_input_time = 3600
PMAINI
    if ! grep -q "ExecTimeLimit" "${DB_MANAGER_ROOT}/config.inc.php"; then
      printf '%s\n' "\$cfg['ExecTimeLimit'] = 3600;" >> "${DB_MANAGER_ROOT}/config.inc.php"
    fi
  fi
  [ -f "${DB_MANAGER_ROOT}/config.inc.php" ] && DB_MANAGER_PROVISIONED=true
fi

# ---------------------------------------------------------------------------
# 7b. Private database service + bounded TLS database gateway
# ---------------------------------------------------------------------------
log "Provisioning the private database boundary ..."

MYSQL_SERVICE=""
if [ "$(systemctl show -p LoadState --value mysql.service 2>/dev/null || true)" = "loaded" ]; then MYSQL_SERVICE=mysql
elif [ "$(systemctl show -p LoadState --value mariadb.service 2>/dev/null || true)" = "loaded" ]; then MYSQL_SERVICE=mariadb
fi
[ -n "${MYSQL_SERVICE}" ] || die "A local MySQL-compatible system service is required for the database gateway."

# CloudPanel owns the database administrator credential. Read it without
# printing it and use TCP loopback explicitly; stock CloudPanel installations
# do not guarantee passwordless root socket authentication.
CLOUDPANEL_DB_CREDENTIALS="$(clpctl db:show:master-credentials 2>/dev/null)" \
  || die "Could not read CloudPanel's database administrator credential."
MYSQL_ADMIN_USER="$(printf '%s\n' "${CLOUDPANEL_DB_CREDENTIALS}" | awk -F'|' '$2 ~ /User Name/ { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3); print $3; exit }')"
MYSQL_ADMIN_PASSWORD="$(printf '%s\n' "${CLOUDPANEL_DB_CREDENTIALS}" | awk -F'|' '$2 ~ /Password/ { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3); print $3; exit }')"
[ -n "${MYSQL_ADMIN_USER}" ] && [ -n "${MYSQL_ADMIN_PASSWORD}" ] \
  || die "CloudPanel returned an incomplete database administrator credential."
mysql_admin() {
  MYSQL_PWD="${MYSQL_ADMIN_PASSWORD}" mysql --protocol=tcp -h 127.0.0.1 -u "${MYSQL_ADMIN_USER}" "$@"
}

# Do not break an existing remote database client. Connections over the Unix
# socket and loopback are safe; any other active client must be migrated first.
REMOTE_DATABASE_CLIENTS="$(mysql_admin -NBe "SELECT DISTINCT SUBSTRING_INDEX(PROCESSLIST_HOST, ':', 1) FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND PROCESSLIST_USER IS NOT NULL AND PROCESSLIST_USER <> 'event_scheduler' AND PROCESSLIST_HOST IS NOT NULL AND PROCESSLIST_HOST <> ''" 2>/dev/null | grep -Ev '^(localhost|127[.]|::1$)' || true)"
[ -z "${REMOTE_DATABASE_CLIENTS}" ] || die "Active non-loopback database clients were detected (${REMOTE_DATABASE_CLIENTS//$'\n'/, }). Migrate or stop them before setup makes the main database private."

install -d -o root -g root -m 0755 /etc/mysql/conf.d
MYSQL_PRIVATE_CONFIG="/etc/mysql/conf.d/zz-panelavo-private.cnf"
MYSQL_PRIVATE_BACKUP=""
[ ! -f "${MYSQL_PRIVATE_CONFIG}" ] || { MYSQL_PRIVATE_BACKUP="$(mktemp)"; cp "${MYSQL_PRIVATE_CONFIG}" "${MYSQL_PRIVATE_BACKUP}"; }
MYSQL_FLAVOR="$(mysql_admin -NBe 'SELECT @@version_comment, @@version' 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
{
  echo '[mysqld]'
  echo 'bind-address=127.0.0.1'
  case "${MYSQL_FLAVOR}" in *mariadb*) ;; *) echo 'mysqlx-bind-address=127.0.0.1' ;; esac
} > "${MYSQL_PRIVATE_CONFIG}"
chmod 0644 "${MYSQL_PRIVATE_CONFIG}"
if command -v mysqld >/dev/null 2>&1 && mysqld --help --verbose 2>&1 | grep -q -- '--validate-config'; then
  if ! mysqld --validate-config >/dev/null 2>&1; then
    [ -z "${MYSQL_PRIVATE_BACKUP}" ] && rm -f "${MYSQL_PRIVATE_CONFIG}" || cp "${MYSQL_PRIVATE_BACKUP}" "${MYSQL_PRIVATE_CONFIG}"
    rm -f "${MYSQL_PRIVATE_BACKUP}"
    die "The database server rejected Panelavo's private-listener configuration."
  fi
fi
if ! systemctl restart "${MYSQL_SERVICE}" \
  || ! MYSQL_PWD="${MYSQL_ADMIN_PASSWORD}" mysqladmin --protocol=tcp -h 127.0.0.1 -u "${MYSQL_ADMIN_USER}" ping >/dev/null 2>&1; then
  [ -z "${MYSQL_PRIVATE_BACKUP}" ] && rm -f "${MYSQL_PRIVATE_CONFIG}" || cp "${MYSQL_PRIVATE_BACKUP}" "${MYSQL_PRIVATE_CONFIG}"
  systemctl restart "${MYSQL_SERVICE}" >/dev/null 2>&1 || true
  rm -f "${MYSQL_PRIVATE_BACKUP}"
  die "The database service did not recover after private-listener configuration; the previous configuration was restored."
fi
rm -f "${MYSQL_PRIVATE_BACKUP}"
if ss -lnt | awk '$4 ~ /:(3306|33060)$/ && $4 !~ /^(127[.]0[.]0[.]1|\[::1\]):/ { found=1 } END { exit found ? 0 : 1 }'; then
  die "The database service is still listening publicly on port 3306 or 33060."
fi
log "The main database listener is private on loopback."

# Install the maintained ProxySQL 3.0 series from its signed vendor repository.
if ! command -v proxysql >/dev/null 2>&1; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL 'https://repo.proxysql.com/ProxySQL/proxysql-3.0.x/repo_pub_key.gpg' -o /usr/share/keyrings/proxysql-3.0.x-keyring.gpg
  chmod 0644 /usr/share/keyrings/proxysql-3.0.x-keyring.gpg
  PROXYSQL_CODENAME="${VERSION_CODENAME:-$(lsb_release -sc 2>/dev/null || true)}"
  [ -n "${PROXYSQL_CODENAME}" ] || die "Could not determine the ProxySQL repository codename."
  echo "deb [signed-by=/usr/share/keyrings/proxysql-3.0.x-keyring.gpg] https://repo.proxysql.com/ProxySQL/proxysql-3.0.x/${PROXYSQL_CODENAME}/ ./" > /etc/apt/sources.list.d/proxysql-panelavo.list
  apt-get update -y
  apt-get install -y proxysql
fi
systemctl disable --now proxysql.service >/dev/null 2>&1 || true
id proxysql >/dev/null 2>&1 || die "The ProxySQL package did not create its service account."

DATABASE_GATEWAY_ROOT="/var/lib/panelavo/database-gateway"
DATABASE_GATEWAY_DATA="${DATABASE_GATEWAY_ROOT}/proxysql"
DATABASE_GATEWAY_CONFIG="/etc/panelavo-database-gateway.cnf"
DATABASE_GATEWAY_ADMIN="${DATABASE_GATEWAY_ROOT}/admin-credentials"
DATABASE_GATEWAY_MONITOR="${DATABASE_GATEWAY_ROOT}/monitor-credentials"
# The gateway daemon needs to traverse its root-owned parent while the other
# Panelavo state directories remain non-listable and keep their own modes.
install -d -o root -g root -m 0711 /var/lib/panelavo
install -d -o root -g proxysql -m 0750 "${DATABASE_GATEWAY_ROOT}"
install -d -o proxysql -g proxysql -m 0700 "${DATABASE_GATEWAY_DATA}"
if [ ! -f "${DATABASE_GATEWAY_ADMIN}" ]; then
  DATABASE_GATEWAY_ADMIN_USER="panelavo$(openssl rand -hex 5)"
  DATABASE_GATEWAY_ADMIN_PASSWORD="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 48)"
  printf '%s:%s\n' "${DATABASE_GATEWAY_ADMIN_USER}" "${DATABASE_GATEWAY_ADMIN_PASSWORD}" > "${DATABASE_GATEWAY_ADMIN}"
  chmod 0600 "${DATABASE_GATEWAY_ADMIN}"
else
  IFS=: read -r DATABASE_GATEWAY_ADMIN_USER DATABASE_GATEWAY_ADMIN_PASSWORD < "${DATABASE_GATEWAY_ADMIN}"
fi
[[ "${DATABASE_GATEWAY_ADMIN_USER}" =~ ^[A-Za-z0-9_-]{8,64}$ ]] || die "The database gateway administrator name is invalid."
[ "${#DATABASE_GATEWAY_ADMIN_PASSWORD}" -ge 24 ] || die "The database gateway administrator password is invalid."

if [ ! -f "${DATABASE_GATEWAY_MONITOR}" ]; then
  DATABASE_GATEWAY_MONITOR_USER="panelavo_proxy_monitor"
  DATABASE_GATEWAY_MONITOR_PASSWORD="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 48)"
  printf '%s:%s\n' "${DATABASE_GATEWAY_MONITOR_USER}" "${DATABASE_GATEWAY_MONITOR_PASSWORD}" > "${DATABASE_GATEWAY_MONITOR}"
  chmod 0600 "${DATABASE_GATEWAY_MONITOR}"
else
  IFS=: read -r DATABASE_GATEWAY_MONITOR_USER DATABASE_GATEWAY_MONITOR_PASSWORD < "${DATABASE_GATEWAY_MONITOR}"
fi
[[ "${DATABASE_GATEWAY_MONITOR_USER}" =~ ^[A-Za-z0-9_-]{8,64}$ ]] || die "The database gateway monitor name is invalid."
[ "${#DATABASE_GATEWAY_MONITOR_PASSWORD}" -ge 24 ] || die "The database gateway monitor password is invalid."
MYSQL_HAVE_SSL="$(mysql_admin -NBe "SHOW GLOBAL VARIABLES LIKE 'have_ssl'" 2>/dev/null | awk '{ print toupper($2) }')"
[ "${MYSQL_HAVE_SSL}" = "YES" ] || die "The database server must support TLS before Panelavo can provision the gateway monitor."
mysql_admin <<MYSQLMONITOR >/dev/null
CREATE USER IF NOT EXISTS '${DATABASE_GATEWAY_MONITOR_USER}'@'127.0.0.1' IDENTIFIED BY '${DATABASE_GATEWAY_MONITOR_PASSWORD}';
ALTER USER '${DATABASE_GATEWAY_MONITOR_USER}'@'127.0.0.1' IDENTIFIED BY '${DATABASE_GATEWAY_MONITOR_PASSWORD}' REQUIRE SSL;
GRANT USAGE ON *.* TO '${DATABASE_GATEWAY_MONITOR_USER}'@'127.0.0.1';
CREATE USER IF NOT EXISTS '${DATABASE_GATEWAY_MONITOR_USER}'@'localhost' IDENTIFIED BY '${DATABASE_GATEWAY_MONITOR_PASSWORD}';
ALTER USER '${DATABASE_GATEWAY_MONITOR_USER}'@'localhost' IDENTIFIED BY '${DATABASE_GATEWAY_MONITOR_PASSWORD}' REQUIRE SSL;
GRANT USAGE ON *.* TO '${DATABASE_GATEWAY_MONITOR_USER}'@'localhost';
MYSQLMONITOR

DATABASE_GATEWAY_CERT="${DATABASE_GATEWAY_DATA}/proxysql-cert.pem"
DATABASE_GATEWAY_KEY="${DATABASE_GATEWAY_DATA}/proxysql-key.pem"
DATABASE_GATEWAY_CA="${DATABASE_GATEWAY_DATA}/proxysql-ca.pem"
DATABASE_GATEWAY_TLS_TRUST="panelavo-ca"
if [ -n "${DATABASE_GATEWAY_CERTIFICATE_FILE:-}" ] || [ -n "${DATABASE_GATEWAY_PRIVATE_KEY_FILE:-}" ]; then
  [ -f "${DATABASE_GATEWAY_CERTIFICATE_FILE:-}" ] && [ -f "${DATABASE_GATEWAY_PRIVATE_KEY_FILE:-}" ] || die "Both database gateway certificate and private-key files are required."
  openssl x509 -in "${DATABASE_GATEWAY_CERTIFICATE_FILE}" -noout -checkhost "db-probe.${DATABASE_GATEWAY_SUFFIX}" >/dev/null 2>&1 || die "The supplied database certificate does not cover *.${DATABASE_GATEWAY_SUFFIX}."
  openssl x509 -in "${DATABASE_GATEWAY_CERTIFICATE_FILE}" -noout -checkend 2592000 >/dev/null 2>&1 || die "The supplied database wildcard certificate expires within 30 days."
  CERT_PUBLIC="$(openssl x509 -in "${DATABASE_GATEWAY_CERTIFICATE_FILE}" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
  KEY_PUBLIC="$(openssl pkey -in "${DATABASE_GATEWAY_PRIVATE_KEY_FILE}" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
  [ -n "${CERT_PUBLIC}" ] && [ "${CERT_PUBLIC}" = "${KEY_PUBLIC}" ] || die "The supplied database wildcard certificate and private key do not match."
  install -o proxysql -g proxysql -m 0644 "${DATABASE_GATEWAY_CERTIFICATE_FILE}" "${DATABASE_GATEWAY_CERT}"
  install -o proxysql -g proxysql -m 0600 "${DATABASE_GATEWAY_PRIVATE_KEY_FILE}" "${DATABASE_GATEWAY_KEY}"
  if [ -f "${DATABASE_GATEWAY_CA_FILE:-}" ]; then
    install -o proxysql -g proxysql -m 0644 "${DATABASE_GATEWAY_CA_FILE}" "${DATABASE_GATEWAY_CA}"
  else
    install -o proxysql -g proxysql -m 0644 "${DATABASE_GATEWAY_CERTIFICATE_FILE}" "${DATABASE_GATEWAY_CA}"
  fi
  DATABASE_GATEWAY_TLS_TRUST=public
elif [ ! -f "${DATABASE_GATEWAY_CERT}" ] || ! openssl x509 -in "${DATABASE_GATEWAY_CERT}" -noout -checkhost "db-probe.${DATABASE_GATEWAY_SUFFIX}" >/dev/null 2>&1 || ! openssl x509 -in "${DATABASE_GATEWAY_CERT}" -noout -checkend 2592000 >/dev/null 2>&1; then
  log "Generating the fallback Panelavo database client CA ..."
  rm -f "${DATABASE_GATEWAY_CERT}" "${DATABASE_GATEWAY_KEY}" "${DATABASE_GATEWAY_CA}" "${DATABASE_GATEWAY_ROOT}/panelavo-ca.key" "${DATABASE_GATEWAY_DATA}/panelavo-ca.key" "${DATABASE_GATEWAY_DATA}/gateway.csr"
  openssl genrsa -out "${DATABASE_GATEWAY_ROOT}/panelavo-ca.key" 4096 >/dev/null 2>&1
  chmod 0600 "${DATABASE_GATEWAY_ROOT}/panelavo-ca.key"
  openssl req -x509 -new -key "${DATABASE_GATEWAY_ROOT}/panelavo-ca.key" -sha256 -days 3650 -subj '/CN=Panelavo Database Client CA' -out "${DATABASE_GATEWAY_CA}" >/dev/null 2>&1
  openssl genrsa -out "${DATABASE_GATEWAY_KEY}" 3072 >/dev/null 2>&1
  openssl req -new -key "${DATABASE_GATEWAY_KEY}" -subj "/CN=*.${DATABASE_GATEWAY_SUFFIX}" -addext "subjectAltName=DNS:*.${DATABASE_GATEWAY_SUFFIX}" -out "${DATABASE_GATEWAY_DATA}/gateway.csr" >/dev/null 2>&1
  openssl x509 -req -in "${DATABASE_GATEWAY_DATA}/gateway.csr" -CA "${DATABASE_GATEWAY_CA}" -CAkey "${DATABASE_GATEWAY_ROOT}/panelavo-ca.key" -CAcreateserial -out "${DATABASE_GATEWAY_CERT}" -days 825 -sha256 -extfile <(printf 'subjectAltName=DNS:*.%s\nextendedKeyUsage=serverAuth\n' "${DATABASE_GATEWAY_SUFFIX}") >/dev/null 2>&1
  rm -f "${DATABASE_GATEWAY_DATA}/gateway.csr" "${DATABASE_GATEWAY_DATA}/proxysql-ca.srl"
  chown proxysql:proxysql "${DATABASE_GATEWAY_CERT}" "${DATABASE_GATEWAY_KEY}" "${DATABASE_GATEWAY_CA}"
  chmod 0644 "${DATABASE_GATEWAY_CERT}" "${DATABASE_GATEWAY_CA}"
  chmod 0600 "${DATABASE_GATEWAY_KEY}" "${DATABASE_GATEWAY_ROOT}/panelavo-ca.key"
else
  if openssl x509 -in "${DATABASE_GATEWAY_CERT}" -issuer -noout 2>/dev/null | grep -q 'Panelavo Database Client CA'; then
    DATABASE_GATEWAY_TLS_TRUST=panelavo-ca
  else
    DATABASE_GATEWAY_TLS_TRUST=public
  fi
fi

PROXYSQL_INTERFACES=""
for PORT in $(seq 44000 44255); do
  [ -z "${PROXYSQL_INTERFACES}" ] || PROXYSQL_INTERFACES+=";"
  PROXYSQL_INTERFACES+="127.0.0.1:${PORT}"
done
cat > "${DATABASE_GATEWAY_CONFIG}" <<EOF
datadir="${DATABASE_GATEWAY_DATA}"
admin_variables=
{
  admin_credentials="${DATABASE_GATEWAY_ADMIN_USER}:${DATABASE_GATEWAY_ADMIN_PASSWORD}"
  mysql_ifaces="127.0.0.1:16032"
  refresh_interval=2000
}
mysql_variables=
{
  threads=2
  max_connections=5120
  default_query_delay=0
  default_query_timeout=120000
  poll_timeout=2000
  interfaces="${PROXYSQL_INTERFACES}"
  default_schema="information_schema"
  stacksize=1048576
  server_version="8.4.0"
  connect_timeout_server=3000
  monitor_username="${DATABASE_GATEWAY_MONITOR_USER}"
  monitor_password="${DATABASE_GATEWAY_MONITOR_PASSWORD}"
  monitor_connect_interval=10000
  monitor_ping_interval=10000
  ping_interval_server_msec=120000
  ping_timeout_server=1000
  commands_stats=true
  sessions_sort=true
  have_ssl=true
  proxy_protocol_networks="127.0.0.1/32"
}
mysql_servers =
(
  { address="127.0.0.1" ; port=3306 ; hostgroup=10 ; max_connections=1024 ; use_ssl=1 }
)
mysql_users = ()
mysql_query_rules = ()
EOF
chown root:proxysql "${DATABASE_GATEWAY_CONFIG}"
chmod 0640 "${DATABASE_GATEWAY_CONFIG}"

cat > /etc/systemd/system/panelavo-database-gateway.service <<EOF
[Unit]
Description=Panelavo private MySQL endpoint gateway
After=network.target ${MYSQL_SERVICE}.service
Requires=${MYSQL_SERVICE}.service

[Service]
Type=simple
User=proxysql
Group=proxysql
ExecStart=/usr/bin/proxysql -f -c ${DATABASE_GATEWAY_CONFIG} -D ${DATABASE_GATEWAY_DATA}
Restart=on-failure
RestartSec=5
LimitNOFILE=8192
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATABASE_GATEWAY_DATA}

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now panelavo-database-gateway.service >/dev/null
for _ in $(seq 1 30); do
  if mysql --protocol=tcp -h 127.0.0.1 -P 16032 -u "${DATABASE_GATEWAY_ADMIN_USER}" "-p${DATABASE_GATEWAY_ADMIN_PASSWORD}" -NBe 'SELECT 1' >/dev/null 2>&1; then GATEWAY_ADMIN_READY=true; break; fi
  sleep 1
done
[ "${GATEWAY_ADMIN_READY:-false}" = "true" ] || die "The private database gateway did not become ready."
mysql --protocol=tcp -h 127.0.0.1 -P 16032 -u "${DATABASE_GATEWAY_ADMIN_USER}" "-p${DATABASE_GATEWAY_ADMIN_PASSWORD}" <<'PROXYSQLSQL' >/dev/null
DELETE FROM mysql_servers WHERE hostgroup_id=10;
INSERT INTO mysql_servers (hostgroup_id,hostname,port,status,max_connections,use_ssl) VALUES (10,'127.0.0.1',3306,'ONLINE',1024,1);
LOAD MYSQL SERVERS TO RUNTIME;
SAVE MYSQL SERVERS TO DISK;
UPDATE global_variables SET variable_value='${DATABASE_GATEWAY_MONITOR_USER}' WHERE variable_name='mysql-monitor_username';
UPDATE global_variables SET variable_value='${DATABASE_GATEWAY_MONITOR_PASSWORD}' WHERE variable_name='mysql-monitor_password';
UPDATE global_variables SET variable_value='10000' WHERE variable_name IN ('mysql-monitor_connect_interval','mysql-monitor_ping_interval');
UPDATE global_variables SET variable_value='127.0.0.1/32' WHERE variable_name='mysql-proxy_protocol_networks';
LOAD MYSQL VARIABLES TO RUNTIME;
SAVE MYSQL VARIABLES TO DISK;
PROXYSQL RELOAD TLS;
PROXYSQLSQL

# Preserve endpoint records on reruns while updating only trusted host-level
# configuration. A suffix cannot change while endpoints exist.
DATABASE_GATEWAY_STATE="${DATABASE_GATEWAY_ROOT}/endpoints.json"
DATABASE_GATEWAY_STATE="${DATABASE_GATEWAY_STATE}" DATABASE_GATEWAY_SUFFIX="${DATABASE_GATEWAY_SUFFIX}" DATABASE_GATEWAY_TLS_TRUST="${DATABASE_GATEWAY_TLS_TRUST}" node <<'NODE'
const fs = require('node:fs');
const path = process.env.DATABASE_GATEWAY_STATE;
let existing = {};
try { existing = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
const endpoints = existing.endpoints && typeof existing.endpoints === 'object' ? existing.endpoints : {};
if (Object.keys(endpoints).length && existing.suffix && existing.suffix !== process.env.DATABASE_GATEWAY_SUFFIX) {
  throw new Error('Revoke active database endpoints before changing DATABASE_GATEWAY_SUFFIX.');
}
const state = { ...existing, version: 1, enabled: true, suffix: process.env.DATABASE_GATEWAY_SUFFIX, publicPortStart: 43000, proxyPortStart: 44000, slots: 256, tlsTrust: process.env.DATABASE_GATEWAY_TLS_TRUST, endpoints };
const temporary = `${path}.setup-${process.pid}`;
fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
fs.renameSync(temporary, path);
NODE
chown root:root "${DATABASE_GATEWAY_STATE}" "${DATABASE_GATEWAY_ADMIN}"
chmod 0600 "${DATABASE_GATEWAY_STATE}" "${DATABASE_GATEWAY_ADMIN}"

nginx -V 2>&1 | grep -q -- '--with-stream=dynamic' || die "The CloudPanel Nginx build does not provide the required Stream module."
[ -f /etc/nginx/modules-enabled/50-mod-stream.conf ] || die "The Nginx Stream module is not enabled."
install -d -o root -g root -m 0755 /etc/nginx/panelavo-streams
NGINX_MAIN_BACKUP="$(mktemp)"
cp /etc/nginx/nginx.conf "${NGINX_MAIN_BACKUP}"
if ! grep -q 'panelavo-database-stream' /etc/nginx/nginx.conf; then
  if grep -Eq '^[[:space:]]*stream[[:space:]]*\{' /etc/nginx/nginx.conf; then
    rm -f "${NGINX_MAIN_BACKUP}"
    die "An unmanaged Nginx stream block already exists. Merge /etc/nginx/panelavo-streams/*.conf into that block before rerunning setup."
  fi
  cat >> /etc/nginx/nginx.conf <<'NGINXSTREAM'

# panelavo-database-stream
stream {
    log_format panelavo_database '$remote_addr [$time_local] $protocol $status $bytes_sent $bytes_received $session_time';
    limit_conn_zone $binary_remote_addr zone=panelavo_database_per_ip:10m;
    include /etc/nginx/panelavo-streams/*.conf;
}
NGINXSTREAM
fi
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  rm -f "${NGINX_MAIN_BACKUP}"
else
  cp "${NGINX_MAIN_BACKUP}" /etc/nginx/nginx.conf
  rm -f "${NGINX_MAIN_BACKUP}"
  die "Nginx rejected the database Stream configuration; the previous configuration was restored."
fi
cat > /etc/logrotate.d/panelavo-database-gateway <<'LOGROTATE'
/var/log/nginx/panelavo-database-gateway.log /var/lib/panelavo/database-gateway/proxysql/*.log {
    daily
    rotate 14
    size 50M
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        [ ! -s /run/nginx.pid ] || kill -USR1 $(cat /run/nginx.pid)
    endscript
}
LOGROTATE
log "Private database gateway provisioned for *.${DATABASE_GATEWAY_SUFFIX}."

# ---------------------------------------------------------------------------
# 8. Root-owned CloudPanel broker and narrow sudo access
# ---------------------------------------------------------------------------
BROKER_ROOT="/usr/local/libexec/panelavo"
BROKER_PATH="${BROKER_ROOT}/panelavo-broker"
BROKER_PROTOCOL_VERSION="$(node -p "require('${SRC_DIR}/package.json').panelavo.brokerProtocolVersion")"
SUDOERS_FILE="/etc/sudoers.d/zz-panelavo-${SITE_USER}"
BOUNDARY_SUDOERS_FILE="/etc/sudoers.d/zz-panelavo-cloudpanel-boundary"
LEGACY_SUDOERS_FILE="/etc/sudoers.d/panelavo-${SITE_USER}"

# Root must never execute the site-user-owned bridge from the deployed tree.
install -d -o root -g root -m 0755 "${BROKER_ROOT}"
install -d -o root -g root -m 0700 /var/lib/panelavo/rootless-migrations
install -o root -g root -m 0755 "${SRC_DIR}/scripts/panelavo-broker" "${BROKER_PATH}"
install -o root -g root -m 0644 "${SRC_DIR}/scripts/cloudpanel-bridge.php" "${BROKER_ROOT}/cloudpanel-bridge.php"

BOUNDARY_SUDOERS_TEMP="$(mktemp)"
cat > "${BOUNDARY_SUDOERS_TEMP}" <<'EOF'
# CloudPanel's stock policy grants every Unix user an unrestricted clpctl
# wrapper. Panelavo's browser terminal must never turn that into host control.
ALL ALL=(ALL) !/usr/bin/clpctlWrapper
# Preserve only the host administrators CloudPanel itself requires.
root ALL=(ALL) NOPASSWD: /usr/bin/clpctlWrapper
clp ALL=(ALL) NOPASSWD: ALL
EOF
chmod 0440 "${BOUNDARY_SUDOERS_TEMP}"
visudo -cf "${BOUNDARY_SUDOERS_TEMP}" >/dev/null || die "Generated CloudPanel boundary sudoers file is invalid."
install -o root -g root -m 0440 "${BOUNDARY_SUDOERS_TEMP}" "${BOUNDARY_SUDOERS_FILE}"
rm -f "${BOUNDARY_SUDOERS_TEMP}"

SUDOERS_TEMP="$(mktemp)"
cat > "${SUDOERS_TEMP}" <<EOF
# Panelavo may invoke only the root-owned, schema-validating broker.
${SITE_USER} ALL=(root) NOPASSWD: ${BROKER_PATH}
EOF
chmod 0440 "${SUDOERS_TEMP}"
visudo -cf "${SUDOERS_TEMP}" >/dev/null || die "Generated broker sudoers file is invalid."
install -o root -g root -m 0440 "${SUDOERS_TEMP}" "${SUDOERS_FILE}"
rm -f "${SUDOERS_TEMP}"
visudo -c >/dev/null || die "The combined sudoers policy is invalid."
sudo -n -l /usr/bin/clpctlWrapper >/dev/null 2>&1 \
  || die "The root operator can no longer invoke CloudPanel's wrapper."
if sudo -u "${SITE_USER}" sudo -n -l /usr/bin/clpctlWrapper >/dev/null 2>&1; then
  die "The Panelavo site user can still invoke CloudPanel's unrestricted wrapper."
fi
while IFS=: read -r CLOUDPANEL_UNIX_USER _ _ _ _ CLOUDPANEL_UNIX_HOME _; do
  case "${CLOUDPANEL_UNIX_HOME}" in /home/*) ;; *) continue ;; esac
  [ "${CLOUDPANEL_UNIX_USER}" = clp ] && continue
  if sudo -u "${CLOUDPANEL_UNIX_USER}" sudo -n -l /usr/bin/clpctlWrapper >/dev/null 2>&1; then
    die "Unix user ${CLOUDPANEL_UNIX_USER} can still invoke CloudPanel's unrestricted wrapper."
  fi
done < <(getent passwd)

BROKER_HEALTH="$(printf '{\"protocolVersion\":%s,\"action\":\"broker-health\"}' "${BROKER_PROTOCOL_VERSION}" | sudo -u "${SITE_USER}" sudo -n "${BROKER_PATH}")" || die "The installed CloudPanel broker did not start."
BROKER_HEALTH="${BROKER_HEALTH}" BROKER_PROTOCOL_VERSION="${BROKER_PROTOCOL_VERSION}" node <<'NODE' || die "The installed CloudPanel broker failed its protocol health check."
const result = JSON.parse(process.env.BROKER_HEALTH || '{}');
const data = result.data || {};
if (!result.ok || data.protocolVersion !== Number(process.env.BROKER_PROTOCOL_VERSION) || data.privileged !== true || data.cloudPanelAvailable !== true || data.directClpctlDenied !== true || data.databaseGatewayReady !== true) process.exit(1);
NODE

[ "${LEGACY_SUDOERS_FILE}" = "${SUDOERS_FILE}" ] || rm -f "${LEGACY_SUDOERS_FILE}"
if grep -Eq 'NOPASSWD:.*(/usr/bin/php|/usr/bin/clpctl)([ ,]|$)' "${SUDOERS_FILE}"; then
  die "Unsafe raw PHP or clpctl sudo access remains in ${SUDOERS_FILE}."
fi
log "Root-owned CloudPanel broker installed and verified for ${SITE_USER}."

# ---------------------------------------------------------------------------
# 9. Deploy the application
# ---------------------------------------------------------------------------
log "Deploying application files to ${SITE_ROOT} ..."
mkdir -p "${SITE_ROOT}"
# Repair ownership before syncing so rerunning trusted setup can recover an
# older installation whose application directories drifted to root ownership.
# Keep the deployed tree site-user-owned even though setup itself runs as root.
chown -hR "${SITE_USER}:${SITE_USER}" "${SITE_ROOT}"
rsync -a --delete --chown="${SITE_USER}:${SITE_USER}" \
  --exclude .git \
  --exclude node_modules \
  --exclude .next \
  --exclude .data \
  --exclude .env.local \
  "${SRC_DIR}/" "${SITE_ROOT}/"

if [ ! -f "${SITE_ROOT}/.env.local" ]; then
  log "Writing .env.local ..."
  cat > "${SITE_ROOT}/.env.local" <<EOF
NEXT_PUBLIC_APP_NAME=panelavo
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -base64 48 | tr -d '\n')
SESSION_MAX_AGE_SECONDS=3600
${PANEL_BASE_DOMAIN:+PANEL_BASE_DOMAIN=${PANEL_BASE_DOMAIN}}
PANEL_ADDRESS_MODE=${PANEL_ADDRESS_MODE}
DATABASE_GATEWAY_SUFFIX=${DATABASE_GATEWAY_SUFFIX}
${PANEL_UPDATE_REPOSITORY:+PANEL_UPDATE_REPOSITORY=${PANEL_UPDATE_REPOSITORY}}
EOF
fi
# Seed newly introduced optional settings on trusted reruns without replacing
# an operator's existing values.
if [ -n "${PANEL_UPDATE_REPOSITORY}" ] && ! grep -q '^PANEL_UPDATE_REPOSITORY=' "${SITE_ROOT}/.env.local"; then
  echo "PANEL_UPDATE_REPOSITORY=${PANEL_UPDATE_REPOSITORY}" >> "${SITE_ROOT}/.env.local"
fi
if ! grep -q '^PANEL_ADDRESS_MODE=' "${SITE_ROOT}/.env.local"; then
  echo "PANEL_ADDRESS_MODE=${PANEL_ADDRESS_MODE}" >> "${SITE_ROOT}/.env.local"
fi
if ! grep -q '^DATABASE_GATEWAY_SUFFIX=' "${SITE_ROOT}/.env.local"; then
  echo "DATABASE_GATEWAY_SUFFIX=${DATABASE_GATEWAY_SUFFIX}" >> "${SITE_ROOT}/.env.local"
fi
# Record where the database manager actually lives so the panel's links keep
# working even if the base domain is changed later. Idempotent for reruns and
# for installs whose .env.local predates the database manager.
if [ "${DB_MANAGER_PROVISIONED}" = "true" ] && ! grep -q '^DATABASE_MANAGER_URL=' "${SITE_ROOT}/.env.local"; then
  echo "DATABASE_MANAGER_URL=https://${DB_MANAGER_DOMAIN}" >> "${SITE_ROOT}/.env.local"
fi
mkdir -p "${SITE_ROOT}/.data"
chown -hR "${SITE_USER}:${SITE_USER}" "${SITE_ROOT}"
chmod 700 "${SITE_ROOT}/.data"
chmod 600 "${SITE_ROOT}/.env.local"

log "Installing dependencies and building (as ${SITE_USER}) ..."
sudo -u "${SITE_USER}" bash -c "cd '${SITE_ROOT}' && export PATH=/usr/local/bin:\$PATH && npx -y pnpm@10.12.1 install --frozen-lockfile && npx -y pnpm@10.12.1 build"

# ---------------------------------------------------------------------------
# 10. Host with PM2 (shared install, panelavo process, boot persistence)
# ---------------------------------------------------------------------------
log "Starting the panel with PM2 ..."
sudo -u "${SITE_USER}" bash -c "cd '${SITE_ROOT}' && export PATH=/usr/local/bin:\$PATH && /usr/local/bin/pm2 startOrReload ecosystem.config.js && /usr/local/bin/pm2 save"

# systemd unit so the PM2 process list survives reboots.
env PATH="/usr/local/bin:${PATH}" /usr/local/bin/pm2 startup systemd -u "${SITE_USER}" --hp "/home/${SITE_USER}" >/dev/null
sudo -u "${SITE_USER}" /usr/local/bin/pm2 save >/dev/null

# Bound Panelavo and PM2 logs automatically. Hosted-site container logs are
# bounded separately when each private rootless daemon is initialized.
if ! sudo -u "${SITE_USER}" -H /usr/local/bin/pm2 describe pm2-logrotate >/dev/null 2>&1; then
  sudo -u "${SITE_USER}" -H /usr/local/bin/pm2 install pm2-logrotate >/dev/null
fi
sudo -u "${SITE_USER}" -H /usr/local/bin/pm2 set pm2-logrotate:max_size 20M >/dev/null
sudo -u "${SITE_USER}" -H /usr/local/bin/pm2 set pm2-logrotate:retain 14 >/dev/null
sudo -u "${SITE_USER}" -H /usr/local/bin/pm2 set pm2-logrotate:compress true >/dev/null
sudo -u "${SITE_USER}" -H /usr/local/bin/pm2 save >/dev/null

# Only mark the trusted release current after its build and PM2 reload both
# succeed. Preserve operator-selected update settings while clearing stale
# worker failure state from the release that setup just replaced.
SOURCE_COMMIT="$(git -C "${SRC_DIR}" rev-parse HEAD 2>/dev/null || true)"
SOURCE_VERSION="$(node -p "require('${SRC_DIR}/package.json').version")"
sudo -u "${SITE_USER}" env UPDATE_STATE_FILE="${SITE_ROOT}/.data/update-state.json" SOURCE_COMMIT="${SOURCE_COMMIT}" SOURCE_VERSION="${SOURCE_VERSION}" PANEL_UPDATE_REPOSITORY="${PANEL_UPDATE_REPOSITORY:-}" node <<'NODE'
const fs = require('node:fs');
let existing = {};
try { existing = JSON.parse(fs.readFileSync(process.env.UPDATE_STATE_FILE, 'utf8')); } catch {}
const installedCommit = process.env.SOURCE_COMMIT || existing.installedCommit;
const state = {
  status: installedCommit ? 'current' : 'idle',
  currentVersion: process.env.SOURCE_VERSION,
  repository: process.env.PANEL_UPDATE_REPOSITORY || existing.repository || '',
  branch: existing.branch || 'main',
  installedCommit,
  remoteCommit: installedCommit,
  completedAt: new Date().toISOString(),
  logFile: existing.logFile || '.data/update.log'
};
const temporary = `${process.env.UPDATE_STATE_FILE}.setup-${process.pid}`;
fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
fs.renameSync(temporary, process.env.UPDATE_STATE_FILE);
NODE

# ---------------------------------------------------------------------------
# 11. Firewall rules: expose the panel, hide CloudPanel's own port (8443).
#     Never activate an inactive firewall during remote setup unless explicitly
#     requested with ENABLE_UFW=true. Set EXPOSE_CLOUDPANEL=true to keep 8443.
# ---------------------------------------------------------------------------
CLOUDPANEL_PORT="8443"
if command -v ufw >/dev/null 2>&1; then
  UFW_WAS_ACTIVE=false
  ufw status 2>/dev/null | grep -q "Status: active" && UFW_WAS_ACTIVE=true

  # Preserve the actual port used by this SSH session before making any UFW
  # change. This also supports servers whose sshd does not listen on port 22.
  if [[ "${SSH_SERVER_PORT}" =~ ^[0-9]+$ ]] && [ "${SSH_SERVER_PORT}" -ge 1 ] && [ "${SSH_SERVER_PORT}" -le 65535 ]; then
    ufw allow "${SSH_SERVER_PORT}/tcp" >/dev/null 2>&1 || die "Could not preserve SSH port ${SSH_SERVER_PORT} in ufw."
  else
    ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || die "Could not preserve SSH access in ufw."
  fi
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  # Raw database listeners are never public. Only the per-endpoint gateway
  # range is reachable, and inactive ports have no Nginx listener.
  for DATABASE_PORT in 3306 33060; do
    ufw delete allow "${DATABASE_PORT}/tcp" >/dev/null 2>&1 || true
    ufw delete deny "${DATABASE_PORT}/tcp" >/dev/null 2>&1 || true
    ufw insert 1 deny "${DATABASE_PORT}/tcp" >/dev/null 2>&1 || die "Could not prioritize the database port ${DATABASE_PORT} deny rule in ufw."
  done
  ufw allow 43000:43255/tcp >/dev/null 2>&1 || die "Could not allow the managed database endpoint port range in ufw."
  # The application listener is loopback-only. Remove rules left by older
  # installers so authentication cannot bypass the HTTPS Nginx vhost.
  ufw delete allow "${APP_PORT}/tcp" >/dev/null 2>&1 || true
  ufw deny "${APP_PORT}/tcp" >/dev/null 2>&1 || true
  if [ "${EXPOSE_CLOUDPANEL:-false}" != "true" ]; then
    # CloudPanel may install a broad 8433:8443 allow before this exact rule.
    # Reinsert the exact deny first so UFW evaluates it before that range.
    ufw delete allow "${CLOUDPANEL_PORT}/tcp" >/dev/null 2>&1 || true
    ufw delete deny "${CLOUDPANEL_PORT}/tcp" >/dev/null 2>&1 || true
    ufw insert 1 deny "${CLOUDPANEL_PORT}/tcp" >/dev/null 2>&1 || die "Could not prioritize the CloudPanel port deny rule in ufw."
    log "Prepared a firewall deny rule for CloudPanel port ${CLOUDPANEL_PORT}."
    log "Reach CloudPanel via an SSH tunnel if ever needed: ssh -L ${CLOUDPANEL_PORT}:127.0.0.1:${CLOUDPANEL_PORT} root@${SERVER_IP}"
  else
    ufw delete deny "${CLOUDPANEL_PORT}/tcp" >/dev/null 2>&1 || true
    ufw allow "${CLOUDPANEL_PORT}/tcp" >/dev/null 2>&1 || true
    warn "EXPOSE_CLOUDPANEL=true — CloudPanel stays reachable on port ${CLOUDPANEL_PORT}."
  fi

  if [ "${UFW_WAS_ACTIVE}" = "false" ]; then
    if [ "${ENABLE_UFW:-false}" = "true" ]; then
      log "ENABLE_UFW=true — activating the prepared firewall rules ..."
      ufw --force enable >/dev/null 2>&1 || die "Could not enable ufw."
    else
      warn "ufw was inactive, so setup prepared rules but did not enable it during this SSH session."
      warn "Review 'ufw status numbered' from provider-console recovery access, then enable it manually if desired."
    fi
  fi
else
  warn "ufw is not installed — port ${CLOUDPANEL_PORT} may still be publicly reachable. Block it in your provider firewall."
fi

# ---------------------------------------------------------------------------
# 12. Panel SSL: once the selected hostname resolves here, issue individual
#     HTTP-01 certificates for the panel and database manager. sslip.io does
#     not provide wildcard certificates.
# ---------------------------------------------------------------------------
PANEL_URL="https://${PANEL_DOMAIN}"
if [ -n "${PANEL_BASE_DOMAIN}" ]; then
  log "Re-checking address DNS before issuing the panel certificate ..."
  for _ in $(seq 1 15); do
    if wildcard_points_here; then WILDCARD_OK=yes; break; fi
    sleep 2
  done
  if [ "${WILDCARD_OK:-}" = "yes" ]; then
    log "Issuing a Let's Encrypt certificate for ${PANEL_DOMAIN} ..."
    if clpctl lets-encrypt:install:certificate --domainName="${PANEL_DOMAIN}" >/dev/null 2>&1; then
      PANEL_URL="https://${PANEL_DOMAIN}"
      log "Certificate installed — the panel is served on ${PANEL_URL}"
    else
      warn "Let's Encrypt issuance failed for ${PANEL_DOMAIN}; the panel keeps its self-signed certificate."
      warn "Retry later with: clpctl lets-encrypt:install:certificate --domainName=${PANEL_DOMAIN}"
      PANEL_URL="https://${PANEL_DOMAIN}"
    fi
    if [ "${DB_MANAGER_PROVISIONED}" = "true" ]; then
      log "Issuing a Let's Encrypt certificate for ${DB_MANAGER_DOMAIN} ..."
      if clpctl lets-encrypt:install:certificate --domainName="${DB_MANAGER_DOMAIN}" >/dev/null 2>&1; then
        log "Certificate installed — the database manager is served on https://${DB_MANAGER_DOMAIN}"
      else
        warn "Let's Encrypt issuance failed for ${DB_MANAGER_DOMAIN}; browsers will warn until one is issued."
        warn "Retry later with: clpctl lets-encrypt:install:certificate --domainName=${DB_MANAGER_DOMAIN}"
      fi
    fi
  else
    warn "The hostname ${WILDCARD_PROBE} does not resolve here yet."
    warn "The panel will show a setup screen until it does; SSL for ${PANEL_DOMAIN} can then be issued with:"
    warn "  clpctl lets-encrypt:install:certificate --domainName=${PANEL_DOMAIN}"
  fi
fi

# File-manager uploads are base64-encoded JSON, so the proxy allowance must be
# larger than the 64 MiB decoded-file limit enforced by the browser and bridge.
# MCP artifacts use bounded raw chunks; disable proxy request buffering so
# those chunks stream to Panelavo instead of being duplicated in Nginx temp
# storage first.
# Backups and Operations are synchronous and may legitimately run for up to 30
# minutes, so keep the public proxy open slightly longer than the application.
PANEL_VHOST="/etc/nginx/sites-enabled/${PANEL_DOMAIN}.conf"
if [ -f "${PANEL_VHOST}" ]; then
  log "Configuring the panel proxy limits ..."
  PANEL_VHOST_BACKUP="$(mktemp)"
  cp "${PANEL_VHOST}" "${PANEL_VHOST_BACKUP}"
  sed -i '/# panelavo-upload-limit$/d' "${PANEL_VHOST}"
  sed -i '/# panelavo-artifact-streaming$/d' "${PANEL_VHOST}"
  sed -i '/# panelavo-long-request-timeout$/d' "${PANEL_VHOST}"
  sed -i '/^[[:space:]]*server[[:space:]]*{/a\    client_max_body_size 96m; # panelavo-upload-limit' "${PANEL_VHOST}"
  sed -i '/^[[:space:]]*server[[:space:]]*{/a\    proxy_request_buffering off; # panelavo-artifact-streaming' "${PANEL_VHOST}"
  sed -i '/^[[:space:]]*server[[:space:]]*{/a\    proxy_send_timeout 1900s; # panelavo-long-request-timeout' "${PANEL_VHOST}"
  sed -i '/^[[:space:]]*server[[:space:]]*{/a\    proxy_read_timeout 1900s; # panelavo-long-request-timeout' "${PANEL_VHOST}"
  # CloudPanel's broad well-known location serves files directly and otherwise
  # prevents Next.js from answering MCP OAuth discovery. Keep ACME challenges
  # local while allowing every non-ACME well-known path to reach location /.
  sed -i -E 's|^([[:space:]]*)location[[:space:]]+~[[:space:]]+[^{}[:space:]]*well-known[[:space:]]*\{|\1location ~ ^/[.]well-known/acme-challenge/ { # panelavo-mcp-discovery|' "${PANEL_VHOST}"
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    rm -f "${PANEL_VHOST_BACKUP}"
  else
    cp "${PANEL_VHOST_BACKUP}" "${PANEL_VHOST}"
    rm -f "${PANEL_VHOST_BACKUP}"
    die "The panel proxy-limit configuration failed nginx validation; the previous vhost was restored."
  fi
else
  warn "Panel vhost ${PANEL_VHOST} was not found; uploads and long-running requests may retain Nginx defaults."
fi

# The phpMyAdmin database manager accepts SQL dump uploads, so its vhost needs
# the same treatment: Nginx's default 1m body limit rejects any real import
# with a 413 before PHP ever sees it, and long imports must not be cut off.
DB_MANAGER_VHOST="/etc/nginx/sites-enabled/${DB_MANAGER_DOMAIN}.conf"
if [ "${DB_MANAGER_PROVISIONED}" = "true" ] && [ -f "${DB_MANAGER_VHOST}" ]; then
  log "Configuring the database manager upload limits ..."
  DB_MANAGER_VHOST_BACKUP="$(mktemp)"
  cp "${DB_MANAGER_VHOST}" "${DB_MANAGER_VHOST_BACKUP}"
  sed -i '/# panelavo-db-import-limit$/d' "${DB_MANAGER_VHOST}"
  sed -i '/^[[:space:]]*server[[:space:]]*{/a\    client_max_body_size 512m; # panelavo-db-import-limit' "${DB_MANAGER_VHOST}"
  sed -i '/^[[:space:]]*server[[:space:]]*{/a\    fastcgi_read_timeout 3600s; # panelavo-db-import-limit' "${DB_MANAGER_VHOST}"
  sed -i '/^[[:space:]]*server[[:space:]]*{/a\    fastcgi_send_timeout 3600s; # panelavo-db-import-limit' "${DB_MANAGER_VHOST}"
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    rm -f "${DB_MANAGER_VHOST_BACKUP}"
  else
    cp "${DB_MANAGER_VHOST_BACKUP}" "${DB_MANAGER_VHOST}"
    rm -f "${DB_MANAGER_VHOST_BACKUP}"
    die "The database manager upload-limit configuration failed nginx validation; the previous vhost was restored."
  fi
elif [ "${DB_MANAGER_PROVISIONED}" = "true" ]; then
  warn "Database manager vhost ${DB_MANAGER_VHOST} was not found; SQL imports may hit Nginx's default body-size limit."
fi

# ---------------------------------------------------------------------------
# 13. Health check + summary
# ---------------------------------------------------------------------------
log "Waiting for the panel to come up ..."
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${APP_PORT}/api/health/ready"; then HEALTH=ok; break; fi
  sleep 2
done
[ "${HEALTH:-}" = "ok" ] || warn "panelavo did not become ready on its private port ${APP_PORT} — check 'pm2 logs panelavo' as ${SITE_USER}."

cat <<EOF

============================================================
 panelavo setup complete
============================================================
 Panel address:      ${PANEL_URL}
 Database manager:   $([ "${DB_MANAGER_PROVISIONED}" = "true" ] && echo "https://${DB_MANAGER_DOMAIN}" || echo "(not provisioned)")
 Database endpoints: *.${DATABASE_GATEWAY_SUFFIX} (ports 43000-43255, TLS required)
 Recovery tunnel:   ssh -L ${APP_PORT}:127.0.0.1:${APP_PORT} root@${SERVER_IP}
 CloudPanel:         https://127.0.0.1:8443 (firewall rule prepared; use an SSH tunnel)

 Super Admin:        ${ADMIN_USER}
 Super Admin pass:   ${ADMIN_PASSWORD}
 Site user:          ${SITE_USER}
 Site user password: ${SITE_USER_PASSWORD}

 Log in to panelavo with the Super Admin credentials.
 Manage the process as ${SITE_USER}: pm2 status | pm2 logs panelavo
============================================================
EOF
rm -f "${SETUP_CREDENTIALS_FILE}"
