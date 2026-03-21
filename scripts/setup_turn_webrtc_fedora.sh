#!/usr/bin/env bash
set -euo pipefail

# One-shot setup for internet-ready PyChatter WebRTC (TURN + service wiring) on Fedora.
# Usage:
#   sudo bash scripts/setup_turn_webrtc_fedora.sh <domain_or_public_ip> [turn_password]

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0 <domain_or_public_ip> [turn_password]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Missing domain_or_public_ip argument."
  echo "Example: sudo bash scripts/setup_turn_webrtc_fedora.sh 217.216.40.246"
  exit 1
fi

TURN_PASSWORD="${2:-$(openssl rand -hex 16)}"
TURN_SECRET="$(openssl rand -hex 32)"
TURN_REALM="$TARGET"
TURN_EXTERNAL_IP="$TARGET"
TURN_URL="turn:${TARGET}:3478"

echo "[1/10] Installing coturn"
dnf install -y coturn >/dev/null

echo "[2/10] Preparing TURN logging"
mkdir -p /var/log/turnserver
TURN_USER=""
TURN_GROUP=""
if getent passwd coturn >/dev/null 2>&1; then
  TURN_USER="coturn"
elif getent passwd turnserver >/dev/null 2>&1; then
  TURN_USER="turnserver"
fi
if getent group coturn >/dev/null 2>&1; then
  TURN_GROUP="coturn"
elif getent group turnserver >/dev/null 2>&1; then
  TURN_GROUP="turnserver"
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

echo "[4/10] Writing PyChatter TURN env file"
mkdir -p /etc/pychatter
cat >/etc/pychatter/pychatter-web-turn.env <<EOF
PYCHATTER_TURN_URL=${TURN_URL}
PYCHATTER_TURN_USERNAME=pychatter
PYCHATTER_TURN_PASSWORD=${TURN_PASSWORD}
EOF
chmod 600 /etc/pychatter/pychatter-web-turn.env

echo "[5/10] Adding systemd override for pychatter-web"
mkdir -p /etc/systemd/system/pychatter-web.service.d
cat >/etc/systemd/system/pychatter-web.service.d/turn.conf <<'EOF'
[Service]
EnvironmentFile=/etc/pychatter/pychatter-web-turn.env
EOF

echo "[6/10] Opening firewall for TURN"
firewall-cmd --permanent --add-port=3478/tcp >/dev/null
firewall-cmd --permanent --add-port=3478/udp >/dev/null
firewall-cmd --permanent --add-port=49160-49200/udp >/dev/null
firewall-cmd --reload >/dev/null

echo "[7/10] Allowing SELinux network proxying for nginx"
setsebool -P httpd_can_network_connect 1

echo "[8/10] Ensuring service scripts are executable"
[[ -f /opt/pychatter/scripts/run_server.sh ]] && chmod +x /opt/pychatter/scripts/run_server.sh || true
[[ -f /opt/pychatter/scripts/run_web.sh ]] && chmod +x /opt/pychatter/scripts/run_web.sh || true
[[ -f /opt/pychatter/scripts/run_web_public.sh ]] && chmod +x /opt/pychatter/scripts/run_web_public.sh || true

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

echo "Next: make sure your site is HTTPS (required for camera/mic on public origin)."
