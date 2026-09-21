#!/usr/bin/env python3
"""
PyChatter Admin Dashboard
Comprehensive server administration interface with user/channel management,
statistics, and server control.
"""

import sqlite3
import json
import os
import subprocess
import psutil
import time
from datetime import datetime, timedelta
from pathlib import Path
from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from functools import wraps
import hashlib
import secrets

# Configuration
PYCHATTER_HOME = Path("/opt/pychatter")
DB_PATH = PYCHATTER_HOME / "server" / "chat.db"
ADMIN_PORT = 9012
SECRET_KEY = secrets.token_hex(32)

app = Flask(__name__)
app.secret_key = SECRET_KEY

# ============================================================================
# Database Functions
# ============================================================================

def get_db():
    """Get database connection"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def get_user_stats():
    """Get user statistics"""
    try:
        conn = get_db()
        cursor = conn.cursor()

        stats = {}

        # Total users
        cursor.execute("SELECT COUNT(*) FROM users")
        stats['total_users'] = cursor.fetchone()[0]

        # Online users
        cursor.execute("SELECT COUNT(*) FROM users WHERE online = 1")
        stats['online_users'] = cursor.fetchone()[0]

        # Admins
        cursor.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'")
        stats['admins'] = cursor.fetchone()[0]

        # Recent registrations (last 24h)
        cursor.execute("""
            SELECT COUNT(*) FROM users
            WHERE datetime(last_login) > datetime('now', '-1 day')
        """)
        stats['recent_registrations'] = cursor.fetchone()[0]

        conn.close()
        return stats
    except Exception as e:
        return {'error': str(e)}

def get_channel_stats():
    """Get channel statistics"""
    try:
        conn = get_db()
        cursor = conn.cursor()

        stats = {}

        # Total channels
        cursor.execute("SELECT COUNT(*) FROM channels")
        stats['total_channels'] = cursor.fetchone()[0]

        # Total messages
        cursor.execute("SELECT COUNT(*) FROM channel_messages")
        stats['total_messages'] = cursor.fetchone()[0]

        # Total DMs
        cursor.execute("SELECT COUNT(*) FROM direct_messages")
        stats['total_dms'] = cursor.fetchone()[0]

        # Messages in last 24h
        cursor.execute("""
            SELECT COUNT(*) FROM channel_messages
            WHERE datetime(timestamp) > datetime('now', '-1 day')
        """)
        stats['messages_24h'] = cursor.fetchone()[0]

        conn.close()
        return stats
    except Exception as e:
        return {'error': str(e)}

def get_server_stats():
    """Get server system statistics"""
    try:
        stats = {
            'cpu_percent': psutil.cpu_percent(interval=1),
            'memory_percent': psutil.virtual_memory().percent,
            'disk_percent': psutil.disk_usage('/').percent,
            'uptime': get_uptime(),
            'timestamp': datetime.now().isoformat()
        }
        return stats
    except Exception as e:
        return {'error': str(e)}

def get_uptime():
    """Get system uptime"""
    try:
        with open('/proc/uptime', 'r') as f:
            uptime_seconds = int(float(f.readline().split()[0]))
            hours = uptime_seconds // 3600
            minutes = (uptime_seconds % 3600) // 60
            return f"{hours}h {minutes}m"
    except:
        return "N/A"

def get_all_users():
    """Get all users"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT user_id, username, email, role, online,
                   datetime(last_login) as last_login,
                   datetime(created_at) as created_at
            FROM users
            ORDER BY created_at DESC
        """)
        users = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return users
    except Exception as e:
        return {'error': str(e)}

def get_all_channels():
    """Get all channels"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT channel_id, channel_name,
                   (SELECT COUNT(*) FROM channel_memberships WHERE channel_id = channels.channel_id) as member_count,
                   (SELECT COUNT(*) FROM channel_messages WHERE channel_id = channels.channel_id) as message_count,
                   datetime(created_at) as created_at
            FROM channels
            ORDER BY created_at DESC
        """)
        channels = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return channels
    except Exception as e:
        return {'error': str(e)}

def get_recent_messages(limit=50):
    """Get recent messages"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                cm.message_id,
                cm.channel_id,
                c.channel_name,
                u.username,
                cm.message_text,
                datetime(cm.timestamp) as timestamp
            FROM channel_messages cm
            JOIN channels c ON cm.channel_id = c.channel_id
            JOIN users u ON cm.user_id = u.user_id
            ORDER BY cm.timestamp DESC
            LIMIT ?
        """, (limit,))
        messages = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return messages
    except Exception as e:
        return {'error': str(e)}

def get_audit_logs(limit=100):
    """Get audit logs"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                event_type,
                user_id,
                (SELECT username FROM users WHERE user_id = audit_events.user_id) as username,
                details,
                datetime(event_time) as event_time
            FROM audit_events
            ORDER BY event_time DESC
            LIMIT ?
        """, (limit,))
        logs = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return logs
    except Exception as e:
        return {'error': str(e)}

# ============================================================================
# Server Management Functions
# ============================================================================

def get_service_status(service_name):
    """Get systemd service status"""
    try:
        result = subprocess.run(
            ['sudo', 'systemctl', 'is-active', service_name],
            capture_output=True,
            text=True,
            timeout=5
        )
        return result.stdout.strip()
    except:
        return 'unknown'

def restart_service(service_name):
    """Restart a service"""
    try:
        subprocess.run(
            ['sudo', 'systemctl', 'restart', service_name],
            timeout=10
        )
        return True
    except:
        return False

def get_service_logs(service_name, lines=50):
    """Get service logs"""
    try:
        result = subprocess.run(
            ['sudo', 'journalctl', '-u', service_name, '-n', str(lines), '--no-pager'],
            capture_output=True,
            text=True,
            timeout=5
        )
        return result.stdout
    except Exception as e:
        return str(e)

# ============================================================================
# Authentication
# ============================================================================

def hash_password(password):
    """Hash password"""
    return hashlib.sha256(password.encode()).hexdigest()

def check_admin_password(password):
    """Check admin password against saved hash"""
    # For first setup, create a default admin password
    admin_pass_file = PYCHATTER_HOME / ".admin_pass"

    if not admin_pass_file.exists():
        # Create default admin password: "admin" on first run
        default_hash = hash_password("admin")
        admin_pass_file.write_text(default_hash)
        return hash_password(password) == default_hash

    saved_hash = admin_pass_file.read_text().strip()
    return hash_password(password) == saved_hash

def login_required(f):
    """Decorator for login requirement"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'admin_logged_in' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

# ============================================================================
# Routes - Authentication
# ============================================================================

@app.route('/admin/login', methods=['GET', 'POST'])
def login():
    """Admin login"""
    if request.method == 'POST':
        password = request.form.get('password', '')

        if check_admin_password(password):
            session['admin_logged_in'] = True
            session['login_time'] = datetime.now().isoformat()
            return redirect(url_for('dashboard'))
        else:
            return render_template('admin_login.html', error='Invalid password')

    return render_template('admin_login.html')

@app.route('/admin/logout')
def logout():
    """Admin logout"""
    session.clear()
    return redirect(url_for('login'))

# ============================================================================
# Routes - Dashboard
# ============================================================================

@app.route('/admin')
@app.route('/admin/dashboard')
@login_required
def dashboard():
    """Main dashboard"""
    user_stats = get_user_stats()
    channel_stats = get_channel_stats()
    server_stats = get_server_stats()

    return render_template('admin_dashboard.html',
        user_stats=user_stats,
        channel_stats=channel_stats,
        server_stats=server_stats
    )

@app.route('/admin/users')
@login_required
def users():
    """Users management"""
    users_list = get_all_users()
    return render_template('admin_users.html', users=users_list)

@app.route('/admin/channels')
@login_required
def channels():
    """Channels management"""
    channels_list = get_all_channels()
    return render_template('admin_channels.html', channels=channels_list)

@app.route('/admin/messages')
@login_required
def messages():
    """Recent messages"""
    recent = get_recent_messages(100)
    return render_template('admin_messages.html', messages=recent)

@app.route('/admin/logs')
@login_required
def logs():
    """Audit logs"""
    audit_logs = get_audit_logs(200)
    return render_template('admin_logs.html', logs=audit_logs)

@app.route('/admin/server')
@login_required
def server():
    """Server management"""
    services = {
        'pychatter-server': get_service_status('pychatter-server'),
        'pychatter-web': get_service_status('pychatter-web'),
        'nginx': get_service_status('nginx')
    }

    return render_template('admin_server.html', services=services)

# ============================================================================
# API Routes
# ============================================================================

@app.route('/api/stats/server')
@login_required
def api_server_stats():
    """API: Get server stats"""
    return jsonify(get_server_stats())

@app.route('/api/stats/users')
@login_required
def api_user_stats():
    """API: Get user stats"""
    return jsonify(get_user_stats())

@app.route('/api/stats/channels')
@login_required
def api_channel_stats():
    """API: Get channel stats"""
    return jsonify(get_channel_stats())

@app.route('/api/service/<service>/restart', methods=['POST'])
@login_required
def api_restart_service(service):
    """API: Restart service"""
    if service not in ['pychatter-server', 'pychatter-web', 'nginx']:
        return jsonify({'error': 'Invalid service'}), 400

    success = restart_service(service)
    return jsonify({'success': success, 'status': get_service_status(service)})

@app.route('/api/service/<service>/logs')
@login_required
def api_service_logs(service):
    """API: Get service logs"""
    if service not in ['pychatter-server', 'pychatter-web', 'nginx']:
        return jsonify({'error': 'Invalid service'}), 400

    logs = get_service_logs(service, 100)
    return jsonify({'logs': logs})

@app.route('/api/user/<int:user_id>/role', methods=['POST'])
@login_required
def api_change_user_role(user_id):
    """API: Change user role"""
    data = request.json
    new_role = data.get('role')

    if new_role not in ['member', 'mod', 'admin']:
        return jsonify({'error': 'Invalid role'}), 400

    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET role = ? WHERE user_id = ?", (new_role, user_id))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/user/<int:user_id>/ban', methods=['POST'])
@login_required
def api_ban_user(user_id):
    """API: Ban user (set role to banned)"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET role = 'banned' WHERE user_id = ?", (user_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/channel/<int:channel_id>/delete', methods=['POST'])
@login_required
def api_delete_channel(channel_id):
    """API: Delete channel"""
    try:
        conn = get_db()
        cursor = conn.cursor()

        # Delete channel messages
        cursor.execute("DELETE FROM channel_messages WHERE channel_id = ?", (channel_id,))
        # Delete channel memberships
        cursor.execute("DELETE FROM channel_memberships WHERE channel_id = ?", (channel_id,))
        # Delete channel
        cursor.execute("DELETE FROM channels WHERE channel_id = ?", (channel_id,))

        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ============================================================================
# Error Handlers
# ============================================================================

@app.errorhandler(404)
def not_found(error):
    return render_template('404.html'), 404

@app.errorhandler(500)
def server_error(error):
    return render_template('500.html', error=str(error)), 500

# ============================================================================
# Main
# ============================================================================

if __name__ == '__main__':
    print(f"""
╔════════════════════════════════════════════════════════════════╗
║          PyChatter Admin Dashboard                             ║
╚════════════════════════════════════════════════════════════════╝

📊 Starting admin dashboard on port {ADMIN_PORT}...

🔐 DEFAULT LOGIN:
   Password: admin

⚠️  CHANGE THIS PASSWORD IMMEDIATELY!

📍 Access at: http://localhost:{ADMIN_PORT}/admin
              http://cyb3rwrld.com:{ADMIN_PORT}/admin

💾 Database: {DB_PATH}
🏠 Home:     {PYCHATTER_HOME}

Press Ctrl+C to stop.
""")

    app.run(
        host='127.0.0.1',
        port=ADMIN_PORT,
        debug=False,
        use_reloader=False
    )
