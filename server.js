// ==========================================
// Fruit Merge Backend v3.0
// Fixed: Username tracking, Leaderboard sync
// ==========================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://shane-ufo.github.io/fruit-merge-game/';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || null;

if (!BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN not set!');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN);

app.use(cors({ origin: '*' }));
app.use(express.json());

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ==========================================
// Data Storage (Use DB in production!)
// ==========================================

const db = {
    onlineUsers: new Map(),
    users: new Map(),
    payments: [],
    leaderboard: [],
    activityLog: [],
    stats: {
        totalUsers: 0,
        totalGamesPlayed: 0,
        totalRevenue: 0
    }
};

function addActivity(type, data) {
    db.activityLog.unshift({ type, data, timestamp: Date.now() });
    if (db.activityLog.length > 100) db.activityLog = db.activityLog.slice(0, 100);
}

function cleanupOffline() {
    const now = Date.now();
    for (const [id, user] of db.onlineUsers) {
        if (now - user.lastSeen > 5 * 60 * 1000) {
            db.onlineUsers.delete(id);
            addActivity('user_offline', { userId: id, username: user.username });
        }
    }
}

setInterval(cleanupOffline, 60000);

// ==========================================
// API Routes
// ==========================================

app.get('/', (req, res) => {
    res.json({ status: 'ok', version: '3.0', online: db.onlineUsers.size });
});

// ---------- User Tracking ----------

app.post('/api/heartbeat', (req, res) => {
    const { userId, username, avatar, score } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    const now = Date.now();
    const displayName = username || `User_${userId.toString().slice(-4)}`;
    
    // Update online
    if (db.onlineUsers.has(userId)) {
        const u = db.onlineUsers.get(userId);
        u.lastSeen = now;
        u.score = score || u.score;
        u.username = displayName; // Always update username
    } else {
        db.onlineUsers.set(userId, {
            userId, username: displayName, avatar: avatar || '🎮',
            lastSeen: now, joinedAt: now, score: score || 0
        });
        addActivity('user_online', { userId, username: displayName });
    }
    
    // Update user DB
    if (!db.users.has(userId)) {
        db.stats.totalUsers++;
        db.users.set(userId, {
            userId, username: displayName, avatar: avatar || '🎮',
            firstSeen: now, lastSeen: now, gamesPlayed: 0, highScore: 0, totalSpent: 0
        });
        addActivity('new_user', { userId, username: displayName });
    } else {
        const u = db.users.get(userId);
        u.lastSeen = now;
        u.username = displayName; // Always update username
        if (avatar) u.avatar = avatar;
    }
    
    res.json({ success: true, online: db.onlineUsers.size });
});

app.post('/api/game/start', (req, res) => {
    const { userId, username } = req.body;
    db.stats.totalGamesPlayed++;
    
    if (db.users.has(userId)) {
        db.users.get(userId).gamesPlayed++;
    }
    
    addActivity('game_start', { userId, username: username || `User_${userId?.toString().slice(-4)}` });
    res.json({ success: true });
});

app.post('/api/game/end', (req, res) => {
    const { userId, username, score } = req.body;
    
    if (db.users.has(userId)) {
        const u = db.users.get(userId);
        if (score > u.highScore) {
            u.highScore = score;
        }
        // Update username if provided
        if (username) u.username = username;
    }
    
    // Also update leaderboard
    updateLeaderboard(userId, username, score);
    
    addActivity('game_end', { userId, username: username || `User_${userId?.toString().slice(-4)}`, score });
    res.json({ success: true });
});

// ---------- Leaderboard ----------

function updateLeaderboard(userId, username, score) {
    if (!userId || !score) return;
    
    const displayName = username || `User_${userId.toString().slice(-4)}`;
    const idx = db.leaderboard.findIndex(e => e.userId === userId);
    
    if (idx !== -1) {
        // Update if higher score
        if (score > db.leaderboard[idx].score) {
            db.leaderboard[idx].score = score;
        }
        // Always update username
        db.leaderboard[idx].username = displayName;
    } else {
        db.leaderboard.push({ userId, username: displayName, score, avatar: '🎮' });
    }
    
    db.leaderboard.sort((a, b) => b.score - a.score);
}

app.post('/api/leaderboard/submit', (req, res) => {
    const { userId, username, score, avatar } = req.body;
    
    updateLeaderboard(userId, username, score);
    
    // Update avatar if provided
    const entry = db.leaderboard.find(e => e.userId === userId);
    if (entry && avatar) entry.avatar = avatar;
    
    const rank = db.leaderboard.findIndex(e => e.userId === userId) + 1;
    res.json({ success: true, rank, total: db.leaderboard.length });
});

app.get('/api/leaderboard', (req, res) => {
    res.json(db.leaderboard.slice(0, 100));
});

// ---------- Telegram Webhook ----------

app.post('/api/webhook', async (req, res) => {
    try {
        const update = req.body;
        
        if (update.pre_checkout_query) {
            await bot.answerPreCheckoutQuery(update.pre_checkout_query.id, true);
        }
        
        if (update.message?.successful_payment) {
            const payment = update.message.successful_payment;
            const user = update.message.from;
            const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') || `User_${user.id}`;
            
            const record = {
                userId: user.id,
                username: displayName,
                amount: payment.total_amount,
                currency: payment.currency,
                item: payment.invoice_payload,
                timestamp: Date.now()
            };
            
            db.payments.push(record);
            db.stats.totalRevenue += payment.total_amount;
            
            if (db.users.has(user.id)) {
                db.users.get(user.id).totalSpent += payment.total_amount;
            }
            
            addActivity('payment', record);
            
            if (ADMIN_TELEGRAM_ID) {
                bot.sendMessage(ADMIN_TELEGRAM_ID,
                    `💰 Payment!\n${displayName}\n${payment.total_amount} ⭐\n${payment.invoice_payload}`
                ).catch(() => {});
            }
        }
        
        if (update.message?.text?.startsWith('/start')) {
            const chatId = update.message.chat.id;
            await bot.sendMessage(chatId,
                '🍉 Welcome to Fruit Merge!\n\nTap to play:',
                { reply_markup: { inline_keyboard: [[{ text: '🎮 Play', web_app: { url: WEBAPP_URL } }]] } }
            );
        }
        
        if (update.message?.text === '/stats' && ADMIN_TELEGRAM_ID &&
            update.message.from.id.toString() === ADMIN_TELEGRAM_ID) {
            await bot.sendMessage(update.message.chat.id,
                `📊 Stats\n👥 Online: ${db.onlineUsers.size}\n👤 Users: ${db.stats.totalUsers}\n🎮 Games: ${db.stats.totalGamesPlayed}\n💰 Revenue: ${db.stats.totalRevenue}⭐`
            );
        }
        
        res.sendStatus(200);
    } catch (e) {
        console.error('[Webhook]', e);
        res.sendStatus(200);
    }
});

// ---------- Admin API ----------

function adminAuth(req, res, next) {
    const pw = req.headers['x-admin-password'] || req.query.password;
    if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

app.get('/api/admin/dashboard', adminAuth, (req, res) => {
    cleanupOffline();
    
    const onlineUsers = Array.from(db.onlineUsers.values()).sort((a, b) => b.lastSeen - a.lastSeen);
    const recentPayments = db.payments.slice(-20).reverse();
    
    // Top players from users DB (more reliable)
    const topPlayers = Array.from(db.users.values())
        .filter(u => u.highScore > 0)
        .sort((a, b) => b.highScore - a.highScore)
        .slice(0, 10);
    
    const topSpenders = Array.from(db.users.values())
        .filter(u => u.totalSpent > 0)
        .sort((a, b) => b.totalSpent - a.totalSpent)
        .slice(0, 10);
    
    res.json({
        stats: {
            onlineUsers: db.onlineUsers.size,
            totalUsers: db.stats.totalUsers,
            totalGamesPlayed: db.stats.totalGamesPlayed,
            totalRevenue: db.stats.totalRevenue,
            totalPayments: db.payments.length
        },
        onlineUsers,
        recentPayments,
        topPlayers,
        topSpenders,
        recentActivity: db.activityLog.slice(0, 20),
        serverTime: Date.now()
    });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
    res.json({ users: Array.from(db.users.values()), total: db.users.size });
});

app.get('/api/admin/payments', adminAuth, (req, res) => {
    res.json({ payments: [...db.payments].reverse(), total: db.payments.length, totalRevenue: db.stats.totalRevenue });
});

// ---------- Payment ----------

app.post('/api/create-invoice', async (req, res) => {
    try {
        const { itemId, title, description, price, userId } = req.body;
        const link = await bot.createInvoiceLink(title, description, `${itemId}:${userId}`, '', 'XTR', [{ label: title, amount: price }]);
        res.json({ success: true, invoiceLink: link });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// Start
// ==========================================

app.listen(PORT, () => {
    console.log(`🍉 Fruit Merge Backend v3.0 on port ${PORT}`);
    console.log(`📱 WebApp: ${WEBAPP_URL}`);
    console.log(`🔐 Admin: /api/admin/dashboard?password=${ADMIN_PASSWORD}`);
});
