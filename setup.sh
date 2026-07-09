#!/usr/bin/env bash
#
# Server Panel — standalone provisioning script.
#
# Turns a fresh Debian/Ubuntu server into a fully working panel host:
#   1. Detects the OS and installs CloudPanel if it is not present.
#   2. Creates the initial CloudPanel admin user.
#   3. Installs nvm + the latest Node.js for root and a shared PM2 in
#      /usr/local that every user can run.
#   4. Creates a CloudPanel Node.js site owned by system user "clp-pro",
#      deploys this application into it, builds it, and hosts it with PM2
#      (systemd resurrect on boot).
#
# Usage (from the repo root, as root):
#   sudo bash setup.sh
#
# Optional environment overrides:
#   PANEL_DOMAIN=panel.example.com   site domain (default panel.<ip>.nip.io)
#   ADMIN_USER=admin                 CloudPanel admin username
#   ADMIN_PASSWORD=...               CloudPanel admin password (default random)
#   ADMIN_EMAIL=...                  CloudPanel admin e-mail
#   DB_ENGINE=MYSQL_8.4              CloudPanel database engine override
#
# The panel is reachable on http://<server-ip>:10443 (primary) and on the
# site domain through nginx once DNS points at the server.

set -euo pipefail

SITE_USER="clp-pro"
APP_PORT="10443"
NODEJS_SITE_VERSION="22"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_PREFIX="[server-panel-setup]"

log()  { echo -e "\033[1;32m${LOG_PREFIX}\033[0m $*"; }
warn() { echo -e "\033[1;33m${LOG_PREFIX}\033[0m $*" >&2; }
die()  { echo -e "\033[1;31m${LOG_PREFIX}\033[0m $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Run this script as root: sudo bash setup.sh"
[ -f "${SRC_DIR}/package.json" ] || die "Run setup.sh from the application directory (package.json not found)."

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
# 3b. Interactive configuration (domain + first CloudPanel admin)
#     Values already provided through the environment are never asked again.
# ---------------------------------------------------------------------------
DEFAULT_DOMAIN="panel.$(echo "${SERVER_IP}" | tr '.' '-').nip.io"
if [ -t 0 ]; then
  if [ -z "${PANEL_DOMAIN:-}" ]; then
    read -r -p "${LOG_PREFIX} Panel domain [${DEFAULT_DOMAIN}]: " PANEL_DOMAIN_INPUT
    PANEL_DOMAIN="${PANEL_DOMAIN_INPUT:-$DEFAULT_DOMAIN}"
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
PANEL_DOMAIN="${PANEL_DOMAIN:-$DEFAULT_DOMAIN}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@${PANEL_DOMAIN}}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)!Aa1}"
log "Panel domain: ${PANEL_DOMAIN} — CloudPanel admin: ${ADMIN_USER}"

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
# 6. nvm + latest Node.js for root, shared PM2 in /usr/local
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

# Expose node to every user (PM2, clp-pro builds, systemd) via /usr/local/bin.
for bin in node npm npx corepack; do
  ln -sf "${NODE_BIN}/${bin}" "/usr/local/bin/${bin}"
done

if [ ! -x /usr/local/bin/pm2 ]; then
  log "Installing shared PM2 into /usr/local ..."
  "${NODE_BIN}/npm" install -g --prefix /usr/local pm2 >/dev/null
fi
log "PM2 $(/usr/local/bin/pm2 -v | tail -1) available system-wide."

# ---------------------------------------------------------------------------
# 7. CloudPanel site owned by clp-pro
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
cat > /etc/sudoers.d/clp-pro-panel <<EOF
# Server Panel: the Next.js app talks to CloudPanel through clpctl and a
# read-only PHP bridge, both executed via passwordless sudo.
${SITE_USER} ALL=(root) NOPASSWD: /usr/bin/clpctl, ${PHP_BIN}
EOF
chmod 0440 /etc/sudoers.d/clp-pro-panel
visudo -cf /etc/sudoers.d/clp-pro-panel >/dev/null || die "Generated sudoers file is invalid."
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
NEXT_PUBLIC_APP_NAME=Server Panel
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -base64 48 | tr -d '\n')
SESSION_MAX_AGE_SECONDS=3600
CLOUDPANEL_MODE=live
EOF
fi
mkdir -p "${SITE_ROOT}/.data"
chown -R "${SITE_USER}:${SITE_USER}" "${SITE_ROOT}"
chmod 700 "${SITE_ROOT}/.data"
chmod 600 "${SITE_ROOT}/.env.local"

log "Installing dependencies and building (as ${SITE_USER}) ..."
sudo -u "${SITE_USER}" bash -c "cd '${SITE_ROOT}' && export PATH=/usr/local/bin:\$PATH && npx -y pnpm@10.12.1 install --frozen-lockfile && npx -y pnpm@10.12.1 build"

# ---------------------------------------------------------------------------
# 10. Host with PM2 (shared install, clp-pro process, boot persistence)
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
  if ! ufw status 2>/dev/null | grep -q "Status: active"; then
    log "Enabling ufw (SSH, HTTP/HTTPS, and port ${APP_PORT} stay open) ..."
    ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
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
# 12. Health check + summary
# ---------------------------------------------------------------------------
log "Waiting for the panel to come up ..."
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${APP_PORT}/login"; then HEALTH=ok; break; fi
  sleep 2
done
[ "${HEALTH:-}" = "ok" ] || warn "The panel did not answer on port ${APP_PORT} yet — check 'pm2 logs server-panel' as ${SITE_USER}."

cat <<EOF

============================================================
 Server Panel setup complete
============================================================
 Panel (primary):    http://${SERVER_IP}:${APP_PORT}
 Panel (domain):     https://${PANEL_DOMAIN}
 CloudPanel:         https://127.0.0.1:8443 (blocked publicly; use an SSH tunnel)

 CloudPanel admin:   ${ADMIN_USER}
 Admin password:     ${ADMIN_PASSWORD}
 Site user:          ${SITE_USER}
 Site user password: ${SITE_USER_PASSWORD}

 Log in to the panel with the CloudPanel admin credentials.
 Manage the process as ${SITE_USER}: pm2 status | pm2 logs server-panel
============================================================
EOF
