// ==========================================
// Fruit Merge Game - Backend Server
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
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-game.vercel.app';

// Validate bot token
if (!BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN is not set in environment variables!');
    console.error('Please set BOT_TOKEN in your .env file or environment');
    process.exit(1);
}

// Initialize bot (webhook mode for production)
const bot = new TelegramBot(BOT_TOKEN);

// ==========================================
// Middleware
// ==========================================

app.use(cors({
    origin: '*',  // In production, set to your game URL
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Request logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ==========================================
// In-Memory Storage (Use database in production)
// ==========================================

const leaderboard = [];
const userPurchases = {};  // { odairy: { revive: 5, ... } }
const referrals = {};      // { odairy: { count: 0, earnings: 0 } }

// ==========================================
// Health Check
// ==========================================

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Fruit Merge Backend is running',
        version: '1.0.0'
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// ==========================================
// Telegram Webhook
// ==========================================

app.post('/api/webhook', async (req, res) => {
    try {
        const update = req.body;

        // Handle pre-checkout query (approve payment)
        if (update.pre_checkout_query) {
            console.log('[Payment] Pre-checkout query received:', update.pre_checkout_query.id);

            await bot.answerPreCheckoutQuery(update.pre_checkout_query.id, true);
            console.log('[Payment] Pre-checkout approved');
        }

        // Handle successful payment
        if (update.message?.successful_payment) {
            const payment = update.message.successful_payment;
            const userId = update.message.from.id;

            console.log('[Payment] Successful payment:', {
                odairy: userId,
                amount: payment.total_amount,
                payload: payment.invoice_payload
            });

            // Grant the purchased item
            grantPurchase(userId, payment.invoice_payload);
        }

        // Handle /start command
        if (update.message?.text?.startsWith('/start')) {
            const chatId = update.message.chat.id;
            const startParam = update.message.text.split(' ')[1];  // Referral code

            await bot.sendMessage(chatId,
                '🍉 Welcome to Fruit Merge!\n\n' +
                'Tap the button below to play:',
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🎮 Play Now', web_app: { url: WEBAPP_URL } }
                        ]]
                    }
                }
            );

            // Process referral if present
            if (startParam) {
                processReferral(startParam, update.message.from.id);
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('[Webhook] Error:', error);
        res.sendStatus(200);  // Always return 200 to Telegram
    }
});

// ==========================================
// Payment Endpoints
// ==========================================

// Create invoice link for Telegram Stars payment
app.post('/api/create-invoice', async (req, res) => {
    try {
        const { itemId, title, description, price, userId } = req.body;

        console.log('[Invoice] Creating invoice:', { itemId, title, price, userId });

        const invoiceLink = await bot.createInvoiceLink(
            title,                    // Product title
            description,              // Product description
            `${itemId}:${userId}`,    // Payload (to identify purchase)
            '',                       // Provider token (empty for Stars)
            'XTR',                    // Currency (XTR = Telegram Stars)
            [{ label: title, amount: price }]  // Price
        );

        console.log('[Invoice] Created:', invoiceLink);

        res.json({
            success: true,
            invoiceLink
        });
    } catch (error) {
        console.error('[Invoice] Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Grant purchase to user
function grantPurchase(userId, payload) {
    const [itemId] = payload.split(':');

    if (!userPurchases[userId]) {
        userPurchases[userId] = {};
    }

    userPurchases[userId][itemId] = (userPurchases[userId][itemId] || 0) + 1;

    console.log('[Purchase] Granted:', { userId, itemId, total: userPurchases[userId][itemId] });
}

// Get user's purchases
app.get('/api/purchases/:userId', (req, res) => {
    const userId = req.params.userId;
    res.json(userPurchases[userId] || {});
});

// ==========================================
// Leaderboard Endpoints
// ==========================================

// Submit score
app.post('/api/leaderboard/submit', (req, res) => {
    try {
        const { odairy, username, score, avatar } = req.body;

        // Find existing entry
        const existingIndex = leaderboard.findIndex(e => e.odairy === odairy);

        if (existingIndex !== -1) {
            // Update if new score is higher
            if (score > leaderboard[existingIndex].score) {
                leaderboard[existingIndex].score = score;
                leaderboard[existingIndex].username = username;
                leaderboard[existingIndex].updatedAt = Date.now();
            }
        } else {
            // Add new entry
            leaderboard.push({
                odairy,
                username: username || 'Player',
                score,
                avatar: avatar || '🎮',
                createdAt: Date.now(),
                updatedAt: Date.now()
            });
        }

        // Sort by score (highest first)
        leaderboard.sort((a, b) => b.score - a.score);

        // Find user's rank
        const rank = leaderboard.findIndex(e => e.odairy === odairy) + 1;

        res.json({
            success: true,
            rank,
            totalPlayers: leaderboard.length
        });
    } catch (error) {
        console.error('[Leaderboard] Submit error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get leaderboard
app.get('/api/leaderboard', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const type = req.query.type || 'global';

    let data = leaderboard.slice(0, limit);

    // For weekly, filter by date (last 7 days)
    if (type === 'weekly') {
        const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        data = leaderboard
            .filter(e => e.updatedAt > weekAgo)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    res.json(data);
});

// Get user's rank
app.get('/api/leaderboard/rank/:userId', (req, res) => {
    const userId = req.params.userId;
    const rank = leaderboard.findIndex(e => e.odairy === userId) + 1;
    const entry = leaderboard.find(e => e.odairy === userId);

    res.json({
        rank: rank || null,
        score: entry?.score || 0,
        totalPlayers: leaderboard.length
    });
});

// ==========================================
// Referral Endpoints
// ==========================================

// Process referral
function processReferral(referrerId, newUserId) {
    // Don't process self-referral
    if (referrerId === newUserId.toString()) return;

    if (!referrals[referrerId]) {
        referrals[referrerId] = { count: 0, earnings: 0 };
    }

    referrals[referrerId].count++;
    referrals[referrerId].earnings += 50;  // 50 stars per referral

    console.log('[Referral] Processed:', { referrerId, newUserId, total: referrals[referrerId] });
}

// Get referral stats
app.get('/api/referral/:userId', (req, res) => {
    const userId = req.params.userId;
    res.json(referrals[userId] || { count: 0, earnings: 0 });
});

// ==========================================
// Validate Telegram Init Data (Security)
// ==========================================

const crypto = require('crypto');

function validateInitData(initData) {
    if (!initData) return false;

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    // Sort parameters
    const dataCheckString = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    // Create secret key
    const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(BOT_TOKEN)
        .digest();

    // Calculate hash
    const calculatedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    return calculatedHash === hash;
}

// Validation middleware (use for sensitive endpoints)
function authMiddleware(req, res, next) {
    const initData = req.headers['x-telegram-init-data'];

    if (!initData || !validateInitData(initData)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

// ==========================================
// Start Server
// ==========================================

app.listen(PORT, () => {
    console.log('==========================================');
    console.log(`🍉 Fruit Merge Backend`);
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 WebApp URL: ${WEBAPP_URL}`);
    console.log('==========================================');
});

// Export for testing
module.exports = app;