#!/bin/bash
# PyChatter VPS Deployment with HTTPS
# Usage: bash deploy-with-domain.sh cyb3rwrld.com your@email.com

set -e

DOMAIN="${1:-}"
EMAIL="${2:-}"
PYCHATTER_HOME="/opt/pychatter"
PYCHATTER_USER="pychatter"

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
    echo "Usage: bash deploy-with-domain.sh cyb3rwrld.com your@email.com"
    exit 1
fi

echo "================================"
echo "PyChatter VPS Deployment"
echo "Domain: $DOMAIN"
echo "================================"
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Step 1: System update
echo -e "${YELLOW}[1/9] Updating system packages...${NC}"
sudo apt-get update -qq
sudo apt-get upgrade -y -qq
sudo apt-get install -y -qq \
    python3 python3-pip python3-venv build-essential python3-dev \
    git nginx curl wget certbot python3-certbot-nginx
echo -e "${GREEN}✓ System updated${NC}"
echo ""

# Step 2: Create service user
echo -e "${YELLOW}[2/9] Creating service user...${NC}"
sudo useradd --system --create-home --shell /usr/sbin/nologin $PYCHATTER_USER 2>/dev/null || true
echo -e "${GREEN}✓ Service user ready${NC}"
echo ""

# Step 3: Prepare app directory
echo -e "${YELLOW}[3/9] Preparing app directory...${NC}"
sudo mkdir -p "$PYCHATTER_HOME"
sudo chown $PYCHATTER_USER:$PYCHATTER_USER "$PYCHATTER_HOME"
sudo chmod 750 "$PYCHATTER_HOME"
echo -e "${GREEN}✓ App directory ready${NC}"
echo ""

# Step 4: Check if repo exists
echo -e "${YELLOW}[4/9] Checking PyChatter repository...${NC}"
if [ ! -d "$PYCHATTER_HOME/.git" ]; then
    echo -e "${RED}Error: PyChatter not found at $PYCHATTER_HOME${NC}"
    echo ""
    echo "Clone it first:"
    echo "  sudo git clone https://github.com/YOUR_USERNAME/pychatter.git $PYCHATTER_HOME"
    echo "  sudo chown -R tkiller420:tkiller420 $PYCHATTER_HOME"
    echo ""
    echo "Then run this script again."
    exit 1
fi
echo -e "${GREEN}✓ PyChatter repo found${NC}"
echo ""

# Step 5: Python environment
echo -e "${YELLOW}[5/9] Setting up Python environment...${NC}"
sudo -u $PYCHATTER_USER python3 -m venv "$PYCHATTER_HOME/.venv"
source "$PYCHATTER_HOME/.venv/bin/activate"
pip install --upgrade pip -q
pip install -r "$PYCHATTER_HOME/requirements.txt" -q
deactivate
echo -e "${GREEN}✓ Python environment ready${NC}"
echo ""

# Step 6: Systemd services
echo -e "${YELLOW}[6/9] Creating systemd services...${NC}"

sudo tee /etc/systemd/system/pychatter-server.service > /dev/null <<EOF
[Unit]
Description=PyChatter Chat Server
After=network.target

[Service]
Type=simple
User=$PYCHATTER_USER
Group=$PYCHATTER_USER
WorkingDirectory=$PYCHATTER_HOME
Environment="PATH=$PYCHATTER_HOME/.venv/bin"
ExecStart=$PYCHATTER_HOME/.venv/bin/python3 $PYCHATTER_HOME/server/server.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pychatter-server

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/pychatter-web.service > /dev/null <<EOF
[Unit]
Description=PyChatter Web Bridge
After=network.target pychatter-server.service

[Service]
Type=simple
User=$PYCHATTER_USER
Group=$PYCHATTER_USER
WorkingDirectory=$PYCHATTER_HOME
Environment="PATH=$PYCHATTER_HOME/.venv/bin"
ExecStart=$PYCHATTER_HOME/.venv/bin/python3 $PYCHATTER_HOME/server/web_bridge.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pychatter-web

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
echo -e "${GREEN}✓ Systemd services created${NC}"
echo ""

# Step 7: Nginx configuration
echo -e "${YELLOW}[7/9] Configuring Nginx for $DOMAIN...${NC}"

sudo rm -f /etc/nginx/sites-enabled/default

sudo tee /etc/nginx/sites-available/pychatter > /dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    # Redirect HTTP to HTTPS
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN www.$DOMAIN;

    # SSL certificates (will be created by certbot)
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    client_max_body_size 100M;
    root $PYCHATTER_HOME/web;

    # Web bridge proxy
    location / {
        proxy_pass http://127.0.0.1:9010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_redirect off;
    }

    # WebSocket endpoint
    location /ws {
        proxy_pass http://127.0.0.1:9011;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    # Chat server proxy
    location /chat {
        proxy_pass http://127.0.0.1:9011;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/pychatter /etc/nginx/sites-enabled/pychatter

# Test nginx
if sudo nginx -t 2>&1 | grep -q "successful"; then
    sudo systemctl enable nginx
    sudo systemctl restart nginx
    echo -e "${GREEN}✓ Nginx configured${NC}"
else
    echo -e "${RED}✗ Nginx configuration failed${NC}"
    sudo nginx -t
    exit 1
fi
echo ""

# Step 8: SSL/HTTPS Setup with Let's Encrypt
echo -e "${YELLOW}[8/9] Setting up SSL certificate for $DOMAIN...${NC}"
echo "This will create a free SSL certificate via Let's Encrypt"
echo ""

sudo certbot certonly --nginx \
    --non-interactive \
    --agree-tos \
    --email $EMAIL \
    --domains $DOMAIN,www.$DOMAIN

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ SSL certificate installed${NC}"
    sudo systemctl restart nginx
    echo -e "${GREEN}✓ Nginx restarted with SSL${NC}"
else
    echo -e "${RED}✗ SSL setup failed${NC}"
    echo "Try manually: sudo certbot --nginx -d $DOMAIN"
    exit 1
fi
echo ""

# Step 9: Start services
echo -e "${YELLOW}[9/9] Starting PyChatter services...${NC}"
sudo systemctl enable pychatter-server pychatter-web
sudo systemctl start pychatter-server
sleep 2
sudo systemctl start pychatter-web
sleep 2

# Verify
if sudo systemctl is-active --quiet pychatter-server; then
    echo -e "${GREEN}✓ pychatter-server running${NC}"
else
    echo -e "${RED}✗ pychatter-server failed${NC}"
    sudo journalctl -u pychatter-server -n 20
fi

if sudo systemctl is-active --quiet pychatter-web; then
    echo -e "${GREEN}✓ pychatter-web running${NC}"
else
    echo -e "${RED}✗ pychatter-web failed${NC}"
    sudo journalctl -u pychatter-web -n 20
fi

echo ""
echo "================================"
echo -e "${GREEN}🎉 Deployment Complete!${NC}"
echo "================================"
echo ""
echo -e "${GREEN}Access PyChatter:${NC}"
echo "  https://$DOMAIN"
echo ""
echo -e "${YELLOW}Useful commands:${NC}"
echo "  Check status:       sudo systemctl status pychatter-server"
echo "  View logs:          sudo journalctl -u pychatter-server -f"
echo "  Restart services:   sudo systemctl restart pychatter-server pychatter-web"
echo "  Renew SSL (auto):   sudo certbot renew (runs automatically)"
echo ""
echo -e "${YELLOW}SSL Certificate:${NC}"
echo "  Valid for: 90 days"
echo "  Auto-renewal: enabled"
echo "  Expires: $(sudo certbot certificates 2>/dev/null | grep 'Expiry Date' || echo 'Check with: sudo certbot certificates')"
echo ""
