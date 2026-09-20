#!/usr/bin/env bash
set -euo pipefail

# One-shot setup for internet-ready PyChatter WebRTC (TURN + service wiring)
# on Ubuntu/Debian. Adapted from setup_turn_webrtc_fedora.sh (apt instead of
# dnf, no SELinux step, and the Debian-specific coturn "enabled" flag that
# Fedora's package doesn't need).
#
# Usage:
#   sudo bash scripts/setup_turn_webrtc_ubuntu.sh <domain_or_public_ip> [turn_password]

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0 <domain_or_public_ip> [turn_password]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Missing domain_or_public_ip argument."
  echo "Example: sudo bash scripts/setup_turn_webrtc_ubuntu.sh 217.216.40.246"
  exit 1
fi

TURN_PASSWORD="${2:-$(openssl rand -hex 16)}"
TURN_SECRET="$(openssl rand -hex 32)"
TURN_REALM="$TARGET"
TURN_EXTERNAL_IP="$TARGET"
TURN_URL="turn:${TARGET}:3478"

echo "[1/10] Installing coturn"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y coturn >/dev/null

echo "[2/10] Preparing TURN logging"
mkdir -p /var/log/turnserver
TURN_USER=""
TURN_GROUP=""
if getent passwd turnserver >/dev/null 2>&1; then
  TURN_USER="turnserver"
elif getent passwd coturn >/dev/null 2>&1; then
  TURN_USER="coturn"
fi
if getent group turnserver >/dev/null 2>&1; then
  TURN_GROUP="turnserver"
elif getent group coturn >/dev/null 2>&1; then
  TURN_GROUP="coturn"
fi
if [[ -n "$TURN_USER" && -n "$TURN_GROUP" ]]; then
  chown "$TURN_USER:$TURN_GROUP" /var/log/turnserver
else
  echo "Warning: could not determine TURN service user/group; leaving /var/log/turnserver ownership unchanged"
fi

echo "[3/10] Installing turnserver config"
cp "$ROOT_DIR/deploy/turnserver.conf" /etc/turnserver.conf
sed -i "s|^static-auth-secret=.*|static-auth-secret=${TURN_SECRET}|" /etc/turnserver.conf
sed -i "s|^realm=.*|realm=${TURN_REALM}|" /etc/turnserver.conf
sed -i "s|^external-ip=.*|external-ip=${TURN_EXTERNAL_IP}|" /etc/turnserver.conf

echo "[4/10] Enabling the coturn service (Debian ships it disabled by default)"
if [[ -f /etc/default/coturn ]]; then
  if grep -q "^TURNSERVER_ENABLED=" /etc/default/coturn; then
    sed -i "s|^TURNSERVER_ENABLED=.*|TURNSERVER_ENABLED=1|" /etc/default/coturn
  else
    echo "TURNSERVER_ENABLED=1" >> /etc/default/coturn
  fi
else
  echo "TURNSERVER_ENABLED=1" > /etc/default/coturn
fi

echo "[5/10] Writing PyChatter TURN env file"
mkdir -p /etc/pychatter
cat >/etc/pychatter/pychatter-web-turn.env <<EOF
PYCHATTER_TURN_URL=${TURN_URL}
PYCHATTER_TURN_USERNAME=pychatter
PYCHATTER_TURN_PASSWORD=${TURN_PASSWORD}
EOF
chmod 600 /etc/pychatter/pychatter-web-turn.env
chown root:pychatter /etc/pychatter/pychatter-web-turn.env 2>/dev/null || true

echo "[6/10] Adding systemd override for pychatter-web"
mkdir -p /etc/systemd/system/pychatter-web.service.d
cat >/etc/systemd/system/pychatter-web.service.d/turn.conf <<'EOF'
[Service]
EnvironmentFile=/etc/pychatter/pychatter-web-turn.env
EOF

echo "[7/10] Opening firewall for TURN (if ufw is present)"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 3478/tcp >/dev/null || true
  ufw allow 3478/udp >/dev/null || true
  ufw allow 49160:49200/udp >/dev/null || true
else
  echo "ufw not found - skipping (open TCP/UDP 3478 and UDP 49160-49200 manually if you use another firewall)"
fi

echo "[8/10] Ensuring service scripts are executable"
[[ -f /opt/pychatter/scripts/run_server.sh ]] && chmod +x /opt/pychatter/scripts/run_server.sh || true
[[ -f /opt/pychatter/scripts/run_web.sh ]] && chmod +x /opt/pychatter/scripts/run_web.sh || true
[[ -f /opt/pychatter/scripts/run_admin.sh ]] && chmod +x /opt/pychatter/scripts/run_admin.sh || true

echo "[9/10] Restarting services"
systemctl daemon-reload
systemctl enable --now coturn
systemctl restart pychatter-server
systemctl restart coturn
systemctl restart pychatter-web

if systemctl is-enabled nginx >/dev/null 2>&1; then
  systemctl reload nginx || true
fi

echo "[10/10] Status checks"
systemctl --no-pager --full status coturn | sed -n '1,12p'
systemctl --no-pager --full status pychatter-server | sed -n '1,12p'
systemctl --no-pager --full status pychatter-web | sed -n '1,12p'

echo
echo "Setup complete."
echo "TURN URL: ${TURN_URL}"
echo "TURN username: pychatter"
echo "TURN password: ${TURN_PASSWORD}"
echo "TURN shared secret (for turnserver): ${TURN_SECRET}"
echo
echo "Next: make sure your site is HTTPS (required for camera/mic on a public origin)."
