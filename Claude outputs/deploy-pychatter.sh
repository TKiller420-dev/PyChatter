#!/bin/bash
# PyChatter VPS Deployment Script
# Ubuntu 26.04 LTS
# Run as: bash deploy-pychatter.sh

set -e

echo "================================"
echo "PyChatter VPS Deployment Script"
echo "================================"
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PYCHATTER_HOME="/opt/pychatter"
PYCHATTER_USER="pychatter"
PYCHATTER_GROUP="pychatter"
VPS_IP="${1:-}"

if [ -z "$VPS_IP" ]; then
    echo -e "${RED}Error: Please provide VPS IP as argument${NC}"
    echo "Usage: bash deploy-pychatter.sh YOUR_VPS_IP"
    echo ""
    echo "Example: bash deploy-pychatter.sh 192.0.2.1"
    exit 1
fi

echo -e "${YELLOW}Deploying PyChatter to $VPS_IP${NC}"
echo ""

# Step 1: Update system
echo -e "${YELLOW}[1/8] Updating system packages...${NC}"
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    python3-dev \
    git \
    nginx \
    curl \
    wget
echo -e "${GREEN}✓ System packages installed${NC}"
echo ""

# Step 2: Create service user
echo -e "${YELLOW}[2/8] Creating pychatter service user...${NC}"
sudo useradd --system --create-home --shell /usr/sbin/nologin $PYCHATTER_USER 2>/dev/null || echo "User $PYCHATTER_USER already exists"
echo -e "${GREEN}✓ Service user ready${NC}"
echo ""

# Step 3: Prepare app directory
echo -e "${YELLOW}[3/8] Preparing app directory at $PYCHATTER_HOME...${NC}"
if [ ! -d "$PYCHATTER_HOME" ]; then
    sudo mkdir -p "$PYCHATTER_HOME"
fi
sudo chown $PYCHATTER_USER:$PYCHATTER_GROUP "$PYCHATTER_HOME"
sudo chmod 750 "$PYCHATTER_HOME"
echo -e "${GREEN}✓ App directory ready${NC}"
echo ""

# Step 4: Clone or verify PyChatter repo
echo -e "${YELLOW}[4/8] Checking PyChatter repository...${NC}"
if [ ! -d "$PYCHATTER_HOME/.git" ]; then
    echo "Note: PyChatter repo not found at $PYCHATTER_HOME"
    echo "You need to copy your PyChatter code to the VPS."
    echo ""
    echo -e "${YELLOW}Options:${NC}"
    echo "1. Push to GitHub and run:"
    echo "   sudo git clone https://github.com/YOUR_USER/pychatter.git $PYCHATTER_HOME"
    echo ""
    echo "2. Or copy from your local machine:"
    echo "   scp -r PyChatter/* tkiller420@$VPS_IP:$PYCHATTER_HOME/"
    echo ""
    echo "After copying, run this script again."
    exit 1
else
    echo -e "${GREEN}✓ PyChatter repo found${NC}"
fi
echo ""

# Step 5: Set up Python virtual environment and dependencies
echo -e "${YELLOW}[5/8] Setting up Python environment...${NC}"
sudo -u $PYCHATTER_USER python3 -m venv "$PYCHATTER_HOME/.venv"
source "$PYCHATTER_HOME/.venv/bin/activate"
pip install --upgrade pip
pip install -r "$PYCHATTER_HOME/requirements.txt"
deactivate
echo -e "${GREEN}✓ Python environment ready${NC}"
echo ""

# Step 6: Create systemd services
echo -e "${YELLOW}[6/8] Installing systemd services...${NC}"

# Chat server service
sudo tee /etc/systemd/system/pychatter-server.service > /dev/null <<EOF
[Unit]
Description=PyChatter Chat Server
After=network.target
Wants=pychatter-web.service

[Service]
Type=simple
User=$PYCHATTER_USER
Group=$PYCHATTER_GROUP
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

# Web bridge service
sudo tee /etc/systemd/system/pychatter-web.service > /dev/null <<EOF
[Unit]
Description=PyChatter Web Bridge
After=network.target pychatter-server.service

[Service]
Type=simple
User=$PYCHATTER_USER
Group=$PYCHATTER_GROUP
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

# Step 7: Configure Nginx reverse proxy
echo -e "${YELLOW}[7/8] Configuring Nginx reverse proxy...${NC}"

# Disable default nginx config
sudo rm -f /etc/nginx/sites-enabled/default

# Create PyChatter nginx config
sudo tee /etc/nginx/sites-available/pychatter > /dev/null <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name $VPS_IP;

    # Increase body size for uploads
    client_max_body_size 100M;

    # Root for static files
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

    # Chat server proxy (fallback)
    location /chat {
        proxy_pass http://127.0.0.1:9011;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF

# Enable the config
sudo ln -sf /etc/nginx/sites-available/pychatter /etc/nginx/sites-enabled/pychatter

# Test nginx config
if sudo nginx -t 2>&1 | grep -q "successful"; then
    sudo systemctl enable nginx
    sudo systemctl restart nginx
    echo -e "${GREEN}✓ Nginx configured and running${NC}"
else
    echo -e "${RED}✗ Nginx config test failed${NC}"
    sudo nginx -t
    exit 1
fi
echo ""

# Step 8: Start PyChatter services
echo -e "${YELLOW}[8/8] Starting PyChatter services...${NC}"
sudo systemctl enable pychatter-server pychatter-web
sudo systemctl start pychatter-server
sleep 2
sudo systemctl start pychatter-web
sleep 2

# Check service status
if sudo systemctl is-active --quiet pychatter-server; then
    echo -e "${GREEN}✓ pychatter-server running${NC}"
else
    echo -e "${RED}✗ pychatter-server failed to start${NC}"
    sudo journalctl -u pychatter-server -n 20
fi

if sudo systemctl is-active --quiet pychatter-web; then
    echo -e "${GREEN}✓ pychatter-web running${NC}"
else
    echo -e "${RED}✗ pychatter-web failed to start${NC}"
    sudo journalctl -u pychatter-web -n 20
fi

echo ""
echo "================================"
echo -e "${GREEN}PyChatter Deployment Complete!${NC}"
echo "================================"
echo ""
echo -e "${GREEN}Access PyChatter at:${NC}"
echo "  http://$VPS_IP"
echo ""
echo -e "${YELLOW}Useful commands:${NC}"
echo "  Check server status:      sudo systemctl status pychatter-server"
echo "  Check web status:         sudo systemctl status pychatter-web"
echo "  View server logs:         sudo journalctl -u pychatter-server -f"
echo "  View web logs:            sudo journalctl -u pychatter-web -f"
echo "  Restart services:         sudo systemctl restart pychatter-server pychatter-web"
echo "  Stop services:            sudo systemctl stop pychatter-server pychatter-web"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Copy your PyChatter code to the VPS (if not already done)"
echo "2. Run this script: bash deploy-pychatter.sh $VPS_IP"
echo "3. Open http://$VPS_IP in your browser"
echo "4. Register/login and start chatting!"
echo ""
