// ==========================================
// Fruit Merge Backend v3.2
// Added: Username system, Friends, Better leaderboard
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

const defaultData = {
    users: {},
    usernames: {}, // username -> odairy mapping
    payments: [],
    leaderboard: [],
    friends: {}, // odairy -> [friendIds]
    activityLog: [],
    stats: { totalUsers: 0, totalGamesPlayed: 0, totalRevenue: 0 }
};

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(raw);
            console.log('[DB] Loaded:', Object.keys(data.users || {}).length, 'users');
            return { ...defaultData, ...data };
        }
    } catch (e) {
        console.error('[DB] Load error:', e.message);
    }
    return { ...defaultData };
}

function saveData() {
    try {
        const dataToSave = {
            users: Object.fromEntries(db.users),
            usernames: Object.fromEntries(db.usernames),
            payments: db.payments.slice(-500), // Keep last 500 payments
            leaderboard: db.leaderboard.slice(0, 500), // Keep top 500
            friends: Object.fromEntries(db.friends),
            activityLog: db.activityLog.slice(0, 200),
            stats: db.stats
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (e) {
        console.error('[DB] Save error:', e.message);
    }
}

setInterval(saveData, 30000);
process.on('SIGINT', () => { saveData(); process.exit(); });
process.on('SIGTERM', () => { saveData(); process.exit(); });

// ==========================================
// Initialize Data
// ==========================================

const loadedData = loadData();

const db = {
    onlineUsers: new Map(),
    users: new Map(Object.entries(loadedData.users || {})),
    usernames: new Map(Object.entries(loadedData.usernames || {})),
    payments: loadedData.payments || [],
    leaderboard: loadedData.leaderboard || [],
    friends: new Map(Object.entries(loadedData.friends || {})),
    activityLog: loadedData.activityLog || [],
    stats: loadedData.stats || defaultData.stats
};

db.stats.totalUsers = db.users.size;

console.log('[DB] Init:', db.users.size, 'users,', db.leaderboard.length, 'leaderboard entries');

// ==========================================
// Helpers
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

function getDisplayName(odairy, username, firstName, lastName) {
    // First check if user has custom display name
    if (db.users.has(odairy)) {
        const user = db.users.get(odairy);
        if (user.displayName) return user.displayName;
    }
    if (username) return username;
    if (firstName) return [firstName, lastName].filter(Boolean).join(' ');
    return `Player_${String(odairy).slice(-4)}`;
}

// ==========================================
// Routes
// ==========================================

app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: '3.2',
        online: db.onlineUsers.size,
        users: db.users.size,
        leaderboard: db.leaderboard.length
    });
});

// ==========================================
// Username System
// ==========================================

// Check if username is taken
app.get('/api/check-username', (req, res) => {
    const name = (req.query.name || '').toLowerCase().trim();
    
    if (!name || name.length < 2) {
        return res.json({ taken: false, error: 'Invalid name' });
    }
    
    const taken = db.usernames.has(name);
    res.json({ taken });
});

// Register/update username
app.post('/api/register-username', (req, res) => {
    const { odairy, username, telegramUsername } = req.body;
    
    if (!odairy || !username) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    
    const normalizedName = username.toLowerCase().trim();
    const odairyStr = String(odairy);
    
    // Check if taken by someone else
    if (db.usernames.has(normalizedName)) {
        const ownerId = db.usernames.get(normalizedName);
        if (ownerId !== odairyStr) {
            return res.status(400).json({ error: 'Username taken' });
        }
    }
    
    // Remove old username if user had one
    if (db.users.has(odairyStr)) {
        const oldName = db.users.get(odairyStr).displayName;
        if (oldName) {
            db.usernames.delete(oldName.toLowerCase());
        }
    }
    
    // Register new username
    db.usernames.set(normalizedName, odairyStr);
    
    // Update user record
    if (db.users.has(odairyStr)) {
        const user = db.users.get(odairyStr);
        user.displayName = username;
        user.telegramUsername = telegramUsername;
    }
    
    // Update leaderboard entry
    const lbEntry = db.leaderboard.find(e => e.odairy === odairyStr);
    if (lbEntry) {
        lbEntry.username = username;
    }
    
    saveData();
    res.json({ success: true });
});

// ==========================================
// User Tracking
// ==========================================

app.post('/api/heartbeat', (req, res) => {
    const { userId, username, firstName, lastName, avatar, score, displayName, nameColor, isVip } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    const now = Date.now();
    const odairy = String(userId);
    const name = displayName || getDisplayName(odairy, username, firstName, lastName);
    
    // Online tracking
    db.onlineUsers.set(odairy, {
        odairy, 
        username: name, 
        displayName: displayName || name,
        nameColor: nameColor || null,
        isVip: isVip || false,
        avatar: avatar || '🎮',
        lastSeen: now, 
        joinedAt: db.onlineUsers.get(odairy)?.joinedAt || now, 
        score: score || 0
    });
    
    // Permanent user storage
    if (!db.users.has(odairy)) {
        db.stats.totalUsers++;
        db.users.set(odairy, {
            odairy, 
            username: name,
            displayName: displayName || null,
            nameColor: nameColor || null,
            isVip: isVip || false,
            avatar: avatar || '🎮',
            telegramUsername: username || null,
            firstName: firstName || '',
            lastName: lastName || '',
            firstSeen: now, 
            lastSeen: now, 
            gamesPlayed: 0, 
            highScore: 0, 
            totalSpent: 0
        });
        addActivity('new_user', { odairy, username: name });
    } else {
        const u = db.users.get(odairy);
        u.lastSeen = now;
        if (displayName) u.displayName = displayName;
        if (nameColor !== undefined) u.nameColor = nameColor;
        if (isVip !== undefined) u.isVip = isVip;
        if (firstName) u.firstName = firstName;
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
    
    addActivity('game_start', { odairy, username });
    res.json({ success: true });
});

app.post('/api/game/end', (req, res) => {
    const { userId, username, score, displayName, nameColor, isVip } = req.body;
    const odairy = String(userId);
    
    if (db.users.has(odairy)) {
        const u = db.users.get(odairy);
        if (score > u.highScore) {
            u.highScore = score;
        }
        if (displayName) u.displayName = displayName;
    }
    
    // Update leaderboard with all user info
    updateLeaderboard(odairy, displayName || username, score, nameColor, isVip);
    addActivity('game_end', { odairy, username: displayName || username, score });
    
    res.json({ success: true });
});

// ==========================================
// Leaderboard
// ==========================================

function updateLeaderboard(odairy, username, score, nameColor, isVip) {
    if (!odairy || !score) return;
    
    const idx = db.leaderboard.findIndex(e => e.odairy === odairy);
    
    // Get user data for avatar
    const userData = db.users.get(odairy);
    const avatar = userData?.avatar || '🎮';
    
    if (idx !== -1) {
        // Update existing entry
        if (score > db.leaderboard[idx].score) {
            db.leaderboard[idx].score = score;
        }
        db.leaderboard[idx].username = username;
        db.leaderboard[idx].nameColor = nameColor;
        db.leaderboard[idx].isVip = isVip;
        db.leaderboard[idx].avatar = avatar;
        db.leaderboard[idx].lastUpdated = Date.now();
    } else {
        // Add new entry
        db.leaderboard.push({ 
            odairy, 
            username, 
            score, 
            avatar,
            nameColor: nameColor || null,
            isVip: isVip || false,
            lastUpdated: Date.now()
        });
    }
    
    // Sort and trim
    db.leaderboard.sort((a, b) => b.score - a.score);
    db.leaderboard = db.leaderboard.slice(0, 500);
}

app.post('/api/leaderboard/submit', (req, res) => {
    const { userId, username, score, avatar, displayName, nameColor, isVip } = req.body;
    const odairy = String(userId);
    
    updateLeaderboard(odairy, displayName || username, score, nameColor, isVip);
    
    // Update avatar if provided
    const entry = db.leaderboard.find(e => e.odairy === odairy);
    if (entry && avatar) entry.avatar = avatar;
    
    const rank = db.leaderboard.findIndex(e => e.odairy === odairy) + 1;
    res.json({ success: true, rank, total: db.leaderboard.length });
});

// Global leaderboard
app.get('/api/leaderboard', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(db.leaderboard.slice(0, limit));
});

// Get user rank
app.get('/api/leaderboard/rank/:odairy', (req, res) => {
    const rank = db.leaderboard.findIndex(e => e.odairy === req.params.odairy) + 1;
    res.json({ rank: rank || null, total: db.leaderboard.length });
});

// ==========================================
// Friends System
// ==========================================

// Get user's friends (people they invited or who invited them)
app.get('/api/friends/:odairy', (req, res) => {
    const odairy = req.params.odairy;
    const friendIds = db.friends.get(odairy) || [];
    
    // Get friend details
    const friends = friendIds.map(fid => {
        const user = db.users.get(fid);
        if (!user) return null;
        
        return {
            odairy: fid,
            username: user.displayName || user.username || `Player_${fid.slice(-4)}`,
            avatar: user.avatar || '🎮',
            highScore: user.highScore || 0,
            nameColor: user.nameColor,
            isVip: user.isVip,
            online: db.onlineUsers.has(fid)
        };
    }).filter(Boolean);
    
    // Sort by high score
    friends.sort((a, b) => b.highScore - a.highScore);
    
    res.json({ friends });
});

// Add friend (called when referral is used)
app.post('/api/friends/add', (req, res) => {
    const { odairy, friendId } = req.body;
    
    if (!odairy || !friendId || odairy === friendId) {
        return res.status(400).json({ error: 'Invalid' });
    }
    
    // Add to both users' friend lists
    const user1Friends = db.friends.get(odairy) || [];
    const user2Friends = db.friends.get(friendId) || [];
    
    if (!user1Friends.includes(friendId)) {
        user1Friends.push(friendId);
        db.friends.set(odairy, user1Friends);
    }
    
    if (!user2Friends.includes(odairy)) {
        user2Friends.push(odairy);
        db.friends.set(friendId, user2Friends);
    }
    
    saveData();
    res.json({ success: true });
});

// Friends leaderboard
app.get('/api/leaderboard/friends/:odairy', (req, res) => {
    const odairy = req.params.odairy;
    const friendIds = db.friends.get(odairy) || [];
    
    // Include self
    const allIds = [odairy, ...friendIds];
    
    // Filter leaderboard to only include friends
    const friendsLb = db.leaderboard
        .filter(e => allIds.includes(e.odairy))
        .slice(0, 50);
    
    res.json({ leaderboard: friendsLb });
});

// ==========================================
// Referral Processing
// ==========================================

app.post('/api/referral', (req, res) => {
    const { newUserId, referrerId } = req.body;
    
    if (!newUserId || !referrerId || newUserId === referrerId) {
        return res.status(400).json({ error: 'Invalid referral' });
    }
    
    // Add as friends
    const ref = String(referrerId);
    const newU = String(newUserId);
    
    const refFriends = db.friends.get(ref) || [];
    const newFriends = db.friends.get(newU) || [];
    
    if (!refFriends.includes(newU)) {
        refFriends.push(newU);
        db.friends.set(ref, refFriends);
    }
    
    if (!newFriends.includes(ref)) {
        newFriends.push(ref);
        db.friends.set(newU, newFriends);
    }
    
    addActivity('referral', { referrerId: ref, newUserId: newU });
    saveData();
    
    res.json({ success: true });
});

// ==========================================
// Star Packages
// ==========================================

const STAR_PACKAGES = [
    { id: 'stars_100', stars: 100, price: 10, bonus: 0 },
    { id: 'stars_500', stars: 500, price: 45, bonus: 50 },
    { id: 'stars_1000', stars: 1000, price: 80, bonus: 200 },
    { id: 'stars_5000', stars: 5000, price: 350, bonus: 1500 }
];

app.get('/api/star-packages', (req, res) => {
    res.json(STAR_PACKAGES);
});

app.post('/api/buy-stars', async (req, res) => {
    try {
        const { packageId, userId, username } = req.body;
        const pkg = STAR_PACKAGES.find(p => p.id === packageId);
        
        if (!pkg) return res.status(400).json({ error: 'Invalid package' });
        
        const totalStars = pkg.stars + pkg.bonus;
        const desc = `${pkg.stars} Stars${pkg.bonus > 0 ? ` + ${pkg.bonus} Bonus` : ''}`;
        
        const invoiceLink = await bot.createInvoiceLink(
            `${totalStars} ⭐ Stars`,
            desc,
            `stars:${packageId}:${userId}`,
            '',
            'XTR',
            [{ label: `${totalStars} Stars`, amount: pkg.price }]
        );
        
        res.json({ success: true, invoiceLink });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
            const odairy = String(user.id);
            const displayName = getDisplayName(odairy, user.username, user.first_name, user.last_name);
            
            const record = {
                odairy,
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
            
            if (db.users.has(odairy)) {
                db.users.get(odairy).totalSpent += payment.total_amount;
            }
            
            // Handle star purchase
            const payload = payment.invoice_payload;
            if (payload.startsWith('stars:')) {
                const pkg = STAR_PACKAGES.find(p => p.id === payload.split(':')[1]);
                if (pkg) {
                    const totalStars = pkg.stars + pkg.bonus;
                    await bot.sendMessage(user.id, 
                        `✅ Payment successful!\n\nYou received: ${totalStars} ⭐ Stars\n\nOpen the game to use them!`
                    ).catch(() => {});
                }
            }
            
            addActivity('payment', record);
            saveData();
            
            if (ADMIN_TELEGRAM_ID) {
                bot.sendMessage(ADMIN_TELEGRAM_ID,
                    `💰 Payment!\n${displayName}${user.username ? ` (@${user.username})` : ''}\n${payment.total_amount} XTR\n${payload}`
                ).catch(() => {});
            }
        }
        
        if (update.message?.text?.startsWith('/start')) {
            const chatId = update.message.chat.id;
            const user = update.message.from;
            const param = update.message.text.split(' ')[1];
            
            // Process referral
            if (param && param.startsWith('ref_')) {
                const referrerId = param.replace('ref_', '');
                if (referrerId !== String(user.id)) {
                    // Add as friends
                    const ref = referrerId;
                    const newU = String(user.id);
                    
                    const refFriends = db.friends.get(ref) || [];
                    if (!refFriends.includes(newU)) {
                        refFriends.push(newU);
                        db.friends.set(ref, refFriends);
                        
                        const newFriends = db.friends.get(newU) || [];
                        newFriends.push(ref);
                        db.friends.set(newU, newFriends);
                        
                        addActivity('referral', { referrerId: ref, newUserId: newU });
                        saveData();
                    }
                }
            }
            
            await bot.sendMessage(chatId,
                `🍉 Welcome to Fruit Merge, ${user.first_name || 'Player'}!\n\n` +
                `Drop and merge fruits to score high!\n\nTap to play:`,
                { reply_markup: { inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: WEBAPP_URL } }]] } }
            );
        }
        
        if (update.message?.text === '/stats' && ADMIN_TELEGRAM_ID &&
            update.message.from.id.toString() === ADMIN_TELEGRAM_ID) {
            await bot.sendMessage(update.message.chat.id,
                `📊 Stats\n👥 Online: ${db.onlineUsers.size}\n👤 Users: ${db.users.size}\n🎮 Games: ${db.stats.totalGamesPlayed}\n💰 Revenue: ${db.stats.totalRevenue} XTR\n💳 Payments: ${db.payments.length}`
            );
        }
        
        res.sendStatus(200);
    } catch (e) {
        console.error('[Webhook]', e);
        res.sendStatus(200);
    }
});

// ==========================================
// Admin API
// ==========================================

function adminAuth(req, res, next) {
    const pw = req.headers['x-admin-password'] || req.query.password;
    if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

app.get('/api/admin/dashboard', adminAuth, (req, res) => {
    cleanupOffline();
    
    const onlineUsers = Array.from(db.onlineUsers.values()).sort((a, b) => b.lastSeen - a.lastSeen);
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
    res.json({ users: Array.from(db.users.values()), total: db.users.size });
});

app.get('/api/admin/payments', adminAuth, (req, res) => {
    res.json({ payments: [...db.payments].reverse(), total: db.payments.length, totalRevenue: db.stats.totalRevenue });
});

app.post('/api/admin/save', adminAuth, (req, res) => {
    saveData();
    res.json({ success: true });
});

app.post('/api/create-invoice', async (req, res) => {
    try {
        const { itemId, title, description, price, userId } = req.body;
        const link = await bot.createInvoiceLink(title, description, `item:${itemId}:${userId}`, '', 'XTR', [{ label: title, amount: price }]);
        res.json({ success: true, invoiceLink: link });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// Start
// ==========================================

app.listen(PORT, () => {
    console.log('==========================================');
    console.log(`🍉 Fruit Merge Backend v3.2`);
    console.log(`🚀 Port: ${PORT}`);
    console.log(`👤 Users: ${db.users.size}`);
    console.log(`🏆 Leaderboard: ${db.leaderboard.length}`);
    console.log('==========================================');
});
