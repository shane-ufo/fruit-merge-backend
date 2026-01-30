// ==========================================
// Fruit Merge Backend v3.1
// Added: Data persistence, Better tracking
// ==========================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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

// ==========================================
// Data Persistence
// ==========================================

const DATA_FILE = path.join(__dirname, 'data.json');

// Default data structure
const defaultData = {
    users: {},
    payments: [],
    leaderboard: [],
    activityLog: [],
    stats: {
        totalUsers: 0,
        totalGamesPlayed: 0,
        totalRevenue: 0
    }
};

// Load data from file
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(raw);
            console.log('[DB] Loaded data:', Object.keys(data.users || {}).length, 'users');
            return { ...defaultData, ...data };
        }
    } catch (e) {
        console.error('[DB] Load error:', e.message);
    }
    return { ...defaultData };
}

// Save data to file
function saveData() {
    try {
        const dataToSave = {
            users: Object.fromEntries(db.users),
            payments: db.payments,
            leaderboard: db.leaderboard,
            activityLog: db.activityLog.slice(0, 100),
            stats: db.stats
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (e) {
        console.error('[DB] Save error:', e.message);
    }
}

// Auto-save every 30 seconds
setInterval(saveData, 30000);

// Save on exit
process.on('SIGINT', () => { saveData(); process.exit(); });
process.on('SIGTERM', () => { saveData(); process.exit(); });

// ==========================================
// Initialize Data
// ==========================================

const loadedData = loadData();

const db = {
    onlineUsers: new Map(),
    users: new Map(Object.entries(loadedData.users || {})),
    payments: loadedData.payments || [],
    leaderboard: loadedData.leaderboard || [],
    activityLog: loadedData.activityLog || [],
    stats: loadedData.stats || defaultData.stats
};

// Update stats from loaded data
db.stats.totalUsers = db.users.size;

console.log('[DB] Initialized with', db.users.size, 'users,', db.payments.length, 'payments');

// ==========================================
// Helper Functions
// ==========================================

function addActivity(type, data) {
    db.activityLog.unshift({ type, data, timestamp: Date.now() });
    if (db.activityLog.length > 200) db.activityLog = db.activityLog.slice(0, 200);
}

function cleanupOffline() {
    const now = Date.now();
    for (const [id, user] of db.onlineUsers) {
        if (now - user.lastSeen > 5 * 60 * 1000) {
            db.onlineUsers.delete(id);
        }
    }
}

setInterval(cleanupOffline, 60000);

function getDisplayName(userId, username, firstName, lastName) {
    if (username) return username;
    if (firstName) return [firstName, lastName].filter(Boolean).join(' ');
    return `Player_${String(userId).slice(-4)}`;
}

// ==========================================
// API Routes
// ==========================================

app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: '3.1',
        online: db.onlineUsers.size,
        totalUsers: db.users.size,
        totalPayments: db.payments.length
    });
});

// ---------- User Tracking ----------

app.post('/api/heartbeat', (req, res) => {
    const { userId, username, firstName, lastName, avatar, score } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    const now = Date.now();
    const displayName = getDisplayName(userId, username, firstName, lastName);
    const odairy = String(userId);
    
    // Update online status
    db.onlineUsers.set(odairy, {
        odairy, 
        username: displayName, 
        avatar: avatar || '🎮',
        lastSeen: now, 
        joinedAt: db.onlineUsers.get(odairy)?.joinedAt || now, 
        score: score || 0
    });
    
    // Update/create user in permanent storage
    if (!db.users.has(odairy)) {
        db.stats.totalUsers++;
        db.users.set(odairy, {
            odairy, 
            username: displayName, 
            avatar: avatar || '🎮',
            firstName: firstName || '',
            lastName: lastName || '',
            firstSeen: now, 
            lastSeen: now, 
            gamesPlayed: 0, 
            highScore: 0, 
            totalSpent: 0,
            totalStarsPurchased: 0
        });
        addActivity('new_user', { odairy, username: displayName });
    } else {
        const u = db.users.get(odairy);
        u.lastSeen = now;
        u.username = displayName;
        if (firstName) u.firstName = firstName;
        if (lastName) u.lastName = lastName;
        if (avatar) u.avatar = avatar;
    }
    
    res.json({ success: true, online: db.onlineUsers.size });
});

app.post('/api/game/start', (req, res) => {
    const { userId, username } = req.body;
    const odairy = String(userId);
    
    db.stats.totalGamesPlayed++;
    
    if (db.users.has(odairy)) {
        db.users.get(odairy).gamesPlayed++;
    }
    
    addActivity('game_start', { odairy, username: username || `Player_${odairy.slice(-4)}` });
    res.json({ success: true });
});

app.post('/api/game/end', (req, res) => {
    const { userId, username, score } = req.body;
    const odairy = String(userId);
    
    if (db.users.has(odairy)) {
        const u = db.users.get(odairy);
        if (score > u.highScore) {
            u.highScore = score;
        }
        if (username) u.username = username;
    }
    
    updateLeaderboard(odairy, username, score);
    addActivity('game_end', { odairy, username: username || `Player_${odairy.slice(-4)}`, score });
    
    res.json({ success: true });
});

// ---------- Leaderboard ----------

function updateLeaderboard(odairy, username, score) {
    if (!odairy || !score) return;
    
    const displayName = username || `Player_${odairy.slice(-4)}`;
    const idx = db.leaderboard.findIndex(e => e.odairy === odairy);
    
    if (idx !== -1) {
        if (score > db.leaderboard[idx].score) {
            db.leaderboard[idx].score = score;
        }
        db.leaderboard[idx].username = displayName;
    } else {
        db.leaderboard.push({ odairy, username: displayName, score, avatar: '🎮' });
    }
    
    db.leaderboard.sort((a, b) => b.score - a.score);
    db.leaderboard = db.leaderboard.slice(0, 100); // Keep top 100
}

app.post('/api/leaderboard/submit', (req, res) => {
    const { userId, username, score, avatar } = req.body;
    const odairy = String(userId);
    
    updateLeaderboard(odairy, username, score);
    
    const entry = db.leaderboard.find(e => e.odairy === odairy);
    if (entry && avatar) entry.avatar = avatar;
    
    const rank = db.leaderboard.findIndex(e => e.odairy === odairy) + 1;
    res.json({ success: true, rank, total: db.leaderboard.length });
});

app.get('/api/leaderboard', (req, res) => {
    res.json(db.leaderboard.slice(0, 100));
});

// ---------- Star Purchase (NEW!) ----------

// Star packages available for purchase
const STAR_PACKAGES = [
    { id: 'stars_100', stars: 100, price: 10, bonus: 0 },
    { id: 'stars_500', stars: 500, price: 45, bonus: 50 },      // +50 bonus
    { id: 'stars_1000', stars: 1000, price: 80, bonus: 200 },   // +200 bonus
    { id: 'stars_5000', stars: 5000, price: 350, bonus: 1500 }  // +1500 bonus
];

app.get('/api/star-packages', (req, res) => {
    res.json(STAR_PACKAGES);
});

app.post('/api/buy-stars', async (req, res) => {
    try {
        const { packageId, userId, username } = req.body;
        const pkg = STAR_PACKAGES.find(p => p.id === packageId);
        
        if (!pkg) {
            return res.status(400).json({ success: false, error: 'Invalid package' });
        }
        
        const totalStars = pkg.stars + pkg.bonus;
        const description = `${pkg.stars} Stars${pkg.bonus > 0 ? ` + ${pkg.bonus} Bonus` : ''}`;
        
        const invoiceLink = await bot.createInvoiceLink(
            `${totalStars} ⭐ Stars`,
            description,
            `stars:${packageId}:${userId}`,
            '',
            'XTR',
            [{ label: `${totalStars} Stars`, amount: pkg.price }]
        );
        
        res.json({ success: true, invoiceLink });
    } catch (e) {
        console.error('[Buy Stars]', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ---------- Telegram Webhook ----------

app.post('/api/webhook', async (req, res) => {
    try {
        const update = req.body;
        
        // Pre-checkout
        if (update.pre_checkout_query) {
            await bot.answerPreCheckoutQuery(update.pre_checkout_query.id, true);
        }
        
        // Successful payment
        if (update.message?.successful_payment) {
            const payment = update.message.successful_payment;
            const user = update.message.from;
            const odairy = String(user.id);
            const displayName = getDisplayName(user.id, user.username, user.first_name, user.last_name);
            
            const record = {
                odairy,
                odairyNum: user.id,
                username: displayName,
                telegramUsername: user.username || null,
                firstName: user.first_name || '',
                lastName: user.last_name || '',
                amount: payment.total_amount,
                currency: payment.currency,
                item: payment.invoice_payload,
                timestamp: Date.now()
            };
            
            db.payments.push(record);
            db.stats.totalRevenue += payment.total_amount;
            
            // Update user record
            if (db.users.has(odairy)) {
                const u = db.users.get(odairy);
                u.totalSpent += payment.total_amount;
                u.username = displayName;
                if (user.username) u.telegramUsername = user.username;
            }
            
            // Check if it's a stars purchase
            const payload = payment.invoice_payload;
            if (payload.startsWith('stars:')) {
                const parts = payload.split(':');
                const packageId = parts[1];
                const pkg = STAR_PACKAGES.find(p => p.id === packageId);
                
                if (pkg && db.users.has(odairy)) {
                    const totalStars = pkg.stars + pkg.bonus;
                    db.users.get(odairy).totalStarsPurchased += totalStars;
                    
                    // Send confirmation to user
                    await bot.sendMessage(user.id, 
                        `✅ Payment successful!\n\nYou received: ${totalStars} ⭐ Stars\n\nOpen the game to use your stars!`
                    ).catch(() => {});
                }
            }
            
            addActivity('payment', record);
            saveData(); // Save immediately after payment
            
            // Notify admin
            if (ADMIN_TELEGRAM_ID) {
                const msg = `💰 New Payment!\n\n` +
                    `👤 ${displayName}\n` +
                    `${user.username ? `@${user.username}\n` : ''}` +
                    `💵 ${payment.total_amount} ${payment.currency}\n` +
                    `📦 ${payload}`;
                bot.sendMessage(ADMIN_TELEGRAM_ID, msg).catch(() => {});
            }
        }
        
        // /start command
        if (update.message?.text?.startsWith('/start')) {
            const chatId = update.message.chat.id;
            const user = update.message.from;
            
            await bot.sendMessage(chatId,
                `🍉 Welcome to Fruit Merge, ${user.first_name || 'Player'}!\n\n` +
                `Drop and merge fruits to score high!\n\n` +
                `Tap the button below to play:`,
                { 
                    reply_markup: { 
                        inline_keyboard: [[
                            { text: '🎮 Play Now', web_app: { url: WEBAPP_URL } }
                        ]] 
                    } 
                }
            );
        }
        
        // /stats command (admin only)
        if (update.message?.text === '/stats' && ADMIN_TELEGRAM_ID &&
            update.message.from.id.toString() === ADMIN_TELEGRAM_ID) {
            await bot.sendMessage(update.message.chat.id,
                `📊 Fruit Merge Stats\n\n` +
                `👥 Online: ${db.onlineUsers.size}\n` +
                `👤 Total Users: ${db.users.size}\n` +
                `🎮 Games Played: ${db.stats.totalGamesPlayed}\n` +
                `💰 Revenue: ${db.stats.totalRevenue} XTR\n` +
                `💳 Payments: ${db.payments.length}`
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
    
    const onlineUsers = Array.from(db.onlineUsers.values())
        .sort((a, b) => b.lastSeen - a.lastSeen);
    
    const recentPayments = db.payments.slice(-30).reverse();
    
    const topPlayers = Array.from(db.users.values())
        .filter(u => u.highScore > 0)
        .sort((a, b) => b.highScore - a.highScore)
        .slice(0, 20);
    
    const topSpenders = Array.from(db.users.values())
        .filter(u => u.totalSpent > 0)
        .sort((a, b) => b.totalSpent - a.totalSpent)
        .slice(0, 20);
    
    res.json({
        stats: {
            onlineUsers: db.onlineUsers.size,
            totalUsers: db.users.size,
            totalGamesPlayed: db.stats.totalGamesPlayed,
            totalRevenue: db.stats.totalRevenue,
            totalPayments: db.payments.length
        },
        onlineUsers,
        recentPayments,
        topPlayers,
        topSpenders,
        recentActivity: db.activityLog.slice(0, 30),
        serverTime: Date.now()
    });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
    const users = Array.from(db.users.values())
        .sort((a, b) => b.lastSeen - a.lastSeen);
    res.json({ users, total: users.length });
});

app.get('/api/admin/payments', adminAuth, (req, res) => {
    res.json({ 
        payments: [...db.payments].reverse(), 
        total: db.payments.length, 
        totalRevenue: db.stats.totalRevenue 
    });
});

// Force save data
app.post('/api/admin/save', adminAuth, (req, res) => {
    saveData();
    res.json({ success: true, message: 'Data saved' });
});

// ---------- Other ----------

app.post('/api/create-invoice', async (req, res) => {
    try {
        const { itemId, title, description, price, userId } = req.body;
        const link = await bot.createInvoiceLink(
            title, 
            description, 
            `item:${itemId}:${userId}`, 
            '', 
            'XTR', 
            [{ label: title, amount: price }]
        );
        res.json({ success: true, invoiceLink: link });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// Start Server
// ==========================================

app.listen(PORT, () => {
    console.log('==========================================');
    console.log(`🍉 Fruit Merge Backend v3.1`);
    console.log(`🚀 Port: ${PORT}`);
    console.log(`📱 WebApp: ${WEBAPP_URL}`);
    console.log(`👤 Users: ${db.users.size}`);
    console.log(`💳 Payments: ${db.payments.length}`);
    console.log('==========================================');
});
