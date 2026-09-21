# PyChatter VPS Deployment - Step by Step

**VPS IP:** `217.216.40.246`  
**OS:** Ubuntu 26.04 LTS  
**User:** `tkiller420`

---

## Step 1: Push PyChatter to GitHub

### Option A: If You Have a GitHub Repo Already
```bash
# On your local machine, in your PyChatter folder
cd C:\Users\trist\OneDrive\Desktop\PyChatter
git remote -v  # Check if origin is set
git push origin main  # Push latest code
```

### Option B: Create a New GitHub Repo
1. Go to https://github.com/new
2. Create repo: `pychatter` (or any name)
3. **DO NOT** initialize with README (we have one)
4. After creation, copy the repo URL

On your local machine (PowerShell):
```bash
cd C:\Users\trist\OneDrive\Desktop\PyChatter
git remote add origin https://github.com/YOUR_USERNAME/pychatter.git
git branch -M main
git push -u origin main
```

---

## Step 2: SSH Into Your VPS

```bash
ssh tkiller420@217.216.40.246
```

---

## Step 3: Clone PyChatter and Run Deployment

**On your VPS**, run:

```bash
# Create app directory
sudo mkdir -p /opt/pychatter

# Clone the repo
sudo git clone https://github.com/YOUR_USERNAME/pychatter.git /opt/pychatter

# Fix permissions
sudo chown -R tkiller420:tkiller420 /opt/pychatter

# Go to the directory
cd /opt/pychatter

# Download the deployment script
curl -o deploy-pychatter.sh https://raw.githubusercontent.com/YOUR_USERNAME/pychatter/main/scripts/deploy-pychatter.sh

# OR if you don't have it in the repo, create it manually:
# (Paste the deploy-pychatter.sh script contents)

# Make it executable
chmod +x deploy-pychatter.sh

# Run the deployment script
bash deploy-pychatter.sh 217.216.40.246
```

---

## Step 4: Verify Everything Works

After the script completes:

```bash
# Check service status
sudo systemctl status pychatter-server
sudo systemctl status pychatter-web
sudo systemctl status nginx

# View live logs
sudo journalctl -u pychatter-server -f
```

---

## Step 5: Access PyChatter

Open in your browser:
```
http://217.216.40.246
```

You should see the registration/login page. Create an account and start chatting!

---

## Useful Commands After Deployment

```bash
# View logs in real-time
sudo journalctl -u pychatter-server -f
sudo journalctl -u pychatter-web -f

# Restart services
sudo systemctl restart pychatter-server pychatter-web

# Stop services
sudo systemctl stop pychatter-server pychatter-web

# Start services
sudo systemctl start pychatter-server pychatter-web

# Check if running
sudo systemctl is-active pychatter-server

# View database (if token is set)
# Check logs for: "_db?token=..."
```

---

## Troubleshooting

**Services won't start?**
```bash
sudo journalctl -u pychatter-server -n 50  # Last 50 lines
```

**Port conflicts?**
```bash
sudo netstat -tlnp | grep :9010
sudo netstat -tlnp | grep :9011
```

**Nginx issues?**
```bash
sudo nginx -t
sudo systemctl restart nginx
```

---

## What's Running

- **Chat Server:** Port 9011 (localhost only)
- **Web Bridge:** Port 9010 (localhost only)
- **Nginx:** Port 80 (public, reverse proxy)
- **Database:** `/opt/pychatter/server/chat.db`

Your setup is fully containerized with systemd, so it will auto-restart on reboot. Logs go to journalctl.

---

## Next Steps (Optional)

- **HTTPS/TLS:** Install `certbot` for Let's Encrypt SSL
- **Custom Domain:** Update Nginx server_name if you have a domain
- **Database Backups:** Set up cron job to backup `chat.db`
- **Performance:** Monitor with `htop` or `systemd-analyze`
