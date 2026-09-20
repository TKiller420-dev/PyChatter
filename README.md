# PyChatter

PyChatter is a Discord-inspired chat application built with Python, SQLite, and a vanilla HTML/CSS/JavaScript web client. It includes a real-time TCP chat backend, a WebSocket web bridge, persistent users/messages, direct messages, channel history, moderation tools, role-based permissions, and WebRTC call signaling.

The project is intentionally lightweight: no frontend framework, no external database server, and only one required Python dependency for the browser bridge.

## Highlights

- Real-time channel chat with persistent SQLite history
- Discord-style web interface with channels, DMs, member list, message actions, replies, reactions, pins, bookmarks, and unread state
- Account registration/login with salted password hashing and optional remember-me tokens
- Direct messages with conversation history and unread tracking
- Multi-role permissions with Owner, God, Admin, Satan, Lead Developer, Developer, Mod, and Member roles
- Moderation actions: kick, timeout, delete, pin/unpin, block/unblock
- WebRTC signaling for voice/video calls, with TURN configuration templates for public deployments
- Desktop Tkinter client and server control panel
- Native C fast-hash path with a Python fallback
- Systemd and Nginx deployment templates

## Repository Layout

```text
PyChatter/
├── admin/                 # Browser admin/control surface
├── client/                # Tkinter desktop client and server control GUI
├── deploy/                # systemd, Nginx, and TURN deployment templates
├── native/                # C hash helper and Python bridge
├── scripts/               # Local launchers and TURN setup helpers
├── server/                # Async TCP server, web bridge, SQLite store
├── shared/                # Shared JSON-line protocol helpers
├── tests/                 # Integration smoke test
└── web/                   # Browser client
```

## Architecture

```text
Browser UI
  │
  │  HTTP :9010
  │  WebSocket :9011/ws
  ▼
server/web_bridge.py
  │
  │  JSON-line TCP :8765
  ▼
server/server.py
  │
  ▼
SQLite database at server/chat.db
```

The web bridge serves static files and translates browser WebSocket traffic into the same JSON-line protocol used by the desktop client.

## Quick Start

Requirements:

- Python 3.11+
- Bash-compatible shell
- `pip`

Set up a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
chmod +x scripts/*.sh
```

Start the chat backend:

```bash
./scripts/run_server.sh
```

In another terminal, start the web bridge:

```bash
./scripts/run_web.sh
```

Open:

```text
http://127.0.0.1:9010
```

The first registered account becomes `Owner`. Later accounts start as `Member`.

## Configuration

Default local ports:

| Component | Environment variables | Default |
| --- | --- | --- |
| TCP chat server | `PYCHATTER_HOST`, `PYCHATTER_PORT` | `127.0.0.1:8765` |
| Web UI host | `PYCHATTER_WEB_HOST`, `PYCHATTER_WEB_PORT` | `127.0.0.1:9010` |
| WebSocket bridge | `PYCHATTER_WS_HOST`, `PYCHATTER_WS_PORT` | `127.0.0.1:9011` |
| Backend target for web bridge | `PYCHATTER_BACKEND_HOST`, `PYCHATTER_BACKEND_PORT` | `127.0.0.1:8765` |

Optional WebRTC/TURN variables:

```bash
PYCHATTER_TURN_URL=turn:your-domain.com:3478
PYCHATTER_TURN_USERNAME=pychatter
PYCHATTER_TURN_PASSWORD=change-me
```

Or provide a full ICE server list:

```bash
PYCHATTER_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:your-domain.com:3478","username":"pychatter","credential":"change-me"}]'
```

## Roles And Permissions

PyChatter supports multiple roles per user. Roles are stored in the existing `users.role` field as a normalized list and enforced on the server.

| Role | Intended use |
| --- | --- |
| Owner | Full control over the server and roles |
| God | Full control, equivalent high-trust operator |
| Admin | Manage most roles and moderation actions |
| Satan | Moderation powers plus a special message treatment |
| Lead Developer | Manage lower technical/moderation roles |
| Developer | Message management powers |
| Mod | Kick, timeout, delete, pin/unpin |
| Member | Standard chat access |

## Testing

Run syntax checks:

```bash
python3 -m py_compile server/store.py server/server.py server/web_bridge.py server/admin_server.py
node --check web/app.js
```

Run the integration smoke test while the TCP server is running:

```bash
python3 tests/integration_smoke.py
```

The smoke test covers registration, login, channel messages, DMs, and username changes.

## Deployment

Systemd templates are provided in `deploy/`:

- `deploy/pychatter-server.service`
- `deploy/pychatter-web.service`
- `deploy/nginx-pychatter.conf`
- `deploy/turnserver.conf`

Typical Linux deployment:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin pychatter || true
sudo mkdir -p /opt/pychatter
sudo rsync -a ./ /opt/pychatter/
sudo chown -R pychatter:pychatter /opt/pychatter

sudo cp deploy/pychatter-server.service /etc/systemd/system/
sudo cp deploy/pychatter-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pychatter-server pychatter-web
```

For public web access, place Nginx in front of `127.0.0.1:9010` and proxy `/ws` to `127.0.0.1:9011/ws`. Use HTTPS for browser camera/microphone access outside localhost.

TURN setup helpers:

```bash
sudo bash scripts/setup_turn_webrtc_fedora.sh your-domain.com
sudo bash scripts/setup_turn_webrtc_ubuntu.sh your-domain.com
```

## Security Notes

- `server/chat.db`, `.env` files, and `.db_view_token` are intentionally ignored.
- The database viewer is read-only and requires `PYCHATTER_DB_VIEW_TOKEN`.
- Do not commit real TURN credentials, tokens, production databases, or private service files.
- For public deployments, use HTTPS, a firewall, and a real TURN secret.

## Development Notes

- The web client is framework-free. Keep UI changes in `web/index.html`, `web/styles.css`, and `web/app.js`.
- Client features should have matching server packets/handlers when they depend on persistent or authoritative state.
- Preserve the JSON-line protocol in `shared/protocol.py` for compatibility with the desktop client.
- The native hash helper is optional; the Python fallback keeps the app running if the C library is unavailable.

## Contributing

Issues and pull requests are welcome. Please read `CONTRIBUTING.md` before opening a larger change.

## License

MIT. See `LICENSE`.
