# PyChatter Deployment & Admin Dashboard - Complete Files

This directory contains everything needed to deploy PyChatter to your VPS with a full admin dashboard.

---

## 📋 File Manifest

### Deployment & Server Setup
| File | Purpose |
|------|---------|
| `DEPLOY_WITH_DOMAIN.md` | Main deployment guide (PyChatter server + HTTPS) |
| `deploy-with-domain.sh` | Automated deployment script (if you need to re-run) |

### Admin Dashboard - Backend
| File | Purpose |
|------|---------|
| `admin_dashboard.py` | Flask backend application (560+ lines) |
| `setup_admin_dashboard.sh` | Installation script for admin dashboard |
| `ADMIN_DASHBOARD_GUIDE.md` | Complete admin dashboard documentation |
| `DEPLOY_ADMIN_DASHBOARD.md` | Quick deployment guide for admin dashboard |

### Admin Dashboard - Templates (HTML)
| File | Purpose |
|------|---------|
| `admin_base.html` | Base template (navigation, styling, layout) |
| `admin_login.html` | Login page |
| `admin_dashboard.html` | Main dashboard (stats, health, quick actions) |
| `admin_users.html` | User management (roles, bans, activity) |
| `admin_channels.html` | Channel management (create, delete, stats) |
| `admin_messages.html` | Message monitoring (recent messages, search) |
| `admin_logs.html` | Audit logs (complete event trail) |
| `admin_server.html` | Service control (restart, view logs) |

---

## 🚀 Quick Start

### Already Deployed? Update Admin Dashboard Only

If you already have PyChatter running and just want to add the admin dashboard:

```bash
# Copy admin files
scp admin_dashboard.py admin_base.html admin_login.html admin_dashboard.html \
    admin_users.html admin_channels.html admin_messages.html admin_logs.html \
    admin_server.html setup_admin_dashboard.sh \
    tkiller420@217.216.40.246:/tmp/

# SSH and run setup
ssh tkiller420@217.216.40.246
cd /tmp && bash setup_admin_dashboard.sh

# Access at: http://cyb3rwrld.com:9012
# Password: admin (change immediately!)
```

### Fresh Start? Deploy Everything

If you're starting from scratch:

1. Read `DEPLOY_WITH_DOMAIN.md` - Full server deployment
2. Once server is running, deploy admin dashboard (see above)

---

## 📊 What You Get

### PyChatter Server (from DEPLOY_WITH_DOMAIN.md)
✅ Python async socket server on port 9011  
✅ Web interface on port 9010  
✅ Nginx reverse proxy (HTTP/HTTPS)  
✅ Let's Encrypt SSL certificate  
✅ Systemd services (auto-restart)  
✅ Auto-update SSL (90-day renewal)  

### Admin Dashboard (from setup_admin_dashboard.sh)
✅ Real-time system monitoring  
✅ User management (roles, bans)  
✅ Channel management  
✅ Message monitoring  
✅ Complete audit logs  
✅ Service control (restart without SSH)  
✅ REST API endpoints  
✅ Professional dark-theme UI  

---

## 🔐 Security Checklist

- [ ] Changed admin password from "admin" to something strong
- [ ] Firewall restricts access to ports 80/443 only (optional: port 9012)
- [ ] Regular backups of `/opt/pychatter/server/chat.db`
- [ ] VPS OS updated with latest security patches
- [ ] SSH key-based auth enabled (no password login)
- [ ] SSH only on non-standard port (optional but recommended)

---

## 📁 File Locations on VPS

After deployment:

```
/opt/pychatter/
├── .venv/                 # Python virtual environment
├── .admin_pass           # Admin dashboard password hash
├── server/
│   └── chat.db           # SQLite database
├── admin/
│   ├── admin_dashboard.py
│   └── templates/
│       ├── base.html
│       ├── admin_login.html
│       ├── admin_dashboard.html
│       ├── admin_users.html
│       ├── admin_channels.html
│       ├── admin_messages.html
│       ├── admin_logs.html
│       └── admin_server.html
└── [PyChatter source files]

/etc/nginx/conf.d/
├── pychatter.conf        # Main domain config
└── pychatter-admin.conf  # Admin dashboard config

/etc/systemd/system/
├── pychatter-server.service
├── pychatter-web.service
└── pychatter-admin.service
```

---

## 🔧 Useful Commands

```bash
# Check all services
sudo systemctl status pychatter-server pychatter-web nginx pychatter-admin

# View logs
sudo journalctl -u pychatter-server -f
sudo journalctl -u pychatter-admin -f

# Restart services
sudo systemctl restart pychatter-server
sudo systemctl restart pychatter-admin
sudo systemctl restart nginx

# Check listening ports
sudo netstat -tlnp | grep LISTEN

# Access admin dashboard
curl http://localhost:9012/admin/login
```

---

## 📚 Documentation

1. **DEPLOY_WITH_DOMAIN.md** - How to deploy PyChatter server with HTTPS
2. **ADMIN_DASHBOARD_GUIDE.md** - Complete admin dashboard feature documentation
3. **DEPLOY_ADMIN_DASHBOARD.md** - Step-by-step admin dashboard installation

---

## 🐛 Troubleshooting

### Dashboard won't load
```bash
sudo systemctl status pychatter-admin
sudo journalctl -u pychatter-admin -n 50
```

### Forgot admin password
```bash
sudo rm /opt/pychatter/.admin_pass
# Login with: admin (then change it)
```

### Nginx not proxying to admin
```bash
sudo nginx -t
sudo systemctl restart nginx
sudo journalctl -u nginx -n 20
```

### Database errors
```bash
sudo chown -R pychatter:pychatter /opt/pychatter
sudo chmod -R 755 /opt/pychatter/server
```

---

## ✅ Status Check

Your current setup:

| Component | Status | Port | Access |
|-----------|--------|------|--------|
| PyChatter Server | ✅ Deployed | 9011 | Internal |
| Web Interface | ✅ Deployed | 9010 | Internal |
| Nginx (HTTP) | ✅ Deployed | 80 | Public → 443 |
| Nginx (HTTPS) | ⏳ Pending* | 443 | Public |
| Admin Dashboard | 🆕 Ready | 9012 | http://cyb3rwrld.com:9012 |

*SSL cert pending Let's Encrypt rate limit expiration (~1 hour from last attempt)

---

## 🎯 Next Steps

1. **Deploy Admin Dashboard** (4 steps above)
2. **Change Admin Password** (Security critical!)
3. **Wait for SSL Cert** (Check `/root/.claude/...` for SSL retry command)
4. **Update Nginx** (Switch to HTTPS once cert is ready)
5. **Monitor Logs** (Keep an eye on systemd logs)

---

## 📞 Support

If something breaks:

1. Check service status: `sudo systemctl status [service]`
2. View logs: `sudo journalctl -u [service] -f`
3. Restart service: `sudo systemctl restart [service]`
4. Check disk space: `df -h`
5. Check database: `sqlite3 /opt/pychatter/server/chat.db ".tables"`

---

**Everything is ready to go! 🚀**
