#!/bin/bash
# Setup PyChatter Admin Dashboard

set -e

echo "🚀 Setting up PyChatter Admin Dashboard..."
echo ""

PYCHATTER_HOME="/opt/pychatter"
ADMIN_DIR="$PYCHATTER_HOME/admin"

# Create admin directory
sudo mkdir -p "$ADMIN_DIR/templates"
sudo mkdir -p "$ADMIN_DIR/static/css"
sudo mkdir -p "$ADMIN_DIR/static/js"

# Copy admin files
echo "📁 Copying admin files..."
sudo cp admin_dashboard.py "$ADMIN_DIR/"
sudo cp admin_login.html "$ADMIN_DIR/templates/"
sudo cp admin_dashboard.html "$ADMIN_DIR/templates/"
sudo cp admin_users.html "$ADMIN_DIR/templates/"
sudo cp admin_channels.html "$ADMIN_DIR/templates/"
sudo cp admin_messages.html "$ADMIN_DIR/templates/"
sudo cp admin_logs.html "$ADMIN_DIR/templates/"
sudo cp admin_server.html "$ADMIN_DIR/templates/"
sudo cp admin_base.html "$ADMIN_DIR/templates/base.html"

# Install Flask dependency
echo "📦 Installing Flask..."
source "$PYCHATTER_HOME/.venv/bin/activate"
pip install flask psutil -q
deactivate

# Create systemd service
echo "⚙️  Creating systemd service..."
sudo tee /etc/systemd/system/pychatter-admin.service > /dev/null <<'EOF'
[Unit]
Description=PyChatter Admin Dashboard
After=network.target pychatter-server.service

[Service]
Type=simple
User=pychatter
Group=pychatter
WorkingDirectory=/opt/pychatter
Environment="PATH=/opt/pychatter/.venv/bin"
ExecStart=/opt/pychatter/.venv/bin/python3 /opt/pychatter/admin/admin_dashboard.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pychatter-admin

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload

# Fix permissions
echo "🔐 Setting permissions..."
sudo chown -R pychatter:pychatter "$ADMIN_DIR"
sudo chmod 750 "$ADMIN_DIR"
sudo chmod 640 "$ADMIN_DIR/admin_dashboard.py"

# Create Nginx config for admin
echo "🌐 Configuring Nginx..."
sudo tee /etc/nginx/conf.d/pychatter-admin.conf > /dev/null <<'EOF'
upstream pychatter_admin {
    server 127.0.0.1:9012;
}

server {
    listen 9012;
    server_name _;

    location / {
        proxy_pass http://pychatter_admin;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF

sudo nginx -t
sudo systemctl restart nginx

# Start admin dashboard
echo "🚀 Starting admin dashboard..."
sudo systemctl enable pychatter-admin
sudo systemctl start pychatter-admin

sleep 2

if sudo systemctl is-active --quiet pychatter-admin; then
    echo ""
    echo "✅ Admin Dashboard Installed Successfully!"
    echo ""
    echo "📍 Access at:"
    echo "   http://cyb3rwrld.com:9012"
    echo "   http://217.216.40.246:9012"
    echo ""
    echo "🔐 Default Login:"
    echo "   Password: admin"
    echo ""
    echo "⚠️  CHANGE PASSWORD IMMEDIATELY!"
    echo ""
    echo "📋 Check status:"
    echo "   sudo systemctl status pychatter-admin"
    echo ""
    echo "📜 View logs:"
    echo "   sudo journalctl -u pychatter-admin -f"
else
    echo "❌ Failed to start admin dashboard"
    sudo journalctl -u pychatter-admin -n 20
    exit 1
fi
