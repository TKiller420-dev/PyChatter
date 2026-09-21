#!/bin/bash
# PyChatter Quick Deploy - Run on VPS after cloning repo
# Usage: bash quick-deploy.sh

VPS_IP="217.216.40.246"
PYCHATTER_HOME="/opt/pychatter"
PYCHATTER_USER="pychatter"

echo "🚀 PyChatter Quick Deploy"
echo "=========================="
echo ""
echo "Prerequisites:"
echo "  ✓ Code cloned to $PYCHATTER_HOME"
echo "  ✓ Running on Ubuntu 26.04"
echo "  ✓ User has sudo access"
echo ""

# Step 1: System update
echo "📦 Updating system..."
sudo apt-get update -qq && sudo apt-get upgrade -y -qq
sudo apt-get install -y -qq python3 python3-pip python3-venv build-essential python3-dev git nginx curl wget

# Step 2: Create service user
echo "👤 Creating service user..."
sudo useradd --system --create-home --shell /usr/sbin/nologin $PYCHATTER_USER 2>/dev/null || true

# Step 3: Prepare directory
echo "📁 Setting up app directory..."
sudo chown -R $PYCHATTER_USER:$PYCHATTER_USER $PYCHATTER_HOME
sudo chmod 750 $PYCHATTER_HOME

# Step 4: Python venv
echo "🐍 Setting up Python environment..."
sudo -u $PYCHATTER_USER python3 -m venv "$PYCHATTER_HOME/.venv"
source "$PYCHATTER_HOME/.venv/bin/activate"
pip install --upgrade pip -q
pip install -r "$PYCHATTER_HOME/requirements.txt" -q
deactivate

# Step 5: Systemd services
echo "⚙️  Creating systemd services..."

sudo tee /etc/systemd/system/pychatter-server.service > /dev/null <<'EOF'
[Unit]
Description=PyChatter Chat Server
After=network.target

[Service]
Type=simple
User=pychatter
Group=pychatter
WorkingDirectory=/opt/pychatter
Environment="PATH=/opt/pychatter/.venv/bin"
ExecStart=/opt/pychatter/.venv/bin/python3 /opt/pychatter/server/server.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/pychatter-web.service > /dev/null <<'EOF'
[Unit]
Description=PyChatter Web Bridge
After=network.target pychatter-server.service

[Service]
Type=simple
User=pychatter
Group=pychatter
WorkingDirectory=/opt/pychatter
Environment="PATH=/opt/pychatter/.venv/bin"
ExecStart=/opt/pychatter/.venv/bin/python3 /opt/pychatter/server/web_bridge.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload

# Step 6: Nginx config
echo "🌐 Configuring Nginx..."

sudo rm -f /etc/nginx/sites-enabled/default

sudo tee /etc/nginx/sites-available/pychatter > /dev/null <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $VPS_IP;
    client_max_body_size 100M;
    root /opt/pychatter/web;

    location / {
        proxy_pass http://127.0.0.1:9010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    location /ws {
        proxy_pass http://127.0.0.1:9011;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/pychatter /etc/nginx/sites-enabled/pychatter
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl restart nginx

# Step 7: Start services
echo "🚀 Starting services..."
sudo systemctl enable pychatter-server pychatter-web
sudo systemctl start pychatter-server
sleep 2
sudo systemctl start pychatter-web

# Step 8: Verify
echo ""
echo "✅ Deployment complete!"
echo ""
echo "Access PyChatter at: http://$VPS_IP"
echo ""
echo "Check status:"
echo "  sudo systemctl status pychatter-server"
echo "  sudo systemctl status pychatter-web"
echo ""
echo "View logs:"
echo "  sudo journalctl -u pychatter-server -f"
echo "  sudo journalctl -u pychatter-web -f"
echo ""
