# Deploy PyChatter Admin Dashboard to VPS

## Quick Summary

The admin dashboard provides a complete web-based administration interface for your PyChatter server with:
- 📊 Real-time system monitoring (CPU, memory, disk)
- 👥 User management (roles, bans, activity)
- 💬 Channel management (create, delete, view stats)
- 📝 Message monitoring and search
- 📋 Complete audit logging
- ⚙️ Service control (restart services, view logs)

**Access:** `http://cyb3rwrld.com:9012`  
**Default Password:** `admin` (⚠️ Change immediately!)

---

## Files Included

### Backend & Scripts
- `admin_dashboard.py` - Flask application with all API endpoints
- `setup_admin_dashboard.sh` - Automated installation script

### Templates (Jinja2 HTML)
- `admin_base.html` - Base template with styling and navigation
- `admin_login.html` - Login page
- `admin_dashboard.html` - Main dashboard with stats
- `admin_users.html` - User management page
- `admin_channels.html` - Channel management page
- `admin_messages.html` - Message monitoring page
- `admin_logs.html` - Audit logs page
- `admin_server.html` - Server control page

### Documentation
- `ADMIN_DASHBOARD_GUIDE.md` - Complete feature documentation
- `DEPLOY_ADMIN_DASHBOARD.md` - This file

---

## Step 1: Copy Files to VPS

From your local machine:

```bash
# Copy all files to VPS
scp admin_dashboard.py \
    admin_base.html \
    admin_login.html \
    admin_dashboard.html \
    admin_users.html \
    admin_channels.html \
    admin_messages.html \
    admin_logs.html \
    admin_server.html \
    setup_admin_dashboard.sh \
    tkiller420@217.216.40.246:/tmp/
```

---

## Step 2: Run Installation Script

```bash
# SSH to VPS
ssh tkiller420@217.216.40.246

# Go to temp directory
cd /tmp

# Make script executable
chmod +x setup_admin_dashboard.sh

# Run the installation
bash setup_admin_dashboard.sh
```

The script will:
- ✅ Create admin directory structure at `/opt/pychatter/admin/`
- ✅ Copy all files to correct locations
- ✅ Install Flask and psutil dependencies
- ✅ Create systemd service for admin dashboard
- ✅ Configure Nginx upstream on port 9012
- ✅ Start the admin dashboard service

---

## Step 3: Verify Installation

```bash
# Check if service is running
sudo systemctl status pychatter-admin

# Check logs
sudo journalctl -u pychatter-admin -n 20

# Check if Nginx is handling port 9012
curl http://127.0.0.1:9012
```

---

## Step 4: Access Dashboard

Open in your browser:

```
http://cyb3rwrld.com:9012
```

Login with:
- **Password:** `admin`

---

## Step 5: Change Default Password (IMPORTANT!)

### Via Command Line:

```bash
ssh tkiller420@217.216.40.246

# Run this command and enter your new password
python3 << 'EOF'
import hashlib
import getpass

password = getpass.getpass("Enter new admin password: ")
password_hash = hashlib.sha256(password.encode()).hexdigest()

with open('/opt/pychatter/.admin_pass', 'w') as f:
    f.write(password_hash)

print("✅ Password changed successfully!")
EOF
```

### Via Dashboard (Not Yet Implemented):

You can add a settings page to the dashboard for password changes. For now, use the command line method above.

---

## Troubleshooting

### Dashboard won't load

```bash
# Check service status
sudo systemctl status pychatter-admin

# Restart the service
sudo systemctl restart pychatter-admin

# Check logs for errors
sudo journalctl -u pychatter-admin -f
```

### Can't login (forgot password)

```bash
# Reset to default password "admin"
sudo rm /opt/pychatter/.admin_pass

# Then login with: admin
```

### Nginx connection refused

```bash
# Check Nginx config
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx

# Check Nginx logs
sudo journalctl -u nginx -n 50
```

### Flask/psutil not installed

```bash
# SSH to VPS
ssh tkiller420@217.216.40.246

# Activate venv and install
source /opt/pychatter/.venv/bin/activate
pip install flask psutil
```

---

## Admin Features Overview

### Dashboard
- Real-time CPU, memory, disk usage
- Total users, online users, admins
- Total channels, messages, DMs
- System health indicators
- Quick action buttons

### Users Page
- View all users with details
- Change user roles (member → mod → admin)
- Ban users (prevents login)
- See last login and account creation dates

### Channels Page
- View all channels with member/message counts
- Create new channels
- Delete channels (with warning)
- View member lists and stats

### Messages Page
- Monitor recent messages in real-time
- View message timestamps and metadata
- See which users are posting
- Track message volume

### Audit Logs Page
- Complete event trail (logins, logouts, messages)
- User registrations and role changes
- Channel creation/deletion events
- User bans and administrative actions
- Searchable and timestamped

### Server Page
- View pychatter-server status
- View pychatter-web status
- View nginx status
- Restart any service without SSH
- View live service logs
- 30-second restarts with auto-reconnect

---

## API Endpoints (Advanced)

For programmatic access:

```bash
# Get server stats
curl -H "Cookie: admin_logged_in=true" \
  http://localhost:9012/api/stats/server

# Get user stats
curl -H "Cookie: admin_logged_in=true" \
  http://localhost:9012/api/stats/users

# Get channel stats
curl -H "Cookie: admin_logged_in=true" \
  http://localhost:9012/api/stats/channels

# Restart a service
curl -X POST http://localhost:9012/api/service/pychatter-server/restart

# Get service logs
curl http://localhost:9012/api/service/pychatter-server/logs

# Change user role
curl -X POST http://localhost:9012/api/user/1/role \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'

# Ban a user
curl -X POST http://localhost:9012/api/user/1/ban
```

---

## Useful Commands

```bash
# Check admin dashboard status
sudo systemctl status pychatter-admin

# Restart admin dashboard
sudo systemctl restart pychatter-admin

# View admin dashboard logs
sudo journalctl -u pychatter-admin -f

# Check what's listening on port 9012
sudo netstat -tlnp | grep :9012

# Check if all services are running
sudo systemctl status pychatter-server pychatter-web nginx pychatter-admin

# View current password hash
cat /opt/pychatter/.admin_pass
```

---

## Security Notes

1. **Change the default password immediately** after first login
2. **Use strong passwords** (mix of uppercase, lowercase, numbers, special chars)
3. **Restrict access to admin port** with firewall rules (optional):
   ```bash
   sudo ufw allow from 192.168.1.100 to any port 9012
   sudo ufw deny to any port 9012
   ```
4. **Monitor admin dashboard access** via logs
5. **Regular backups** of `/opt/pychatter/server/chat.db`
6. **Keep your VPS updated** with security patches

---

## Next Steps

1. ✅ Copy files to VPS
2. ✅ Run setup script
3. ✅ Change default password
4. ✅ Access at `http://cyb3rwrld.com:9012`
5. (Optional) Add HTTPS for admin panel (requires Let's Encrypt cert)
6. (Optional) Restrict firewall access to admin port

---

## Features Breakdown

| Feature | Status | Details |
|---------|--------|---------|
| Real-time Stats | ✅ Ready | CPU, memory, disk, uptime, users, channels |
| User Management | ✅ Ready | View, change roles, ban users |
| Channel Management | ✅ Ready | Create, delete, view stats |
| Message Monitoring | ✅ Ready | View recent messages, search |
| Audit Logging | ✅ Ready | Complete event trail |
| Service Control | ✅ Ready | Restart services, view logs |
| Authentication | ✅ Ready | Password-protected login |
| Responsive Design | ✅ Ready | Works on desktop and mobile |
| REST API | ✅ Ready | For programmatic access |
| Settings Page | 🔄 Future | Password change UI |
| Message Search | 🔄 Future | Advanced search filters |
| Export Logs | 🔄 Future | Export audit logs to CSV |

---

## Support

For issues, check:
1. Service logs: `sudo journalctl -u pychatter-admin -f`
2. Nginx logs: `sudo journalctl -u nginx -n 50`
3. Database: `ls -la /opt/pychatter/server/chat.db`
4. Permissions: `ls -la /opt/pychatter/admin/`

---

**Ready to deploy!** 🚀
