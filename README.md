# PyChatter

PyChatter is an MVP Discord-style chat platform built with Python and C:
- Python async socket server for multi-user chat
- Python desktop GUI client (Tkinter)
- Modern web UI client (HTML/CSS/JS)
- C native module for fast message hashing and lightweight IDs

## Current Features

- Multi-client real-time text chat
- Channels (`#general` plus dynamic channel creation)
- Join/leave system messages
- Account auth (register/login) with secure password hashing
- SQLite persistence for users, channels, channel history, and DMs
- Role model (`member`, `mod`, `admin`) with admin promotion command
- Online roster updates per channel
- DM messaging and DM history lookup
- Native C acceleration path with Python fallback
- Desktop GUI for sending/reading messages
- Browser web UI with polished layout and button-based actions

## Database Coverage

The SQLite database is at `server/chat.db` and now stores:

- `users`: accounts, password hash/salt, role, online state, last login/seen
- `channels`: channel catalog
- `channel_messages`: persistent channel chat history
- `direct_messages`: persistent DM history
- `user_sessions`: connect/disconnect session timeline and last activity
- `channel_memberships`: per-user channel membership/last seen data
- `audit_events`: auth, channel switches, messages, DMs, role changes, disconnects

## Project Layout

- `server/server.py`: async chat server and real-time routing
- `server/store.py`: SQLite storage and auth logic
- `server/web_bridge.py`: WebSocket bridge and static web UI host
- `client/gui.py`: desktop GUI client
- `web/index.html`: web client markup
- `web/styles.css`: web client styles
- `web/app.js`: web client behavior
- `shared/protocol.py`: shared wire protocol (JSON + newline framing)
- `native/fast_hash.c`: C function for fast FNV-1a hash
- `native/native_bridge.py`: Python bridge to native library
- `scripts/run_server.sh`: run backend server on Linux
- `scripts/run_client.sh`: run desktop client on Linux
- `scripts/run_web.sh`: run web bridge host on Linux
- `scripts/run_server_control.sh`: launch desktop server control panel
- `client/server_control_gui.py`: Tkinter control panel for server/web start-stop-restart and logs
- `deploy/pychatter-server.service`: systemd service for chat server
- `deploy/pychatter-web.service`: systemd service for web bridge/static host
- `deploy/nginx-pychatter.conf`: Nginx reverse proxy config

## Quick Start (Linux)

1. Create environment and install dependencies:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install --upgrade pip
   pip install -r requirements.txt
   chmod +x scripts/run_server.sh scripts/run_web.sh scripts/run_client.sh
   ```

2. Start backend chat server:

   ```bash
   ./scripts/run_server.sh
   ```

3. Start web bridge/static host:

   ```bash
   ./scripts/run_web.sh
   ```

4. Open browser:

   ```
   http://127.0.0.1:9010
   ```

5. Register/login in the auth page.

## Desktop Server Control

Launch the server control panel with:

```bash
bash scripts/run_server_control.sh
```

The launcher prefers the Tkinter desktop app and automatically falls back to a browser-based control panel when `tkinter` is not installed on the VPS.

The control panel can:

- Start, stop, and restart the TCP chat server
- Start local-only or public web hosting modes
- Show live combined logs
- Display the current DB viewer URL and token

There is also a desktop launcher created at:

```text
~/Desktop/PyChatter Server.desktop
```

## Commands In Client

- `/dm <username> <message>`: send direct message
- `/dmlog <username>`: fetch recent DM history with that user
- `/who`: refresh online users in the current channel
- `/promote <username> <member|mod|admin>`: admin-only role changes

## What To Build Next For A Full Discord Alternative

- Media uploads with CDN/object storage
- Push notifications and presence
- Voice channels (Opus/WebRTC) and screen sharing
- End-to-end encryption options (optional mode)
- Moderation and anti-abuse tooling
- Horizontal scaling with gateway nodes + Redis pub/sub
- Mobile client and web client

## Notes

- If the C library does not compile, app still works using Python fallback hash.
- This MVP uses localhost (`127.0.0.1`) by default for development.

## Fedora VPS Deployment

1. Copy your project to VPS:

   ```bash
   scp -r ./PyChatter user@YOUR_VPS_IP:/opt/
   ```

2. Install system packages:

   ```bash
   sudo dnf update -y
   sudo dnf install -y python3 python3-pip python3-virtualenv git nginx
   ```

3. Prepare app environment:

   ```bash
   cd /opt/PyChatter
   python3 -m venv .venv
   source .venv/bin/activate
   pip install --upgrade pip
   pip install -r requirements.txt
   chmod +x scripts/run_server.sh scripts/run_web.sh
   ```

4. Create service user and move app to final path:

   ```bash
   sudo useradd --system --create-home --shell /sbin/nologin pychatter || true
   sudo mkdir -p /opt/pychatter
   sudo rsync -a /opt/PyChatter/ /opt/pychatter/
   sudo chown -R pychatter:pychatter /opt/pychatter
   ```

5. Install systemd services:

   ```bash
   sudo cp deploy/pychatter-server.service /etc/systemd/system/
   sudo cp deploy/pychatter-web.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now pychatter-server
   sudo systemctl enable --now pychatter-web
   ```

6. Configure Nginx reverse proxy:

   ```bash
   sudo cp deploy/nginx-pychatter.conf /etc/nginx/conf.d/pychatter.conf
   sudo setsebool -P httpd_can_network_connect 1
   sudo nginx -t
   sudo systemctl enable --now nginx
   sudo systemctl restart nginx
   ```

7. Open firewall for web traffic:

   ```bash
   sudo firewall-cmd --add-service=http --permanent
   sudo firewall-cmd --add-service=https --permanent
   sudo firewall-cmd --reload
   ```

8. Check service health:

   ```bash
   systemctl status pychatter-server --no-pager
   systemctl status pychatter-web --no-pager
   journalctl -u pychatter-server -f
   journalctl -u pychatter-web -f
   ```

9. Open your VPS IP in browser:

   ```
   http://YOUR_VPS_IP
   ```

Temporary fallback without systemd/Nginx:

If you cannot complete the root-owned setup yet, you can still expose the web client directly:

```bash
cd ~/Desktop/PyChatter
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
firewall-cmd --add-port=9010/tcp --permanent
firewall-cmd --add-port=9011/tcp --permanent
firewall-cmd --reload
bash scripts/run_server.sh
bash scripts/run_web_public.sh
```

Then open:

```
http://YOUR_VPS_IP:9010
```

Read-only DB viewer:

- `scripts/run_web_public.sh` creates a token file at `.db_view_token` on first start.
- Open `http://YOUR_VPS_IP:9010/_db?token=YOUR_TOKEN` to browse tables.
- The viewer is read-only and disabled unless `PYCHATTER_DB_VIEW_TOKEN` is set.

Optional TLS (recommended):

```bash
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```
