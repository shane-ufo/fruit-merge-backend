# 🔐 Admin Dashboard Setup

## Files

```
fruit-merge-backend/
├── server.js      # Backend with admin API
├── package.json   # Dependencies
└── admin.html     # Admin dashboard page
```

## Step 1: Update Your Backend on Render

1. Go to your GitHub repo `fruit-merge-backend`
2. Replace `server.js` with the new version
3. Render will auto-redeploy

## Step 2: Set Admin Password

In Render Dashboard → Environment Variables, add:

| Key | Value |
|-----|-------|
| `ADMIN_PASSWORD` | `YourSecretPassword123` |
| `ADMIN_TELEGRAM_ID` | `YourTelegramUserID` (optional) |

**To find your Telegram User ID:**
1. Message @userinfobot on Telegram
2. It replies with your user ID

## Step 3: Access Admin Dashboard

### Option A: Open admin.html locally
1. Download `admin.html`
2. Open in browser
3. Enter your password

### Option B: Host admin.html (more secure)
1. Upload `admin.html` to your Vercel/GitHub Pages
2. Access via URL
3. Enter password to login

## Step 4: API Endpoints

All admin endpoints require password:

```
GET /api/admin/dashboard?password=YOUR_PASSWORD
GET /api/admin/users?password=YOUR_PASSWORD
GET /api/admin/payments?password=YOUR_PASSWORD
```

Or use header:
```
X-Admin-Password: YOUR_PASSWORD
```

## Features

### 📊 Dashboard shows:
- 👥 Online users (real-time)
- 👤 Total users
- 🎮 Total games played
- 💰 Revenue (Telegram Stars)
- 💳 All payments

### 🔔 Telegram Notifications
If you set `ADMIN_TELEGRAM_ID`, you'll receive:
- 💰 Every new payment
- You can also send `/stats` to your bot for quick stats

## Security Tips

1. Use a strong password (not "admin123"!)
2. Don't share the admin.html with others
3. Change password regularly
4. Keep your Telegram ID private
