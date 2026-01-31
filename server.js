// ==========================================
// Fruit Merge Backend v3.5
// Weekly Leaderboard System
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

if (!BOT_TOKEN) { console.error('ERROR: BOT_TOKEN not set!'); process.exit(1); }

const bot = new TelegramBot(BOT_TOKEN);
app.use(cors({ origin: '*' }));
app.use(express.json());

// ==========================================
// Weekly Helper Functions
// ==========================================

function getWeekNumber(d = new Date()) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function getCurrentWeekKey() {
    const now = new Date();
    return `${now.getFullYear()}-W${getWeekNumber(now).toString().padStart(2, '0')}`;
}

function getWeekDates(weekKey) {
    const [year, week] = weekKey.split('-W').map(Number);
    const jan1 = new Date(year, 0, 1);
    const days = (week - 1) * 7 - jan1.getDay() + 1;
    const start = new Date(year, 0, 1 + days);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return { start, end };
}

function getTimeUntilReset() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
    const nextMonday = new Date(now);
    nextMonday.setDate(now.getDate() + daysUntilMonday);
    nextMonday.setHours(0, 0, 0, 0);
    return nextMonday - now;
}

// ==========================================
// Data Persistence
// ==========================================

const DATA_FILE = path.join(__dirname, 'data.json');

const defaultData = {
    users: {},
    usernames: {},
    payments: [],
    weeklyLeaderboard: {},
    allTimeLeaderboard: [],
    friends: {},
    activityLog: [],
    stats: { totalUsers: 0, totalGamesPlayed: 0, totalRevenue: 0 },
    currentWeek: getCurrentWeekKey()
};

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            console.log('[DB] Loaded:', Object.keys(data.users || {}).length, 'users');
            return { ...defaultData, ...data };
        }
    } catch (e) { console.error('[DB] Load error:', e.message); }
    return { ...defaultData };
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            users: Object.fromEntries(db.users),
            usernames: Object.fromEntries(db.usernames),
            payments: db.payments.slice(-500),
            weeklyLeaderboard: db.weeklyLeaderboard,
            allTimeLeaderboard: db.allTimeLeaderboard.slice(0, 500),
            friends: Object.fromEntries(db.friends),
            activityLog: db.activityLog.slice(0, 200),
            stats: db.stats,
            currentWeek: db.currentWeek
        }, null, 2));
    } catch (e) { console.error('[DB] Save error:', e.message); }
}

setInterval(saveData, 30000);
process.on('SIGINT', () => { saveData(); process.exit(); });
process.on('SIGTERM', () => { saveData(); process.exit(); });

// Initialize
const loadedData = loadData();
const db = {
    onlineUsers: new Map(),
    users: new Map(Object.entries(loadedData.users || {})),
    usernames: new Map(Object.entries(loadedData.usernames || {})),
    payments: loadedData.payments || [],
    weeklyLeaderboard: loadedData.weeklyLeaderboard || {},
    allTimeLeaderboard: loadedData.allTimeLeaderboard || [],
    friends: new Map(Object.entries(loadedData.friends || {})),
    activityLog: loadedData.activityLog || [],
    stats: loadedData.stats || defaultData.stats,
    currentWeek: loadedData.currentWeek || getCurrentWeekKey()
};

function checkNewWeek() {
    const week = getCurrentWeekKey();
    if (db.currentWeek !== week) {
        console.log(`[Weekly] New week: ${db.currentWeek} -> ${week}`);
        db.currentWeek = week;
        if (!db.weeklyLeaderboard[week]) db.weeklyLeaderboard[week] = [];
        saveData();
    }
}
setInterval(checkNewWeek, 3600000);
checkNewWeek();

db.stats.totalUsers = db.users.size;

// Helpers
function addActivity(type, data) {
    db.activityLog.unshift({ type, data, timestamp: Date.now() });
    if (db.activityLog.length > 200) db.activityLog = db.activityLog.slice(0, 200);
}

function cleanupOffline() {
    const now = Date.now();
    for (const [id, u] of db.onlineUsers) {
        if (now - u.lastSeen > 300000) db.onlineUsers.delete(id);
    }
}
setInterval(cleanupOffline, 60000);

function getDisplayName(o, u, f, l) {
    if (db.users.has(o) && db.users.get(o).displayName) return db.users.get(o).displayName;
    if (u) return u;
    if (f) return [f, l].filter(Boolean).join(' ');
    return `Player_${String(o).slice(-4)}`;
}

// ==========================================
// Routes
// ==========================================

app.get('/', (req, res) => {
    checkNewWeek();
    const weekDates = getWeekDates(db.currentWeek);
    res.json({ 
        status: 'ok', version: '3.5',
        currentWeek: db.currentWeek,
        weekStart: weekDates.start,
        weekEnd: weekDates.end,
        timeUntilReset: getTimeUntilReset(),
        online: db.onlineUsers.size,
        users: db.users.size
    });
});

// Heartbeat
app.post('/api/heartbeat', (req, res) => {
    const { userId, username, firstName, lastName, avatar, score, displayName, nameColor, isVip, isVVIP } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    checkNewWeek();
    const now = Date.now();
    const odairy = String(userId);
    const name = displayName || getDisplayName(odairy, username, firstName, lastName);
    
    db.onlineUsers.set(odairy, {
        odairy, username: name, displayName: name, nameColor, isVip, isVVIP,
        avatar: avatar || '🎮', lastSeen: now,
        joinedAt: db.onlineUsers.get(odairy)?.joinedAt || now, score: score || 0
    });
    
    if (!db.users.has(odairy)) {
        db.stats.totalUsers++;
        db.users.set(odairy, {
            odairy, username: name, displayName: name, nameColor, isVip, isVVIP,
            avatar: avatar || '🎮', telegramUsername: username || null,
            firstName: firstName || '', lastName: lastName || '',
            firstSeen: now, lastSeen: now, gamesPlayed: 0, highScore: 0, totalSpent: 0
        });
        addActivity('new_user', { odairy, username: name });
    } else {
        const u = db.users.get(odairy);
        u.lastSeen = now;
        if (displayName) u.displayName = displayName;
        if (nameColor !== undefined) u.nameColor = nameColor;
        if (isVip !== undefined) u.isVip = isVip;
        if (isVVIP !== undefined) u.isVVIP = isVVIP;
        if (avatar) u.avatar = avatar;
    }
    
    res.json({ success: true, online: db.onlineUsers.size, currentWeek: db.currentWeek });
});

// Game events
app.post('/api/game/start', (req, res) => {
    const { userId, username } = req.body;
    db.stats.totalGamesPlayed++;
    if (db.users.has(String(userId))) db.users.get(String(userId)).gamesPlayed++;
    addActivity('game_start', { odairy: userId, username });
    res.json({ success: true });
});

app.post('/api/game/end', (req, res) => {
    const { userId, username, score, displayName, nameColor, isVip, isVVIP } = req.body;
    const odairy = String(userId);
    checkNewWeek();
    
    if (db.users.has(odairy)) {
        const u = db.users.get(odairy);
        if (score > u.highScore) u.highScore = score;
        if (displayName) u.displayName = displayName;
    }
    
    updateWeeklyLeaderboard(odairy, displayName || username, score, nameColor, isVip, isVVIP);
    updateAllTimeLeaderboard(odairy, displayName || username, score, nameColor, isVip, isVVIP);
    addActivity('game_end', { odairy, username: displayName || username, score });
    res.json({ success: true });
});

// ==========================================
// Leaderboard Functions
// ==========================================

function updateWeeklyLeaderboard(odairy, username, score, nameColor, isVip, isVVIP) {
    if (!odairy || !score) return;
    const week = getCurrentWeekKey();
    if (!db.weeklyLeaderboard[week]) db.weeklyLeaderboard[week] = [];
    
    const lb = db.weeklyLeaderboard[week];
    const avatar = db.users.get(odairy)?.avatar || '🎮';
    const idx = lb.findIndex(e => e.odairy === odairy);
    
    if (idx !== -1) {
        if (score > lb[idx].score) lb[idx].score = score;
        lb[idx].username = username;
        lb[idx].nameColor = nameColor;
        lb[idx].isVip = isVip;
        lb[idx].isVVIP = isVVIP;
        lb[idx].avatar = avatar;
    } else {
        lb.push({ odairy, username, score, avatar, nameColor, isVip, isVVIP, lastUpdated: Date.now() });
    }
    
    lb.sort((a, b) => b.score - a.score);
    db.weeklyLeaderboard[week] = lb.slice(0, 100);
}

function updateAllTimeLeaderboard(odairy, username, score, nameColor, isVip, isVVIP) {
    if (!odairy || !score) return;
    const avatar = db.users.get(odairy)?.avatar || '🎮';
    const idx = db.allTimeLeaderboard.findIndex(e => e.odairy === odairy);
    
    if (idx !== -1) {
        if (score > db.allTimeLeaderboard[idx].score) db.allTimeLeaderboard[idx].score = score;
        db.allTimeLeaderboard[idx].username = username;
        db.allTimeLeaderboard[idx].nameColor = nameColor;
        db.allTimeLeaderboard[idx].isVip = isVip;
        db.allTimeLeaderboard[idx].isVVIP = isVVIP;
        db.allTimeLeaderboard[idx].avatar = avatar;
    } else {
        db.allTimeLeaderboard.push({ odairy, username, score, avatar, nameColor, isVip, isVVIP });
    }
    
    db.allTimeLeaderboard.sort((a, b) => b.score - a.score);
    db.allTimeLeaderboard = db.allTimeLeaderboard.slice(0, 500);
}

// ==========================================
// Leaderboard API
// ==========================================

// Current week (default)
app.get('/api/leaderboard', (req, res) => {
    checkNewWeek();
    const week = getCurrentWeekKey();
    const dates = getWeekDates(week);
    res.json({
        week, weekStart: dates.start, weekEnd: dates.end,
        timeUntilReset: getTimeUntilReset(),
        leaderboard: (db.weeklyLeaderboard[week] || []).slice(0, 100)
    });
});

// All-time
app.get('/api/leaderboard/alltime', (req, res) => {
    res.json({ leaderboard: db.allTimeLeaderboard.slice(0, 100) });
});

// Specific week
app.get('/api/leaderboard/week/:weekKey', (req, res) => {
    const { weekKey } = req.params;
    res.json({ week: weekKey, leaderboard: db.weeklyLeaderboard[weekKey] || [] });
});

// User rank
app.get('/api/leaderboard/rank/:odairy', (req, res) => {
    const { odairy } = req.params;
    const week = getCurrentWeekKey();
    const wLb = db.weeklyLeaderboard[week] || [];
    res.json({
        weeklyRank: wLb.findIndex(e => e.odairy === odairy) + 1 || null,
        allTimeRank: db.allTimeLeaderboard.findIndex(e => e.odairy === odairy) + 1 || null,
        weeklyTotal: wLb.length,
        allTimeTotal: db.allTimeLeaderboard.length
    });
});

// Submit score
app.post('/api/leaderboard/submit', (req, res) => {
    const { userId, username, score, avatar, displayName, nameColor, isVip, isVVIP } = req.body;
    const odairy = String(userId);
    checkNewWeek();
    
    updateWeeklyLeaderboard(odairy, displayName || username, score, nameColor, isVip, isVVIP);
    updateAllTimeLeaderboard(odairy, displayName || username, score, nameColor, isVip, isVVIP);
    
    if (avatar) {
        const week = getCurrentWeekKey();
        const we = (db.weeklyLeaderboard[week] || []).find(e => e.odairy === odairy);
        const ae = db.allTimeLeaderboard.find(e => e.odairy === odairy);
        if (we) we.avatar = avatar;
        if (ae) ae.avatar = avatar;
    }
    
    const week = getCurrentWeekKey();
    const rank = (db.weeklyLeaderboard[week] || []).findIndex(e => e.odairy === odairy) + 1;
    res.json({ success: true, weeklyRank: rank, week });
});

// Friends leaderboard
app.get('/api/leaderboard/friends/:odairy', (req, res) => {
    const { odairy } = req.params;
    const friends = db.friends.get(odairy) || [];
    const all = [odairy, ...friends];
    const week = getCurrentWeekKey();
    const lb = (db.weeklyLeaderboard[week] || []).filter(e => all.includes(e.odairy)).slice(0, 50);
    res.json({ leaderboard: lb, week });
});

// History
app.get('/api/leaderboard/history', (req, res) => {
    const weeks = Object.keys(db.weeklyLeaderboard).sort().reverse().slice(0, 10);
    const history = weeks.map(w => ({
        week: w, ...getWeekDates(w),
        winner: db.weeklyLeaderboard[w]?.[0] || null,
        totalPlayers: db.weeklyLeaderboard[w]?.length || 0
    }));
    res.json({ history });
});

// ==========================================
// Username System
// ==========================================

app.get('/api/check-username', (req, res) => {
    const name = (req.query.name || '').toLowerCase().trim();
    res.json({ taken: name.length >= 2 && db.usernames.has(name) });
});

app.post('/api/register-username', (req, res) => {
    const { odairy, username, telegramUsername } = req.body;
    if (!odairy || !username) return res.status(400).json({ error: 'Missing' });
    
    const norm = username.toLowerCase().trim();
    const id = String(odairy);
    
    if (db.usernames.has(norm) && db.usernames.get(norm) !== id) {
        return res.status(400).json({ error: 'Taken' });
    }
    
    if (db.users.has(id)) {
        const old = db.users.get(id).displayName;
        if (old) db.usernames.delete(old.toLowerCase());
        db.users.get(id).displayName = username;
        db.users.get(id).telegramUsername = telegramUsername;
    }
    
    db.usernames.set(norm, id);
    
    // Update leaderboards
    const week = getCurrentWeekKey();
    const we = (db.weeklyLeaderboard[week] || []).find(e => e.odairy === id);
    const ae = db.allTimeLeaderboard.find(e => e.odairy === id);
    if (we) we.username = username;
    if (ae) ae.username = username;
    
    saveData();
    res.json({ success: true });
});

// ==========================================
// Friends System
// ==========================================

app.get('/api/friends/:odairy', (req, res) => {
    const ids = db.friends.get(req.params.odairy) || [];
    const friends = ids.map(id => {
        const u = db.users.get(id);
        if (!u) return null;
        return {
            odairy: id, username: u.displayName || u.username || `Player_${id.slice(-4)}`,
            avatar: u.avatar || '🎮', highScore: u.highScore || 0,
            nameColor: u.nameColor, isVip: u.isVip, online: db.onlineUsers.has(id)
        };
    }).filter(Boolean).sort((a, b) => b.highScore - a.highScore);
    res.json({ friends });
});

app.post('/api/friends/add', (req, res) => {
    const { odairy, friendId } = req.body;
    if (!odairy || !friendId || odairy === friendId) return res.status(400).json({ error: 'Invalid' });
    
    const f1 = db.friends.get(odairy) || [];
    const f2 = db.friends.get(friendId) || [];
    if (!f1.includes(friendId)) { f1.push(friendId); db.friends.set(odairy, f1); }
    if (!f2.includes(odairy)) { f2.push(odairy); db.friends.set(friendId, f2); }
    saveData();
    res.json({ success: true });
});

app.post('/api/referral', (req, res) => {
    const { newUserId, referrerId } = req.body;
    if (!newUserId || !referrerId || newUserId === referrerId) return res.status(400).json({ error: 'Invalid' });
    
    const r = String(referrerId), n = String(newUserId);
    const f1 = db.friends.get(r) || [];
    const f2 = db.friends.get(n) || [];
    if (!f1.includes(n)) { f1.push(n); db.friends.set(r, f1); }
    if (!f2.includes(r)) { f2.push(r); db.friends.set(n, f2); }
    addActivity('referral', { referrerId: r, newUserId: n });
    saveData();
    res.json({ success: true });
});

// ==========================================
// Payments
// ==========================================

const STAR_PACKAGES = [
    { id: 'stars_100', stars: 100, price: 10, bonus: 0 },
    { id: 'stars_500', stars: 500, price: 45, bonus: 50 },
    { id: 'stars_1000', stars: 1000, price: 80, bonus: 200 },
    { id: 'stars_5000', stars: 5000, price: 350, bonus: 1500 }
];

app.get('/api/star-packages', (req, res) => res.json(STAR_PACKAGES));

app.post('/api/buy-stars', async (req, res) => {
    try {
        const { packageId, userId } = req.body;
        const pkg = STAR_PACKAGES.find(p => p.id === packageId);
        if (!pkg) return res.status(400).json({ error: 'Invalid' });
        
        const total = pkg.stars + pkg.bonus;
        const link = await bot.createInvoiceLink(
            `${total} ⭐ Stars`,
            `${pkg.stars} Stars${pkg.bonus ? ` + ${pkg.bonus} Bonus` : ''}`,
            `stars:${packageId}:${userId}`, '', 'XTR',
            [{ label: `${total} Stars`, amount: pkg.price }]
        );
        res.json({ success: true, invoiceLink: link });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Webhook
app.post('/api/webhook', async (req, res) => {
    try {
        const { pre_checkout_query, message } = req.body;
        
        if (pre_checkout_query) {
            await bot.answerPreCheckoutQuery(pre_checkout_query.id, true);
        }
        
        if (message?.successful_payment) {
            const p = message.successful_payment;
            const u = message.from;
            const odairy = String(u.id);
            const name = getDisplayName(odairy, u.username, u.first_name, u.last_name);
            
            db.payments.push({
                odairy, username: name, telegramUsername: u.username,
                firstName: u.first_name, lastName: u.last_name,
                amount: p.total_amount, currency: p.currency,
                item: p.invoice_payload, timestamp: Date.now()
            });
            db.stats.totalRevenue += p.total_amount;
            if (db.users.has(odairy)) db.users.get(odairy).totalSpent += p.total_amount;
            
            if (p.invoice_payload.startsWith('stars:')) {
                const pkg = STAR_PACKAGES.find(x => x.id === p.invoice_payload.split(':')[1]);
                if (pkg) {
                    await bot.sendMessage(u.id, `✅ You received ${pkg.stars + pkg.bonus} ⭐ Stars!`).catch(() => {});
                }
            }
            
            addActivity('payment', { odairy, amount: p.total_amount });
            saveData();
            
            if (ADMIN_TELEGRAM_ID) {
                bot.sendMessage(ADMIN_TELEGRAM_ID, `💰 ${name}: ${p.total_amount} XTR`).catch(() => {});
            }
        }
        
        if (message?.text?.startsWith('/start')) {
            const chatId = message.chat.id;
            const u = message.from;
            const param = message.text.split(' ')[1];
            
            if (param?.startsWith('ref_')) {
                const ref = param.replace('ref_', '');
                if (ref !== String(u.id)) {
                    const f1 = db.friends.get(ref) || [];
                    const f2 = db.friends.get(String(u.id)) || [];
                    if (!f1.includes(String(u.id))) { f1.push(String(u.id)); db.friends.set(ref, f1); }
                    if (!f2.includes(ref)) { f2.push(ref); db.friends.set(String(u.id), f2); }
                    saveData();
                }
            }
            
            await bot.sendMessage(chatId,
                `🍉 Welcome ${u.first_name || 'Player'}!\n\n🏆 Weekly Competition - Top the leaderboard!\n⏰ Resets every Monday`,
                { reply_markup: { inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: WEBAPP_URL } }]] } }
            );
        }
        
        res.sendStatus(200);
    } catch (e) { console.error('[Webhook]', e); res.sendStatus(200); }
});

// ==========================================
// Admin
// ==========================================

function adminAuth(req, res, next) {
    const pw = req.headers['x-admin-password'] || req.query.password;
    if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

app.get('/api/admin/dashboard', adminAuth, (req, res) => {
    cleanupOffline();
    checkNewWeek();
    const week = getCurrentWeekKey();
    const dates = getWeekDates(week);
    const wLb = db.weeklyLeaderboard[week] || [];
    
    res.json({
        stats: {
            onlineUsers: db.onlineUsers.size, totalUsers: db.users.size,
            totalGamesPlayed: db.stats.totalGamesPlayed,
            totalRevenue: db.stats.totalRevenue, totalPayments: db.payments.length
        },
        currentWeek: week, weekStart: dates.start, weekEnd: dates.end,
        timeUntilReset: getTimeUntilReset(),
        onlineUsers: Array.from(db.onlineUsers.values()).sort((a, b) => b.lastSeen - a.lastSeen),
        recentPayments: db.payments.slice(-30).reverse(),
        weeklyLeaderboard: wLb.slice(0, 20),
        allTimeLeaderboard: db.allTimeLeaderboard.slice(0, 20),
        recentActivity: db.activityLog.slice(0, 30),
        serverTime: Date.now()
    });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
    res.json({ users: Array.from(db.users.values()), total: db.users.size });
});

app.post('/api/admin/save', adminAuth, (req, res) => { saveData(); res.json({ success: true }); });

app.post('/api/admin/reset-week', adminAuth, (req, res) => {
    const week = getCurrentWeekKey();
    db.weeklyLeaderboard[week] = [];
    saveData();
    res.json({ success: true, message: `Week ${week} reset` });
});

app.post('/api/admin/reset-all', adminAuth, (req, res) => {
    if (req.body.confirm !== 'RESET_ALL_DATA') return res.status(400).json({ error: 'Confirm required' });
    db.users.clear(); db.usernames.clear(); db.payments.length = 0;
    db.weeklyLeaderboard = {}; db.allTimeLeaderboard = [];
    db.friends.clear(); db.activityLog.length = 0; db.onlineUsers.clear();
    db.stats = { totalUsers: 0, totalGamesPlayed: 0, totalRevenue: 0 };
    saveData();
    res.json({ success: true });
});

app.post('/api/report-cheat', (req, res) => {
    const { odairy, reason } = req.body;
    if (ADMIN_TELEGRAM_ID) bot.sendMessage(ADMIN_TELEGRAM_ID, `⚠️ Cheat: ${odairy} - ${reason}`).catch(() => {});
    res.json({ ok: true });
});

// Start
app.listen(PORT, () => {
    console.log('==========================================');
    console.log(`🍉 Fruit Merge Backend v3.5`);
    console.log(`📅 Week: ${db.currentWeek}`);
    console.log(`👤 Users: ${db.users.size}`);
    console.log(`🚀 Port: ${PORT}`);
    console.log('==========================================');
});
