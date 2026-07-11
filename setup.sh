#!/usr/bin/env bash
#
# panelavo — standalone provisioning script.
#
# Turns a fresh Debian/Ubuntu server into a fully working panel host:
#   1. Detects the OS and installs CloudPanel if it is not present.
#   2. Creates the initial CloudPanel admin user.
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
#   PANEL_BASE_DOMAIN=example.com    base domain for site subdomains
#                                    (site-<id>.<ip>.<base>); reconfigurable
#                                    later from the panel
#   PANEL_DOMAIN=panel.example.com   panel site domain
#                                    (default panel.<ip>.<base-domain>, which
#                                    the wildcard record already covers)
#   PANEL_SITE_USER=panelavo         CloudPanel site/system user for panelavo
#   ADMIN_USER=admin                 CloudPanel admin username
#   ADMIN_PASSWORD=...               CloudPanel admin password (default random)
#   ADMIN_EMAIL=...                  CloudPanel admin e-mail
#   DB_ENGINE=MYSQL_8.4              CloudPanel database engine override
#   KEEP_FAIL2BAN_SSHD_RUNNING=true Keep fail2ban's sshd jail active during
#                                   setup and temporarily exempt this client
#   FAIL2BAN_SSHD_PREPAUSED=true    Jail was stopped in the provider console;
#                                   setup must restore it when finished
#
# The panel is reachable on http://<server-ip>:10443 (primary) and on the
# site domain through nginx once DNS points at the server.

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
}
trap remove_ssh_guard EXIT INT TERM

if command -v fail2ban-client >/dev/null 2>&1 && fail2ban-client status sshd >/dev/null 2>&1; then
  fail2ban-client set sshd unbanip "${SSH_CLIENT_IP}" >/dev/null 2>&1 || true
  if [ "${KEEP_FAIL2BAN_SSHD_RUNNING:-false}" = "true" ]; then
    if fail2ban-client get sshd ignoreip 2>/dev/null | tr ' ' '\n' | grep -Fqx "${SSH_CLIENT_IP}"; then
      log "Current SSH client ${SSH_CLIENT_IP} is already exempt from fail2ban."
    elif fail2ban-client set sshd addignoreip "${SSH_CLIENT_IP}" >/dev/null 2>&1; then
      FAIL2BAN_SSH_GUARD_ADDED=true
      log "Protected current SSH client ${SSH_CLIENT_IP} from fail2ban during setup."
    else
      die "Could not protect the current SSH client in fail2ban."
    fi
  elif fail2ban-client stop sshd >/dev/null 2>&1; then
    FAIL2BAN_SSH_JAIL_PAUSED=true
    log "Paused fail2ban's sshd jail for this setup run; it will be restored automatically."
  else
    die "Could not pause fail2ban's sshd jail. Use the provider console and run: fail2ban-client stop sshd"
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
apt-get install -y curl wget sudo ca-certificates rsync openssl git

# ---------------------------------------------------------------------------
# 3. Public IP
# ---------------------------------------------------------------------------
SERVER_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
[ -n "${SERVER_IP}" ] || SERVER_IP="$(hostname -I | awk '{print $1}')"
[ -n "${SERVER_IP}" ] || die "Could not determine the server IP address."
log "Server IP: ${SERVER_IP}"

# ---------------------------------------------------------------------------
# 3b. Interactive configuration (base domain + first CloudPanel admin)
#     Values already provided through the environment are never asked again.
#
#     One base domain drives everything: websites live on
#     site-<id>.<ip>.<base> and the panel itself on panel.<ip>.<base>, all
#     covered by the single wildcard record *.<ip>.<base>. The default base
#     domain's wildcard can be self-registered (ippointer), so an operator
#     without a domain of their own gets a working install with zero DNS work.
# ---------------------------------------------------------------------------
DEFAULT_BASE_DOMAIN="mehebub.com"
if [ -t 0 ]; then
  if [ -z "${PANEL_BASE_DOMAIN:-}" ]; then
    read -r -p "${LOG_PREFIX} Base domain for the panel and its sites [${DEFAULT_BASE_DOMAIN}]: " PANEL_BASE_DOMAIN_INPUT
    PANEL_BASE_DOMAIN="${PANEL_BASE_DOMAIN_INPUT:-$DEFAULT_BASE_DOMAIN}"
  fi
  if [ -z "${ADMIN_USER:-}" ]; then
    read -r -p "${LOG_PREFIX} CloudPanel admin username [admin]: " ADMIN_USER_INPUT
    ADMIN_USER="${ADMIN_USER_INPUT:-admin}"
  fi
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    while true; do
      read -r -s -p "${LOG_PREFIX} CloudPanel admin password (blank = generate): " ADMIN_PASSWORD_INPUT; echo
      if [ -z "${ADMIN_PASSWORD_INPUT}" ]; then break; fi
      if [ "${#ADMIN_PASSWORD_INPUT}" -lt 8 ]; then warn "Use at least 8 characters."; continue; fi
      read -r -s -p "${LOG_PREFIX} Confirm password: " ADMIN_PASSWORD_CONFIRM; echo
      [ "${ADMIN_PASSWORD_INPUT}" = "${ADMIN_PASSWORD_CONFIRM}" ] && { ADMIN_PASSWORD="${ADMIN_PASSWORD_INPUT}"; break; }
      warn "Passwords did not match — try again."
    done
  fi
fi
PANEL_BASE_DOMAIN="${PANEL_BASE_DOMAIN:-$DEFAULT_BASE_DOMAIN}"
# The panel rides the same wildcard as the sites it manages.
PANEL_DOMAIN="${PANEL_DOMAIN:-panel.${SERVER_IP}.${PANEL_BASE_DOMAIN}}"

if [ "${PANEL_BASE_DOMAIN}" = "${DEFAULT_BASE_DOMAIN}" ]; then
  log "Registering IP ${SERVER_IP} with ippointer.mehebub.com ..."
  curl -sS -X POST https://ippointer.mehebub.com -H "Content-Type: application/json" -d "{\"ip\":\"${SERVER_IP}\"}" || warn "Failed to register IP on ippointer."
fi

if [ -n "${PANEL_BASE_DOMAIN}" ]; then
  WILDCARD_RECORD="*.${SERVER_IP}.${PANEL_BASE_DOMAIN}"
  WILDCARD_PROBE="site-20001.${SERVER_IP}.${PANEL_BASE_DOMAIN}"
  
  wildcard_points_here() {
    local ips
    ips="$(getent ahostsv4 "${WILDCARD_PROBE}" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
    case " ${ips} " in *" ${SERVER_IP} "*) return 0 ;; *) return 1 ;; esac
  }

  log "Checking if ${WILDCARD_RECORD} points to this server (${SERVER_IP}) ..."
  # Briefly wait for propagation in case it was just created
  for _ in 1 2 3 4 5; do
    if wildcard_points_here; then break; fi
    sleep 2
  done

  if wildcard_points_here; then
    log "Wildcard DNS looks ready: ${WILDCARD_RECORD} -> ${SERVER_IP}"
  else
    warn "Wildcard DNS is not pointing here yet."
    warn "Please ensure you have an A record for ${WILDCARD_RECORD} pointing to ${SERVER_IP} at your DNS provider."
    warn "Site creation requires this record to be active."
  fi
fi
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@${PANEL_DOMAIN}}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)!Aa1}"
log "panelavo domain: ${PANEL_DOMAIN} — CloudPanel admin: ${ADMIN_USER}"

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
# 5. Initial CloudPanel admin user
# ---------------------------------------------------------------------------
if clpctl user:list 2>/dev/null | awk -F'|' 'NR>3 {gsub(/ /,"",$2); print $2}' | grep -qx "${ADMIN_USER}"; then
  log "CloudPanel user '${ADMIN_USER}' already exists — leaving it untouched."
  ADMIN_PASSWORD="(unchanged)"
else
  log "Creating CloudPanel admin user '${ADMIN_USER}' ..."
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

if [ ! -x /usr/local/bin/pm2 ]; then
  log "Installing shared PM2 into /usr/local ..."
  "${SHARED_NODE_ROOT}/bin/npm" install -g --prefix /usr/local pm2 >/dev/null
fi
log "PM2 $(/usr/local/bin/pm2 -v | tail -1) available system-wide."

# ---------------------------------------------------------------------------
# 7. CloudPanel site owned by the panelavo system user
# ---------------------------------------------------------------------------
SITE_ROOT="/home/${SITE_USER}/htdocs/${PANEL_DOMAIN}"
SITE_USER_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)!Aa1"
if [ -d "${SITE_ROOT}" ]; then
  log "Site ${PANEL_DOMAIN} already exists — skipping site creation."
  SITE_USER_PASSWORD="(unchanged)"
else
  log "Creating Node.js site ${PANEL_DOMAIN} (site user: ${SITE_USER}) ..."
  clpctl site:add:nodejs \
    --domainName="${PANEL_DOMAIN}" \
    --nodejsVersion="${NODEJS_SITE_VERSION}" \
    --appPort="${APP_PORT}" \
    --siteUser="${SITE_USER}" \
    --siteUserPassword="${SITE_USER_PASSWORD}"
fi
id "${SITE_USER}" >/dev/null 2>&1 || die "System user ${SITE_USER} was not created by CloudPanel."

# ---------------------------------------------------------------------------
# 8. Narrow sudo access for the panel's CloudPanel bridge
# ---------------------------------------------------------------------------
PHP_BIN="$(command -v php || echo /usr/bin/php)"
SUDOERS_FILE="/etc/sudoers.d/panelavo-${SITE_USER}"
cat > "${SUDOERS_FILE}" <<EOF
# panelavo: the Next.js app talks to CloudPanel through clpctl and a
# read-only PHP bridge, both executed via passwordless sudo.
${SITE_USER} ALL=(root) NOPASSWD: /usr/bin/clpctl, ${PHP_BIN}
EOF
chmod 0440 "${SUDOERS_FILE}"
visudo -cf "${SUDOERS_FILE}" >/dev/null || die "Generated sudoers file is invalid."
log "Sudo rules for ${SITE_USER} installed."

# ---------------------------------------------------------------------------
# 9. Deploy the application
# ---------------------------------------------------------------------------
log "Deploying application files to ${SITE_ROOT} ..."
mkdir -p "${SITE_ROOT}"
rsync -a --delete \
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
EOF
fi
mkdir -p "${SITE_ROOT}/.data"
chown -R "${SITE_USER}:${SITE_USER}" "${SITE_ROOT}"
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

# ---------------------------------------------------------------------------
# 11. Firewall: expose the panel, hide CloudPanel's own port (8443)
#     Set EXPOSE_CLOUDPANEL=true to keep 8443 reachable from the internet.
# ---------------------------------------------------------------------------
CLOUDPANEL_PORT="8443"
if command -v ufw >/dev/null 2>&1; then
  # Preserve the actual port used by this SSH session before making any UFW
  # change. This also supports servers whose sshd does not listen on port 22.
  if [[ "${SSH_SERVER_PORT}" =~ ^[0-9]+$ ]] && [ "${SSH_SERVER_PORT}" -ge 1 ] && [ "${SSH_SERVER_PORT}" -le 65535 ]; then
    ufw allow "${SSH_SERVER_PORT}/tcp" >/dev/null 2>&1 || die "Could not preserve SSH port ${SSH_SERVER_PORT} in ufw."
  else
    ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || die "Could not preserve SSH access in ufw."
  fi
  if ! ufw status 2>/dev/null | grep -q "Status: active"; then
    log "Enabling ufw (SSH, HTTP/HTTPS, and port ${APP_PORT} stay open) ..."
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    ufw --force enable >/dev/null 2>&1 || true
  fi
  ufw allow "${APP_PORT}/tcp" >/dev/null 2>&1 || true
  if [ "${EXPOSE_CLOUDPANEL:-false}" != "true" ]; then
    # Remove any existing allow rule, then explicitly deny public access.
    ufw delete allow "${CLOUDPANEL_PORT}/tcp" >/dev/null 2>&1 || true
    ufw deny "${CLOUDPANEL_PORT}/tcp" >/dev/null 2>&1 || true
    log "CloudPanel port ${CLOUDPANEL_PORT} is no longer exposed publicly."
    log "Reach CloudPanel via an SSH tunnel if ever needed: ssh -L ${CLOUDPANEL_PORT}:127.0.0.1:${CLOUDPANEL_PORT} root@${SERVER_IP}"
  else
    ufw allow "${CLOUDPANEL_PORT}/tcp" >/dev/null 2>&1 || true
    warn "EXPOSE_CLOUDPANEL=true — CloudPanel stays reachable on port ${CLOUDPANEL_PORT}."
  fi
else
  warn "ufw is not installed — port ${CLOUDPANEL_PORT} may still be publicly reachable. Block it in your provider firewall."
fi

# ---------------------------------------------------------------------------
# 12. Panel SSL: once the wildcard resolves here, the panel domain
#     (panel.<ip>.<base>) is covered by it, so a Let's Encrypt certificate
#     can be issued immediately. Re-check first — DNS often propagates while
#     CloudPanel was installing.
# ---------------------------------------------------------------------------
PANEL_URL="http://${SERVER_IP}:${APP_PORT}"
if [ -n "${PANEL_BASE_DOMAIN}" ]; then
  log "Re-checking wildcard DNS before issuing the panel certificate ..."
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
  else
    warn "The wildcard *.${SERVER_IP}.${PANEL_BASE_DOMAIN} does not resolve here yet."
    warn "The panel will show a setup screen until it does; SSL for ${PANEL_DOMAIN} can then be issued with:"
    warn "  clpctl lets-encrypt:install:certificate --domainName=${PANEL_DOMAIN}"
  fi
fi

# ---------------------------------------------------------------------------
# 13. Health check + summary
# ---------------------------------------------------------------------------
log "Waiting for the panel to come up ..."
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${APP_PORT}/login"; then HEALTH=ok; break; fi
  sleep 2
done
[ "${HEALTH:-}" = "ok" ] || warn "panelavo did not answer on port ${APP_PORT} yet — check 'pm2 logs panelavo' as ${SITE_USER}."

cat <<EOF

============================================================
 panelavo setup complete
============================================================
 Panel address:      ${PANEL_URL}
 Fallback (by IP):   http://${SERVER_IP}:${APP_PORT}
 CloudPanel:         https://127.0.0.1:8443 (blocked publicly; use an SSH tunnel)

 CloudPanel admin:   ${ADMIN_USER}
 Admin password:     ${ADMIN_PASSWORD}
 Site user:          ${SITE_USER}
 Site user password: ${SITE_USER_PASSWORD}

 Log in to panelavo with the CloudPanel admin credentials.
 Manage the process as ${SITE_USER}: pm2 status | pm2 logs panelavo
============================================================
EOF
