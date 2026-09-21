# PyChatter Deployment with cyb3rwrld.com

**VPS IP:** 217.216.40.246  
**Domain:** cyb3rwrld.com  
**OS:** Ubuntu 26.04 LTS  

---

## Prerequisites

✅ **DNS configured:** Your domain `cyb3rwrld.com` must point to `217.216.40.246`

Check this with:
```bash
nslookup cyb3rwrld.com
# Should show: 217.216.40.246
```

If not, update your DNS provider (GoDaddy, Cloudflare, etc.) to point to your VPS IP.

---

## Step 1: Push PyChatter to GitHub (if not done)

**First time setup:**
```bash
cd C:\Users\trist\OneDrive\Desktop\PyChatter
git remote add origin https://github.com/YOUR_USERNAME/pychatter.git
git branch -M main
git push -u origin main
```

**Or if already on GitHub:**
```bash
cd C:\Users\trist\OneDrive\Desktop\PyChatter
git push origin main
```

---

## Step 2: SSH into VPS and Clone

```bash
ssh tkiller420@217.216.40.246
```

On your VPS:
```bash
sudo mkdir -p /opt/pychatter
sudo git clone https://github.com/YOUR_USERNAME/pychatter.git /opt/pychatter
sudo chown -R tkiller420:tkiller420 /opt/pychatter
cd /opt/pychatter
```

---

## Step 3: Download and Run Deployment Script

```bash
# Download the script
curl -o deploy-with-domain.sh https://your-domain.com/deploy-with-domain.sh
# OR if you don't have it hosted, create it from the provided script

chmod +x deploy-with-domain.sh

# Run it with your domain and email
bash deploy-with-domain.sh cyb3rwrld.com your.email@example.com
```

The script will:
- ✅ Install all dependencies
- ✅ Set up Python virtual environment
- ✅ Create systemd services
- ✅ Configure Nginx reverse proxy
- ✅ **Generate free SSL certificate** with Let's Encrypt
- ✅ Set up HTTPS on port 443
- ✅ Auto-redirect HTTP → HTTPS
- ✅ Start all services

---

## Step 4: Access Your Site

Open in browser:
```
https://cyb3rwrld.com
```

You should see the PyChatter login/register page. **With HTTPS!** 🔒

---

## What Gets Set Up

| Component | Port | Access |
|-----------|------|--------|
| Chat Server | 9011 | Localhost only |
| Web Bridge | 9010 | Localhost only |
| Nginx (HTTP) | 80 | Public (redirects to HTTPS) |
| Nginx (HTTPS) | 443 | Public (your domain) |
| SQLite DB | - | `/opt/pychatter/server/chat.db` |

---

## SSL Certificate Management

Your SSL certificate is **free** and valid for **90 days**. Renewal is **automatic**.

```bash
# Check certificate status
sudo certbot certificates

# Manually renew (if needed)
sudo certbot renew

# Force renewal
sudo certbot renew --force-renewal
```

---

## Useful Commands

```bash
# Check service status
sudo systemctl status pychatter-server
sudo systemctl status pychatter-web
sudo systemctl status nginx

# View live logs
sudo journalctl -u pychatter-server -f
sudo journalctl -u pychatter-web -f

# Restart everything
sudo systemctl restart pychatter-server pychatter-web nginx

# Check if domain is working
curl https://cyb3rwrld.com
```

---

## Troubleshooting

**DNS not resolving?**
```bash
# Check DNS
dig cyb3rwrld.com
nslookup cyb3rwrld.com

# Flush DNS cache (if on Linux)
sudo systemd-resolve --flush-caches
```

**SSL certificate not issued?**
```bash
# Check Nginx logs
sudo journalctl -u nginx -n 50

# Try certbot manually
sudo certbot --nginx -d cyb3rwrld.com
```

**Services not starting?**
```bash
sudo journalctl -u pychatter-server -n 50
sudo journalctl -u pychatter-web -n 50
sudo nginx -t  # Test nginx config
```

**Port issues?**
```bash
# Check what's listening on ports
sudo netstat -tlnp | grep :80
sudo netstat -tlnp | grep :443
sudo netstat -tlnp | grep :9010
sudo netstat -tlnp | grep :9011
```

---

## Next Steps (Optional)

- Monitor logs: `sudo journalctl -u pychatter-server -f`
- Backup database: `sudo cp /opt/pychatter/server/chat.db /backup/chat.db`
- Set up cron for daily backups
- Enable Nginx access logs: `sudo tail -f /var/log/nginx/access.log`

---

## Summary

Your PyChatter instance is now:
- ✅ Running on **cyb3rwrld.com**
- ✅ **Fully HTTPS** with free Let's Encrypt SSL
- ✅ Auto-restarting services (systemd)
- ✅ Auto-renewing SSL certificates
- ✅ Reverse proxied through Nginx
- ✅ Production-ready deployment

Ready to chat! 🚀
