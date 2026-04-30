const TelegramBot = require('node-telegram-bot-api');
const trading = require('./trading'); // We'll need this to trigger buys
const logger = require('./lib/logger');
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot = null;

if (token && chatId) {
    // Enable polling so the bot can receive messages
    bot = new TelegramBot(token, { polling: true });
    logger.info({ component: 'Telegram' }, 'Bot initialized with polling.');

    // Handle /buy [tokenAddress] [amount?]
    bot.onText(/\/buy (.+)/, async (msg, match) => {
        const fromId = msg.chat.id.toString();
        if (fromId !== chatId) {
            return bot.sendMessage(fromId, "❌ Unauthorized. This bot is private.");
        }

        const input = match[1].split(' ');
        const tokenAddress = input[0];
        const amount = input[1] ? parseFloat(input[1]) : undefined;

        await bot.sendMessage(chatId, `⏳ *Initiating Buy...*\nToken: \`${tokenAddress}\`\nAmount: ${amount || 'Default'} SOL`);

        try {
            const txid = await trading.buyToken(tokenAddress, amount);
            await bot.sendMessage(chatId, `✅ *Buy Executed!*\nTX: [View on Solscan](https://solscan.io/tx/${txid})\nAuto-sell target: +100%`, { parse_mode: 'Markdown' });
        } catch (err) {
            await bot.sendMessage(chatId, `❌ *Buy Failed*\nError: ${err.message}`);
        }
    });

    bot.on('message', (msg) => {
        if (msg.text === '/start') {
            bot.sendMessage(msg.chat.id, "🤖 Wallet Token Tracker Bot Active.\nCommands:\n/buy <address> <amount?> - Buy a token");
        }
    });

} else {
    logger.warn({ component: 'Telegram' }, 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing in .env');
}

const sendMessage = async (message) => {
    if (!bot || !chatId) return;
    try {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        logger.debug({ component: 'Telegram' }, 'Message sent.');
    } catch (err) {
        logger.error({ component: 'Telegram' }, `Error sending message: ${err.message}`);
    }
};

module.exports = { sendMessage };
