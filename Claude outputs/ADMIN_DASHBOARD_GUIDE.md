# PyChatter Admin Dashboard Guide

## Overview

The PyChatter Admin Dashboard is a comprehensive web-based administration interface for managing your PyChatter server. It provides real-time statistics, user/channel management, audit logging, and server control capabilities.

## Features

### 📊 Dashboard
- **Real-time Statistics**: CPU, Memory, Disk usage monitoring
- **User Metrics**: Total users, online count, recent registrations
- **Channel Metrics**: Total channels, messages, DM count
- **Server Health**: Uptime, system resources
- **Auto-refresh**: Updates every 10 seconds

### 👥 User Management
- View all users with detailed information
- Change user roles (member, mod, admin)
- Ban/unban users
- View user activity and login history
- Search and filter users

### 💬 Channel Management
- View all channels with member count
- See message statistics per channel
- Create new channels
- Delete channels and their content
- View channel membership

### 📝 Message Monitoring
- Real-time message feed
- View messages by user/channel
- Message timestamp and metadata
- Search and filter messages
- Direct message tracking

### 📋 Audit Logs
- Complete audit trail of all server events
- Track user actions (login, logout, messages)
- Channel creation/deletion events
- Role changes and administrative actions
- Timestamped and searchable logs

### ⚙️ Server Management
- View service status (server, web, nginx)
- Restart services without SSH
- Real-time service logs
- Monitor system performance
- Check service uptime

## Installation

### Prerequisites
- PyChatter running on your VPS
- Python 3.8+
- Sudo access

### Setup Steps

1. **Copy files to VPS:**
```bash
scp admin_dashboard.py tkiller420@217.216.40.246:/tmp/
scp setup_admin_dashboard.sh tkiller420@217.216.40.246:/tmp/
scp admin_*.html tkiller420@217.216.40.246:/tmp/
```

2. **SSH to VPS and run setup:**
```bash
ssh tkiller420@217.216.40.246
cd /tmp
chmod +x setup_admin_dashboard.sh
bash setup_admin_dashboard.sh
```

3. **Access the dashboard:**
```
http://cyb3rwrld.com:9012
http://217.216.40.246:9012
```

4. **Login with default credentials:**
- Password: `admin`

### ⚠️ IMPORTANT: Change Default Password

After first login, **immediately change the default password**:

```bash
# SSH to VPS
ssh tkiller420@217.216.40.246

# Change admin password
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

## Usage Guide

### Dashboard Page

The main dashboard shows:
- **Server Stats**: CPU, Memory, Disk usage with real-time updates
- **User Stats**: Total users, online count, admins, recent registrations
- **Channel Stats**: Total channels, messages, DMs, messages in last 24h
- **System Health**: Uptime and performance indicators

**Useful for**: Getting a quick overview of server health and activity

### Users Page

Manage all users with a comprehensive table showing:
- Username and email
- User role (member, mod, admin)
- Online status
- Last login time
- Account creation date

**Actions**:
- Click on a user to view full details
- Change user role: Select new role and click "Update"
- Ban user: Click "Ban" button (marks as banned)
- View user activity: See login history and messages

**Tips**:
- Promote trusted users to "mod" to help moderate
- Use ban feature for rule violators (they can't login)
- Check "last login" to identify inactive accounts

### Channels Page

Manage all chat channels:
- Channel name
- Member count
- Total messages
- Creation date

**Actions**:
- Create new channel: Fill form and submit
- Delete channel: Click delete (removes all content)
- View members: See who's in each channel
- View message history: See recent messages

**Tips**:
- Archive high-activity channels as backups before deletion
- Monitor member count to identify popular channels
- Check message volume to detect spam or issues

### Messages Page

View recent messages across all channels:
- Username (who sent it)
- Channel name (where it was sent)
- Message content
- Exact timestamp

**Actions**:
- Search messages by user or channel
- Filter by date range
- View message metadata
- Report spam/inappropriate content

**Tips**:
- Monitor for spam patterns
- Track important announcements
- Check message volume during peak hours

### Audit Logs Page

Complete audit trail of server events:
- Event type (login, logout, message, channel change, etc.)
- Username responsible
- Event details
- Exact timestamp

**Event Types**:
- `user_login`: User logged in
- `user_logout`: User logged out
- `user_register`: New user registered
- `message_sent`: Message posted
- `channel_create`: Channel created
- `channel_delete`: Channel deleted
- `role_change`: User role changed
- `user_ban`: User banned

**Tips**:
- Use for security investigations
- Track administrative changes
- Monitor for suspicious activity
- Export logs for compliance

### Server Page

System administration and monitoring:

**Services**:
- **pychatter-server**: Main chat server
- **pychatter-web**: Web interface bridge
- **nginx**: Reverse proxy

**Status Indicators**:
- 🟢 **Active**: Service running normally
- 🔴 **Inactive**: Service stopped
- ⚠️ **Failed**: Service crashed

**Actions**:
- **Restart**: Stop and restart a service (30 second downtime)
- **View Logs**: See last 100 lines of service output
- **Check Status**: Real-time service status

**Common Tasks**:

Restart chat server after config changes:
```
Click "Restart" for pychatter-server
Wait 30 seconds
```

View server errors:
```
Click "Logs" for the relevant service
Scroll to see recent entries
Look for ERROR or FAIL messages
```

Restart web interface:
```
Click "Restart" for pychatter-web
Users may see a brief disconnect
Reconnects automatically
```

## API Endpoints (for Advanced Users)

The dashboard exposes REST APIs:

```bash
# Get server statistics
curl -H "Cookie: admin_logged_in=..." http://localhost:9012/api/stats/server

# Get user statistics
curl -H "Cookie: admin_logged_in=..." http://localhost:9012/api/stats/users

# Get channel statistics
curl -H "Cookie: admin_logged_in=..." http://localhost:9012/api/stats/channels

# Restart a service
curl -X POST http://localhost:9012/api/service/pychatter-server/restart

# Change user role
curl -X POST http://localhost:9012/api/user/1/role \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'

# Get service logs
curl http://localhost:9012/api/service/pychatter-server/logs
```

## Troubleshooting

### Dashboard won't load

**Check if service is running:**
```bash
sudo systemctl status pychatter-admin
```

**Check logs for errors:**
```bash
sudo journalctl -u pychatter-admin -n 50
```

**Restart the service:**
```bash
sudo systemctl restart pychatter-admin
```

### Can't login

**Verify password file exists:**
```bash
ls -la /opt/pychatter/.admin_pass
```

**Reset to default password:**
```bash
rm /opt/pychatter/.admin_pass
# Then login with default password: "admin"
```

### Nginx connection refused

**Check if Nginx is running:**
```bash
sudo systemctl status nginx
```

**Check Nginx config:**
```bash
sudo nginx -t
sudo systemctl restart nginx
```

### Database errors

**Check database permissions:**
```bash
ls -la /opt/pychatter/server/chat.db
```

**Check PyChatter server:**
```bash
sudo systemctl status pychatter-server
sudo journalctl -u pychatter-server -n 20
```

## Security Recommendations

1. **Change Default Password**: Do this immediately after installation
2. **Use HTTPS**: Access via `https://cyb3rwrld.com:9012` when available
3. **Limit Access**: Consider restricting admin port with firewall rules
4. **Audit Regularly**: Check logs for suspicious activity
5. **Backup Database**: Regularly backup `/opt/pychatter/server/chat.db`
6. **Monitor Access**: Check who accesses the admin dashboard

### Firewall Configuration

To restrict admin dashboard access to specific IPs:

```bash
sudo ufw allow from 192.168.1.100 to any port 9012
sudo ufw deny to any port 9012
```

## Maintenance Tasks

### Daily
- Monitor dashboard stats
- Check for error logs
- Review user activity

### Weekly
- Review audit logs
- Check system performance
- Update user roles as needed

### Monthly
- Backup database
- Clean up audit logs (optional)
- Review and update admin password
- Check service logs for issues

## Performance Tuning

### For Large Deployments (1000+ users)

1. **Increase database connection pool**:
Edit admin_dashboard.py, increase timeout values

2. **Cache statistics**:
Implement Redis caching for stats

3. **Limit log retrieval**:
Reduce audit log query limit in api_service_logs()

4. **Database optimization**:
```bash
# Analyze database efficiency
sqlite3 /opt/pychatter/server/chat.db "ANALYZE;"
```

## Advanced Configuration

### Custom Port

Change admin port in `admin_dashboard.py`:
```python
ADMIN_PORT = 9012  # Change this to desired port
```

Then update systemd service and Nginx config.

### Custom Password Hashing

Implement stronger hashing in `admin_dashboard.py`:
```python
from werkzeug.security import generate_password_hash, check_password_hash
```

### Email Notifications

Add email alerts for critical events:
```python
import smtplib
# Add email integration for important events
```

## Support and Community

For issues or feature requests:
1. Check logs: `sudo journalctl -u pychatter-admin -f`
2. Review audit logs in dashboard
3. Check GitHub issues
4. Post in community forum

## Version History

- **v1.0** (Current)
  - Initial release
  - Dashboard, Users, Channels, Messages, Logs, Server management
  - Real-time statistics
  - Audit logging
  - Service control

## License

Same as PyChatter (MIT)

---

**Last Updated**: September 2026
**For**: PyChatter v1.0
