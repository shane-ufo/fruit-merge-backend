// ==========================================
// Fruit Merge Game - Backend Server v2.0
// Added: Admin Dashboard & Analytics
// ==========================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Configuration
// ==========================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://fruit-merge-game-kappa.vercel.app';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';  // CHANGE THIS!
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || null;

if (!BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN is not set!');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN);

// ==========================================
// Middleware
// ==========================================

app.use(cors({ origin: '*' }));
app.use(express.json());

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ==========================================
// Analytics Storage
// ==========================================

const analytics = {
    onlineUsers: new Map(),
    totalUsers: 0,
    totalGamesPlayed: 0,
    payments: [],
    totalRevenue: 0,
    leaderboard: [],
    users: new Map(),
    activityLog: []
};

// ==========================================
// Helper Functions
// ==========================================

function addActivity(type, data) {
    analytics.activityLog.unshift({
        type,
        data,
        timestamp: Date.now()
    });
    if (analytics.activityLog.length > 100) {
        analytics.activityLog = analytics.activityLog.slice(0, 100);
    }
}

function cleanupOfflineUsers() {
    const now = Date.now();
    const OFFLINE_THRESHOLD = 5 * 60 * 1000;
    
    for (const [odairy, user] of analytics.onlineUsers) {
        if (now - user.lastSeen > OFFLINE_THRESHOLD) {
            analytics.onlineUsers.delete(odairy);
            addActivity('user_offline', { odairy, username: user.username });
        }
    }
}

setInterval(cleanupOfflineUsers, 60 * 1000);

// ==========================================
// Health Check
// ==========================================

app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Fruit Merge Backend v2.0',
        onlineUsers: analytics.onlineUsers.size
    });
});

// ==========================================
// User Tracking
// ==========================================

app.post('/api/heartbeat', (req, res) => {
    const { userId, username, avatar, score } = req.body;
    
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    const now = Date.now();
    
    if (analytics.onlineUsers.has(userId)) {
        const user = analytics.onlineUsers.get(userId);
        user.lastSeen = now;
        user.score = score || user.score;
    } else {
        analytics.onlineUsers.set(userId, {
            userId,
            username: username || 'Player',
            avatar: avatar || '🎮',
            lastSeen: now,
            joinedAt: now,
            score: score || 0
        });
        addActivity('user_online', { userId, username });
    }
    
    if (!analytics.users.has(userId)) {
        analytics.totalUsers++;
        analytics.users.set(userId, {
            userId,
            username: username || 'Player',
            avatar: avatar || '🎮',
            firstSeen: now,
            lastSeen: now,
            gamesPlayed: 0,
            highScore: 0,
            totalSpent: 0
        });
        addActivity('new_user', { userId, username });
    } else {
        const user = analytics.users.get(userId);
        user.lastSeen = now;
        user.username = username || user.username;
    }
    
    res.json({ success: true, onlineCount: analytics.onlineUsers.size });
});

app.post('/api/game/start', (req, res) => {
    const { userId, username } = req.body;
    analytics.totalGamesPlayed++;
    if (analytics.users.has(userId)) {
        analytics.users.get(userId).gamesPlayed++;
    }
    addActivity('game_start', { userId, username });
    res.json({ success: true });
});

app.post('/api/game/end', (req, res) => {
    const { userId, username, score } = req.body;
    if (analytics.users.has(userId)) {
        const user = analytics.users.get(userId);
        if (score > user.highScore) user.highScore = score;
    }
    addActivity('game_end', { userId, username, score });
    res.json({ success: true });
});

// ==========================================
// Telegram Webhook
// ==========================================

app.post('/api/webhook', async (req, res) => {
    try {
        const update = req.body;
        
        if (update.pre_checkout_query) {
            await bot.answerPreCheckoutQuery(update.pre_checkout_query.id, true);
        }
        
        if (update.message?.successful_payment) {
            const payment = update.message.successful_payment;
            const user = update.message.from;
            
            const record = {
                userId: user.id,
                username: user.first_name + (user.last_name ? ' ' + user.last_name : ''),
                amount: payment.total_amount,
                currency: payment.currency,
                item: payment.invoice_payload,
                timestamp: Date.now()
            };
            
            analytics.payments.push(record);
            analytics.totalRevenue += payment.total_amount;
            
            if (analytics.users.has(user.id)) {
                analytics.users.get(user.id).totalSpent += payment.total_amount;
            }
            
            addActivity('payment', record);
            
            if (ADMIN_TELEGRAM_ID) {
                bot.sendMessage(ADMIN_TELEGRAM_ID, 
                    `💰 Payment!\n${record.username}\n${payment.total_amount} ${payment.currency}\n${payment.invoice_payload}`
                ).catch(e => {});
            }
        }
        
        if (update.message?.text?.startsWith('/start')) {
            const chatId = update.message.chat.id;
            await bot.sendMessage(chatId, 
                '🍉 Welcome to Fruit Merge!\n\nTap to play:',
                {
                    reply_markup: {
                        inline_keyboard: [[{ text: '🎮 Play', web_app: { url: WEBAPP_URL } }]]
                    }
                }
            );
        }
        
        if (update.message?.text === '/stats' && ADMIN_TELEGRAM_ID && 
            update.message.from.id.toString() === ADMIN_TELEGRAM_ID) {
            await bot.sendMessage(update.message.chat.id,
                `📊 Stats\n👥 Online: ${analytics.onlineUsers.size}\n👤 Total: ${analytics.totalUsers}\n🎮 Games: ${analytics.totalGamesPlayed}\n💰 Revenue: ${analytics.totalRevenue} XTR`
            );
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('[Webhook]', error);
        res.sendStatus(200);
    }
});

// ==========================================
// Admin API
// ==========================================

function adminAuth(req, res, next) {
    const password = req.headers['x-admin-password'] || req.query.password;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

app.get('/api/admin/dashboard', adminAuth, (req, res) => {
    cleanupOfflineUsers();
    
    const onlineList = Array.from(analytics.onlineUsers.values()).sort((a, b) => b.lastSeen - a.lastSeen);
    const recentPayments = analytics.payments.slice(-20).reverse();
    const topPlayers = Array.from(analytics.users.values()).sort((a, b) => b.highScore - a.highScore).slice(0, 10);
    const topSpenders = Array.from(analytics.users.values()).filter(u => u.totalSpent > 0).sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 10);
    const recentActivity = analytics.activityLog.slice(0, 20);
    
    res.json({
        stats: {
            onlineUsers: analytics.onlineUsers.size,
            totalUsers: analytics.totalUsers,
            totalGamesPlayed: analytics.totalGamesPlayed,
            totalRevenue: analytics.totalRevenue,
            totalPayments: analytics.payments.length
        },
        onlineUsers: onlineList,
        recentPayments,
        topPlayers,
        topSpenders,
        recentActivity,
        serverTime: Date.now()
    });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
    const users = Array.from(analytics.users.values()).sort((a, b) => b.lastSeen - a.lastSeen);
    res.json({ users, total: users.length });
});

app.get('/api/admin/payments', adminAuth, (req, res) => {
    res.json({ payments: [...analytics.payments].reverse(), total: analytics.payments.length, totalRevenue: analytics.totalRevenue });
});

// ==========================================
// Payment & Leaderboard
// ==========================================

app.post('/api/create-invoice', async (req, res) => {
    try {
        const { itemId, title, description, price, userId } = req.body;
        const invoiceLink = await bot.createInvoiceLink(title, description, `${itemId}:${userId}`, '', 'XTR', [{ label: title, amount: price }]);
        res.json({ success: true, invoiceLink });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/leaderboard/submit', (req, res) => {
    const { userId, username, score, avatar } = req.body;
    const idx = analytics.leaderboard.findIndex(e => e.userId === userId);
    
    if (idx !== -1) {
        if (score > analytics.leaderboard[idx].score) {
            analytics.leaderboard[idx].score = score;
            analytics.leaderboard[idx].username = username;
        }
    } else {
        analytics.leaderboard.push({ userId, username: username || 'Player', score, avatar: avatar || '🎮' });
    }
    
    analytics.leaderboard.sort((a, b) => b.score - a.score);
    const rank = analytics.leaderboard.findIndex(e => e.userId === userId) + 1;
    res.json({ success: true, rank });
});

app.get('/api/leaderboard', (req, res) => {
    res.json(analytics.leaderboard.slice(0, 100));
});

// ==========================================
// Start
// ==========================================

app.listen(PORT, () => {
    console.log(`🍉 Fruit Merge Backend v2.0 on port ${PORT}`);
    console.log(`🔐 Admin: /api/admin/dashboard?password=${ADMIN_PASSWORD}`);
});
