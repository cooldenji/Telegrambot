const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./db');
const { relayPhoto } = require('./utils/relay');

// In-memory per-chat state machine for multi-step flows (deposit amount, etc.)
// Key: chatId -> { step, data }
const sessions = new Map();

function setSession(chatId, step, data = {}) {
  sessions.set(chatId, { step, data });
}
function getSession(chatId) {
  return sessions.get(chatId);
}
function clearSession(chatId) {
  sessions.delete(chatId);
}

function createUserBot() {
  const bot = new TelegramBot(config.botToken, { polling: true });

  bot.on('polling_error', (err) => console.error('[userBot polling_error]', err.message));

  // ---------- keyboards ----------
  function mainMenuKeyboard() {
    return {
      inline_keyboard: [
        [{ text: '🛒 Buy Product', callback_data: 'menu:buy' }],
        [{ text: '👤 Profile', callback_data: 'menu:profile' }],
        [{ text: '💰 Deposit', callback_data: 'menu:deposit' }],
        [{ text: '🎁 Refer & Earn', callback_data: 'menu:refer' }],
        [{ text: '🏆 Leaderboard', callback_data: 'menu:leaderboard' }],
        [{ text: '📞 Support', callback_data: 'menu:support' }],
      ],
    };
  }

  function backKeyboard(target = 'menu:home') {
    return { inline_keyboard: [[{ text: '⬅️ Back', callback_data: target }]] };
  }

  // ---------- helpers ----------
  function getJoinUrl() {
    return db.getSetting('join_url', config.joinUrl);
  }
  function getJoinUrlName() {
    return db.getSetting('join_url_name', config.joinUrlName);
  }
  function getSupportUsername() {
    return db.getSetting('support_username', config.supportUsername);
  }

  async function isChannelMember(userId) {
    if (!config.channelId) return true; // if not configured, don't block
    try {
      const member = await bot.getChatMember(config.channelId, userId);
      return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (err) {
      console.error('[isChannelMember] error:', err.message);
      return false;
    }
  }

  async function sendVerifyGate(chatId) {
    await bot.sendMessage(
      chatId,
      `Welcome to *Digital Shop Bot* 🛒!\n\nPlease join our channel to unlock the shop.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📢 My Channel', url: getJoinUrl() || 'https://t.me' }],
            [{ text: '✅ I Joined', callback_data: 'verify:check' }],
          ],
        },
      }
    );
  }

  async function sendMainMenu(chatId, prefixText = null) {
    const text =
      prefixText ||
      `✅ *Verified!* Tap below or send /start.\n\n|🛒 *Choose the items you need:*\n❗️ If you have not used our products before, please make a small test purchase first to avoid unnecessary disputes! Thank you for your cooperation|`;
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
    });
  }

  // ---------- /start ----------
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || 'user';
    const payload = match && match[1] ? match[1].trim() : null;

    db.upsertUser(userId, username);

    // Handle referral payload: ref_<referrerId>
    if (payload && payload.startsWith('ref_')) {
      const referrerId = payload.replace('ref_', '');
      if (referrerId && referrerId !== String(userId)) {
        const existingUser = db.getUser(userId);
        // Only create a pending referral for genuinely new users
        if (existingUser && existingUser.deposit_count === 0 && !existingUser.is_verified) {
          db.createPendingReferral(referrerId, userId);
        }
      }
    }

    const user = db.getUser(userId);
    if (user.is_verified) {
      await sendMainMenu(chatId);
      return;
    }

    await sendVerifyGate(chatId);
  });

  // ---------- callback query router ----------
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    try {
      if (data === 'verify:check') return handleVerifyCheck(chatId, userId, query.id);
      if (data === 'menu:home') return sendMainMenu(chatId);
      if (data === 'menu:buy') return handleBuyMenu(chatId);
      if (data.startsWith('buy:product:')) return handleProductDetail(chatId, data);
      if (data.startsWith('buy:confirm:')) return handleBuyConfirm(chatId, userId, query.from, data);
      if (data === 'menu:profile') return handleProfile(chatId, userId);
      if (data === 'menu:deposit') return handleDepositMenu(chatId);
      if (data.startsWith('deposit:method:')) return handleDepositMethodChoice(chatId, data);
      if (data.startsWith('deposit:app:')) return handleDepositAppChoice(chatId, userId, data);
      if (data === 'deposit:paid') return handleDepositPaidPrompt(chatId, userId);
      if (data === 'deposit:cancel') return handleDepositCancel(chatId, userId);
      if (data === 'menu:refer') return handleReferMenu(chatId, userId, query.from);
      if (data === 'menu:leaderboard') return handleLeaderboard(chatId);
      if (data === 'menu:support') return handleSupport(chatId);

      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.error('[callback_query] error:', err.message);
      try {
        await bot.answerCallbackQuery(query.id, { text: 'Something went wrong, try again.' });
      } catch (_) {}
    }
  });

  async function handleVerifyCheck(chatId, userId, callbackId) {
    const member = await isChannelMember(userId);
    if (!member) {
      await bot.answerCallbackQuery(callbackId, {
        text: '❌ You have not joined yet. Please join and tap again.',
        show_alert: true,
      });
      return;
    }
    db.setUserVerified(userId);

    // If this user was referred, mark the referral complete and reward the referrer
    const pending = db.getPendingReferralByReferredId(userId);
    if (pending) {
      db.completeReferral(userId);
      const rewardInr = config.referralRewardInr;
      db.addUserBalance(pending.referrer_id, rewardInr);
      try {
        await bot.sendMessage(
          pending.referrer_id,
          `🎉 Someone joined using your referral link! ₹${rewardInr} has been added to your balance.`
        );
      } catch (_) {
        // referrer may have blocked the bot; ignore
      }
    }

    await bot.answerCallbackQuery(callbackId);
    await sendMainMenu(chatId);
  }

  // ---------- Buy product ----------
  async function handleBuyMenu(chatId) {
    if (!db.isFeatureEnabled('buy')) {
      return bot.sendMessage(chatId, '⚠️ This feature is currently off.', {
        reply_markup: backKeyboard(),
      });
    }
    const products = db.listActiveProducts();
    if (products.length === 0) {
      return bot.sendMessage(chatId, 'No products available right now. Check back soon!', {
        reply_markup: backKeyboard(),
      });
    }
    const buttons = products.map((p) => [
      {
        text: `${p.emoji} ${p.name} | ₹${p.price_inr} | ${p.stock} in stock`,
        callback_data: `buy:product:${p.id}`,
      },
    ]);
    buttons.push([{ text: '⬅️ Back', callback_data: 'menu:home' }]);
    await bot.sendMessage(chatId, '✨ *Select a product*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
  }

  async function handleProductDetail(chatId, data) {
    const productId = parseInt(data.split(':')[2], 10);
    const product = db.getProduct(productId);
    if (!product || !product.is_active) {
      return bot.sendMessage(chatId, 'That product is no longer available.', {
        reply_markup: backKeyboard('menu:buy'),
      });
    }
    const usdt = (product.price_inr / config.usdtToInrRate).toFixed(2);
    const text =
      `${product.emoji} *${product.name}*\n` +
      `💵 ₹${product.price_inr} (~$${usdt})\n` +
      `📦 Stock: ${product.stock}\n` +
      (product.description ? `📝 ${product.description}\n` : '');
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Buy Now', callback_data: `buy:confirm:${product.id}` }],
          [{ text: '⬅️ Back', callback_data: 'menu:buy' }],
        ],
      },
    });
  }

  async function handleBuyConfirm(chatId, userId, from, data) {
    const productId = parseInt(data.split(':')[2], 10);
    const product = db.getProduct(productId);
    const user = db.getUser(userId);

    if (!product || product.stock <= 0) {
      return bot.sendMessage(chatId, '❌ Out of stock.', { reply_markup: backKeyboard('menu:buy') });
    }
    if (user.balance_inr < product.price_inr) {
      return bot.sendMessage(
        chatId,
        `❌ Insufficient balance. You need ₹${product.price_inr}, your balance is ₹${user.balance_inr.toFixed(
          2
        )}. Please deposit first.`,
        { reply_markup: backKeyboard('menu:deposit') }
      );
    }

    const orderId = db.createOrder({ userId, productId, priceInr: product.price_inr });
    db.deductUserBalance(userId, product.price_inr);
    db.decrementStock(productId, 1);

    await bot.sendMessage(
      chatId,
      `⏳ Order placed! Please wait for admin approval to receive your product.`,
      { reply_markup: backKeyboard() }
    );

    // notify admin bot module via event emitter set up in index.js
    if (bot.emitOrderCreated) {
      bot.emitOrderCreated({ orderId, userId, username: from.username || from.first_name, product });
    }
  }

  // ---------- Profile ----------
  async function handleProfile(chatId, userId) {
    const user = db.getUser(userId);
    const usdt = (user.balance_inr / config.usdtToInrRate).toFixed(2);
    const referralCount = db.countCompletedReferrals(userId);
    const text =
      `👤 *Your Profile*\n\n` +
      `💰 Balance: ₹${user.balance_inr.toFixed(2)} (~$${usdt})\n` +
      `📥 Total Deposited: ₹${user.total_deposited_inr.toFixed(2)}\n` +
      `🔁 Deposits Made: ${user.deposit_count}\n` +
      `🎁 Successful Referrals: ${referralCount}`;
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: backKeyboard(),
    });
  }

  // ---------- Deposit flow ----------
  async function handleDepositMenu(chatId) {
    if (!db.isFeatureEnabled('deposit')) {
      return bot.sendMessage(chatId, '⚠️ This feature is currently off.', {
        reply_markup: backKeyboard(),
      });
    }
    await bot.sendMessage(chatId, 'Choose a deposit method:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 UPI QR CODE / ID', callback_data: 'deposit:method:upi' }],
          [{ text: '💳 Binance Pay (USDT)', callback_data: 'deposit:method:binance' }],
          [{ text: '⬅️ Back', callback_data: 'menu:home' }],
        ],
      },
    });
  }

  async function handleDepositMethodChoice(chatId, data) {
    const method = data.split(':')[2]; // upi | binance
    if (method === 'upi') {
      await bot.sendMessage(chatId, 'Choose your UPI app:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📱 GPay', callback_data: 'deposit:app:gpay' }],
            [{ text: '💳 Fam Pay', callback_data: 'deposit:app:fampay' }],
            [{ text: '🗃️ Any UPI', callback_data: 'deposit:app:anyupi' }],
            [{ text: '⬅️ Back', callback_data: 'menu:deposit' }],
          ],
        },
      });
    } else {
      await bot.sendMessage(chatId, 'Choose your deposit app:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Binance Pay', callback_data: 'deposit:app:binance' }],
            [{ text: '⬅️ Back', callback_data: 'menu:deposit' }],
          ],
        },
      });
    }
  }

  async function handleDepositAppChoice(chatId, userId, data) {
    const app = data.split(':')[2]; // gpay | fampay | anyupi | binance
    setSession(chatId, 'awaiting_deposit_amount', { app });

    let intro = '';
    if (app === 'binance') {
      const binanceId = db.getSetting('binance_id', 'Not set yet');
      const binanceName = db.getSetting('binance_name', 'Not set yet');
      intro = `💳 *Binance Pay*\n━━━━━━━━━━━━━━━━━━━━\nID: \`${binanceId}\`\nName: ${binanceName}\n`;
    } else {
      const qrFileId = db.getSetting(`upi_${app}_qr_file_id`);
      const upiId = db.getSetting(`upi_${app}_id`, 'Not set yet');
      if (qrFileId) {
        await bot.sendPhoto(chatId, qrFileId, { caption: `UPI ID: \`${upiId}\``, parse_mode: 'Markdown' });
      }
      intro = `📱 *UPI Payment*\n━━━━━━━━━━━━━━━━━━━━\n✅ Minimum: ₹20\n⚠️ Manual verification after screenshot\nUPI ID: \`${upiId}\`\n`;
    }

    await bot.sendMessage(chatId, `${intro}\nEnter amount in ₹ (minimum ₹20):`, {
      parse_mode: 'Markdown',
    });
  }

  async function handleDepositPaidPrompt(chatId, userId) {
    await bot.sendMessage(chatId, '📸 Please send the payment screenshot now.', {
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel Order', callback_data: 'deposit:cancel' }]] },
    });
  }

  async function handleDepositCancel(chatId, userId) {
    clearSession(chatId);
    await bot.sendMessage(chatId, 'Deposit cancelled.', { reply_markup: backKeyboard() });
  }

  // ---------- Refer & Earn ----------
  async function handleReferMenu(chatId, userId, from) {
    const botUsername = (await bot.getMe()).username;
    const link = `https://t.me/${botUsername}?start=ref_${userId}`;
    const count = db.countCompletedReferrals(userId);
    await bot.sendMessage(
      chatId,
      `🎁 *Refer & Earn*\n\nShare your link, earn ₹${config.referralRewardInr} per verified join!\n\n🔗 ${link}\n\n✅ Successful referrals: ${count}`,
      { parse_mode: 'Markdown', reply_markup: backKeyboard() }
    );
  }

  // ---------- Leaderboard ----------
  async function handleLeaderboard(chatId) {
    const depositors = db.topDepositors(10);
    const referrers = db.topReferrers(10);

    let text = '🏆 *Leaderboard*\n\n💰 *Top Depositors*\n';
    if (depositors.length === 0) text += 'No data yet.\n';
    depositors.forEach((d, i) => {
      text += `${i + 1}. ${d.username || d.user_id} — ₹${d.total_deposited_inr.toFixed(2)}\n`;
    });

    text += '\n🎁 *Top Referrers*\n';
    if (referrers.length === 0) text += 'No data yet.\n';
    referrers.forEach((r, i) => {
      text += `${i + 1}. ${r.user_id} — ${r.referral_count} referrals\n`;
    });

    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: backKeyboard() });
  }

  // ---------- Support ----------
  async function handleSupport(chatId) {
    const username = getSupportUsername();
    await bot.sendMessage(
      chatId,
      `📞 *Support*\n\nNeed help? Contact: @${username || 'support'}`,
      { parse_mode: 'Markdown', reply_markup: backKeyboard() }
    );
  }

  // ---------- text/photo messages for multi-step flows ----------
  bot.on('message', async (msg) => {
    if (!msg.text && !msg.photo) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const session = getSession(chatId);
    if (!session) return;

    if (session.step === 'awaiting_deposit_amount' && msg.text) {
      const amount = parseFloat(msg.text.trim());
      if (isNaN(amount) || amount < 20) {
        return bot.sendMessage(chatId, '❌ Please enter a valid amount (minimum ₹20).');
      }
      setSession(chatId, 'awaiting_deposit_screenshot', { app: session.data.app, amount });
      await bot.sendMessage(
        chatId,
        `Amount: ₹${amount}\n\nOnce you've paid, tap "I have paid" and send the screenshot.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ I have paid', callback_data: 'deposit:paid' }],
              [{ text: '❌ Cancel order', callback_data: 'deposit:cancel' }],
            ],
          },
        }
      );
      return;
    }

    if (session.step === 'awaiting_deposit_screenshot' && msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const { app, amount } = session.data;
      const depositId = db.createDeposit({
        userId,
        amountInr: amount,
        method: app,
        screenshotFileId: fileId,
      });
      clearSession(chatId);

      await bot.sendMessage(chatId, '⏳ Wait a few minutes for admin approval.');

      if (bot.emitDepositCreated) {
        bot.emitDepositCreated({
          depositId,
          userId,
          username: msg.from.username || msg.from.first_name,
          amount,
          method: app,
          userBotFileId: fileId,
        });
      }
      return;
    }
  });

  return { bot, sessions, relayPhoto };
}

module.exports = { createUserBot };
