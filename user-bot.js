// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// user-bot.js — CLOUDE CART 🛒 | Customer-Facing Bot
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const h  = require('./helpers');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_NOTIFY_CHAT_ID = process.env.ADMIN_NOTIFY_CHAT_ID;
const OWNER_ID             = process.env.OWNER_ID;
const REFERRAL_REWARD_INR  = Number(process.env.REFERRAL_REWARD_INR) || 10;

// Export for helpers cross-bot relay setup (called from admin-bot.js)
module.exports = { bot };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS — edit-in-place (reduce chat spam)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function edit(chatId, msgId, text, opts = {}) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', ...opts });
  } catch (_) {
    // message might not have changed — ignore
  }
}

async function send(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JOIN GATE — verify user has joined all required links
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function checkJoined(userId) {
  const links = db.getDb().settings.joinLinks.filter(l => l.enabled);
  for (const link of links) {
    // Extract @channelusername from URL
    const match = link.url.match(/t\.me\/([^/?]+)/);
    if (!match) continue;
    const handle = '@' + match[1];
    try {
      const member = await bot.getChatMember(handle, userId);
      if (['left', 'kicked'].includes(member.status)) return false;
    } catch (_) {
      // Can't check — skip (bot may not be admin there)
    }
  }
  return true;
}

async function showJoinGate(chatId, msgId = null) {
  const db_ = db.getDb();
  const links = db_.settings.joinLinks.filter(l => l.enabled);

  const text = `👋 <b>Welcome to CLOUDE CART BOT 🛒!</b>\n\n🔒 Please join to use the bot:\n\n${links.map(l => `📣 ${l.name}`).join('\n')}\n\nTap the buttons below then press ✅`;

  const keyboard = [
    ...links.map(l => [{ text: l.name, url: l.url }]),
    [{ text: '✅ I Joined', callback_data: 'check_join' }],
  ];

  const opts = { reply_markup: { inline_keyboard: keyboard } };
  if (msgId) return edit(chatId, msgId, text, opts);
  return send(chatId, text, opts);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN MENU
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showMainMenu(chatId, msgId = null, isNew = false) {
  const db_      = db.getDb();
  const features = db_.settings.features;

  let text = '';
  if (isNew) {
    text = `🛒 <b>Choose the items you need:</b>\n\n❗️ If you have not used our products before, please make a small test purchase first to avoid unnecessary disputes! Thank you for your cooperation`;
  } else {
    text = `🛒 <b>CLOUDE CART</b> — Choose an option:`;
  }

  const row1 = [];
  const row2 = [];
  const row3 = [];

  if (features.buyAccount)  row1.push({ text: '🛒 Buy Account',  callback_data: 'buy_account' });
  if (features.buySession)  row1.push({ text: '📂 Buy Sessions', callback_data: 'buy_session' });
  if (features.deposit)     row2.push({ text: '👤 Profile',      callback_data: 'profile' });
  if (features.deposit)     row2.push({ text: '💰 Deposit',      callback_data: 'deposit' });
  if (features.referEarn)   row3.push({ text: '🎁 Refer & Earn', callback_data: 'refer_earn' });
  if (features.support)     row3.push({ text: '📞 Support',      callback_data: 'support' });

  const keyboard = [row1, row2, row3].filter(r => r.length > 0);
  const opts = { reply_markup: { inline_keyboard: keyboard } };
  if (msgId) return edit(chatId, msgId, text, opts);
  return send(chatId, text, opts);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// /start COMMAND
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const userId  = String(msg.from.id);
  const payload = (match[1] || '').trim();

  if (db.isBanned(userId)) {
    return send(chatId, '🚫 You have been banned from this bot.');
  }

  // Ensure user record exists
  const user = db.getUser(userId);
  db.updateUser(userId, {
    username:  msg.from.username  || user.username,
    firstName: msg.from.first_name || user.firstName,
  });

  // Referral payload: ref_12345
  const isNew = !user.joinedAt || (Date.now() - user.joinedAt < 5000);
  if (payload.startsWith('ref_') && !db.hasBeenReferred(userId)) {
    const referrerId = payload.replace('ref_', '');
    if (referrerId !== userId) {
      db.createReferral(referrerId, userId, REFERRAL_REWARD_INR);
    }
  }

  const joined = await checkJoined(userId);
  if (!joined) return showJoinGate(chatId);

  // Complete referral if pending
  const ref = db.completeReferral(userId);
  if (ref) {
    try {
      const referrer = db.getUser(ref.referrerId);
      await send(ref.referrerId,
        `🎁 <b>Referral Reward!</b>\nSomeone you referred just joined!\n+₹${ref.rewardAmount} added to your balance.\n💰 New balance: ${h.formatBalance(referrer.balance)}`
      );
    } catch (_) {}
  }

  await showMainMenu(chatId, null, isNew);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUY ACCOUNT — product listing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showBuyAccount(chatId, msgId) {
  const db_  = db.getDb();
  const rate = db_.settings.usdtToInrRate;
  const products = db.listProducts(false).filter(p => p.stock > 0);

  if (!products.length) {
    return edit(chatId, msgId,
      `📦 <b>No accounts in stock right now.</b>\n\nTap 🔔 Notify Me on a product to get alerted when it restocks!`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]] } }
    );
  }

  // Flash sale check
  const fs = db_.settings.flashSale;
  let flashText = '';
  if (fs.active && fs.endsAt) {
    const timeLeft = h.flashSaleTimeLeft(fs.endsAt);
    if (timeLeft) flashText = `\n🔥 <b>Flash Sale!</b> Ends in <code>${timeLeft}</code>\n`;
    else { db_.settings.flashSale.active = false; db.saveDb(); }
  }

  const text = `✨ <b>Select Account</b>\n⚡ Rate: 1 USDT = ₹${rate}${flashText}\n\n` +
    products.map(p => h.formatProduct(p, rate)).join('\n');

  const keyboard = products.map(p => [{
    text: `${p.emoji || '📦'} ₹${p.price}`,
    callback_data: `product_${p.id}`,
  }]);
  keyboard.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);

  return edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ── Product detail + confirm ───────────────────────────
async function showProductDetail(chatId, msgId, productId) {
  const p = db.getProduct(productId);
  if (!p || p.stock < 1) {
    return edit(chatId, msgId, `❌ Product not available or out of stock.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: p?.sessionMode ? 'buy_session' : 'buy_account' }]] }
    });
  }

  const rate = db.getDb().settings.usdtToInrRate;
  const usd  = (p.price / rate).toFixed(2);
  const desc = p.description ? `\n\n📝 ${p.description}` : '';

  const text = `${p.emoji || '📦'} <b>${p.name}</b>\n\n💵 Price: $${usd} • ₹${p.price}\n📦 In Stock: ${p.stock}${desc}\n\n⚠️ Please confirm your purchase:`;

  const keyboard = [
    [
      { text: '✅ Buy Now', callback_data: `confirm_buy_${productId}` },
      { text: '❌ Cancel',  callback_data: p.sessionMode ? 'buy_session' : 'buy_account' },
    ],
    [{ text: '🔙 Back', callback_data: p.sessionMode ? 'buy_session' : 'buy_account' }],
  ];

  return edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ── Confirm purchase ───────────────────────────────────
async function confirmPurchase(chatId, msgId, userId, productId) {
  const p    = db.getProduct(productId);
  const user = db.getUser(userId);

  if (!p || p.stock < 1) {
    return edit(chatId, msgId, `❌ Sorry, this item just went out of stock.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'buy_account' }]] }
    });
  }

  if (user.balance < p.price) {
    const short = p.price - user.balance;
    return edit(chatId, msgId,
      `💰 <b>Insufficient Balance</b>\n\nYou need ₹${short.toFixed(2)} more.\nCurrent balance: ${h.formatBalance(user.balance)}`,
      { reply_markup: { inline_keyboard: [
        [{ text: '💳 Deposit Now', callback_data: 'deposit' }],
        [{ text: '🔙 Back',       callback_data: 'buy_account' }],
      ]}}
    );
  }

  // Deduct balance + reduce stock
  db.updateUser(userId, { balance: user.balance - p.price });
  db.updateProduct(productId, { stock: p.stock - 1 });
  const order = db.createOrder({ userId, productId, quantity: 1, totalPrice: p.price });

  // Notify user
  await edit(chatId, msgId,
    `✅ <b>Order Placed!</b>\n\n📦 ${p.name}\n💸 ₹${p.price} deducted\n💰 Remaining: ${h.formatBalance(user.balance - p.price)}\n\n⏳ <b>Waiting for admin to deliver your product.</b>`,
    { reply_markup: { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'main_menu' }]] } }
  );

  // Notify admin bot
  const rate = db.getDb().settings.usdtToInrRate;
  const usd  = (p.price / rate).toFixed(2);
  const adminText =
    `🛒 <b>NEW ORDER — Customer Waiting</b>\n\n` +
    `👤 User: ${user.username ? '@' + user.username : user.firstName || 'Unknown'} (${userId})\n` +
    `📦 Product: ${p.emoji || ''} ${p.name}\n` +
    `💰 Price: ₹${p.price} ($${usd})\n` +
    `💼 User Balance (after): ${h.formatBalance(user.balance - p.price)}\n` +
    `📋 Order ID: #${order.id}`;

  try {
    await h._adminBot.sendMessage(ADMIN_NOTIFY_CHAT_ID, adminText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '✉️ Message User', url: `tg://user?id=${userId}` },
        { text: '✅ Mark Delivered', callback_data: `deliver_${order.id}` },
      ]]}
    });
  } catch (err) {
    console.error('[ORDER NOTIFY] Admin notify failed:', err.message);
  }

  // Notify queue for out-of-stock now
  if (p.stock - 1 === 0) {
    // do nothing — was already in stock
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUY SESSION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showBuySession(chatId, msgId) {
  const db_  = db.getDb();
  const rate = db_.settings.usdtToInrRate;
  const products = db.listProducts(true).filter(p => p.stock > 0);

  if (!products.length) {
    return edit(chatId, msgId,
      `📂 <b>No sessions in stock right now.</b>`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]] } }
    );
  }

  const text = `📂 <b>Buy Sessions</b>\n⚡ Rate: 1 USDT = ₹${rate}\n\nSelect a session package:\n\n` +
    products.map(p => h.formatProduct(p, rate)).join('\n');

  const keyboard = products.map(p => [{
    text: `${p.emoji || '📂'} ₹${p.price} — ${p.name}`,
    callback_data: `product_${p.id}`,
  }]);
  keyboard.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);

  return edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROFILE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showProfile(chatId, msgId, userId) {
  const user = db.getUser(userId);
  const rate = db.getDb().settings.usdtToInrRate;
  const usd  = (user.balance / rate).toFixed(2);

  const text =
    `👤 <b>Your Profile</b>\n\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `👤 Name: ${user.firstName || 'Unknown'}\n` +
    `💰 Balance: ₹${user.balance.toFixed(2)} ($${usd})\n` +
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n` +
    `🔁 Deposit Count: ${user.depositCount}\n` +
    `🎁 Referrals: ${user.referralCount} (₹${user.referralEarned.toFixed(2)} earned)\n` +
    `📅 Joined: ${new Date(user.joinedAt).toLocaleDateString()}`;

  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [
      [
        { text: '🏆 Deposit Board', callback_data: 'leaderboard_deposit' },
        { text: '🎁 Refer Board',   callback_data: 'leaderboard_referral' },
      ],
      [{ text: '🔙 Back', callback_data: 'main_menu' }],
    ]}
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LEADERBOARD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showLeaderboard(chatId, msgId, type) {
  const list = type === 'deposit'
    ? db.getDepositLeaderboard(10)
    : db.getReferralLeaderboard(10);

  const title = type === 'deposit' ? '💰 Top Depositors' : '🎁 Top Referrers';
  const valueKey = type === 'deposit' ? 'totalDeposited' : 'referralCount';
  const unit     = type === 'deposit' ? '₹' : 'refs';

  const lines = list.map((u, i) => {
    const display = u.username ? `@${u.username}` : (u.firstName || `User ${u.userId}`);
    const val = type === 'deposit' ? `₹${u[valueKey].toFixed(2)}` : `${u[valueKey]} ${unit}`;
    return `${h.medal(i)} ${display} — ${val}`;
  });

  const text = `🏆 <b>${title}</b>\n\n${lines.join('\n') || 'No data yet.'}`;

  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [
      [
        { text: '💰 Deposit Board', callback_data: 'leaderboard_deposit' },
        { text: '🎁 Refer Board',   callback_data: 'leaderboard_referral' },
      ],
      [{ text: '🔙 Back', callback_data: 'profile' }],
    ]}
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REFER & EARN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showReferEarn(chatId, msgId, userId) {
  const botInfo = await bot.getMe();
  const link    = `https://t.me/${botInfo.username}?start=ref_${userId}`;
  const user    = db.getUser(userId);

  const text =
    `🎁 <b>Refer & Earn</b>\n\n` +
    `Share your referral link and earn <b>₹${REFERRAL_REWARD_INR}</b> for every new user who joins!\n\n` +
    `🔗 Your Link:\n<code>${link}</code>\n\n` +
    `👥 Total Referrals: ${user.referralCount}\n` +
    `💵 Total Earned: ₹${user.referralEarned.toFixed(2)}`;

  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]] }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SUPPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showSupport(chatId, msgId) {
  const supportUsername = db.getDb().settings.supportUsername;
  const text = `📞 <b>Support</b>\n\nFor help, contact our support team directly:`;
  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [
      [{ text: '💬 Contact Support', url: `https://t.me/${supportUsername}` }],
      [{ text: '🔙 Back', callback_data: 'main_menu' }],
    ]}
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEPOSIT FLOW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showDeposit(chatId, msgId) {
  const db_    = db.getDb();
  const pay    = db_.settings.payments;
  const minDep = db_.settings.minDepositInr;

  if (!db_.settings.features.deposit) {
    return edit(chatId, msgId, `🚫 Deposits are currently disabled.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]] }
    });
  }

  const text = `💰 <b>Deposit</b>\n\n✅ Minimum: ₹${minDep}\n⚠️ Manual verification after screenshot\n\nChoose payment method:`;

  const keyboard = [];
  if (pay.gpay.enabled || pay.fampay.enabled || pay.anyupi.enabled) {
    keyboard.push([{ text: '📱 UPI Payment', callback_data: 'deposit_upi' }]);
  }
  if (pay.binance.enabled) {
    keyboard.push([{ text: '💳 Binance Pay (USDT)', callback_data: 'deposit_binance' }]);
  }
  keyboard.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);

  return edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showUpiOptions(chatId, msgId) {
  const pay = db.getDb().settings.payments;
  const text = `📱 <b>UPI Payment</b>\n\nChoose your UPI app:`;

  const keyboard = [];
  if (pay.gpay.enabled)   keyboard.push([{ text: '📱 G Pay',   callback_data: 'dep_gpay' }]);
  if (pay.fampay.enabled) keyboard.push([{ text: '💳 Fam Pay', callback_data: 'dep_fampay' }]);
  if (pay.anyupi.enabled) keyboard.push([{ text: '🗃️ Any UPI', callback_data: 'dep_anyupi' }]);
  keyboard.push([{ text: '🔙 Back', callback_data: 'deposit' }]);

  return edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showUpiQr(chatId, msgId, userId, method) {
  const db_    = db.getDb();
  const pay    = db_.settings.payments[method];
  const minDep = db_.settings.minDepositInr;

  if (!pay || !pay.enabled) {
    return edit(chatId, msgId, `🚫 This payment method is currently disabled.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'deposit_upi' }]] }
    });
  }

  const methodNames = { gpay: 'G Pay', fampay: 'Fam Pay', anyupi: 'Any UPI' };
  const text = `💳 Enter amount in ₹ (minimum ₹${minDep}):`;

  // Show QR if exists
  if (pay.qrFileId) {
    try {
      await bot.deleteMessage(chatId, msgId);
    } catch (_) {}
    const caption = `📱 <b>${methodNames[method]}</b>\n━━━━━━━━━━━━━━━━━━━━\n✅ Minimum: ₹${minDep}\n${pay.upiId ? `🆔 UPI ID: <code>${pay.upiId}</code>` : ''}\n${pay.upiName ? `👤 Name: ${pay.upiName}` : ''}`;
    const sent = await bot.sendPhoto(chatId, pay.qrFileId, {
      caption,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '🔙 Back', callback_data: 'deposit_upi' }],
      ]}
    });
    h.setUserState(userId, 'awaiting_deposit_amount', { method, qrMsgId: sent.message_id });
    return send(chatId, text);
  }

  // No QR — show ID only
  const idText = pay.upiId
    ? `📱 <b>${methodNames[method]}</b>\n━━━━━━━━━━━━━━━━━━━━\n✅ Minimum: ₹${minDep}\n🆔 UPI ID: <code>${pay.upiId}</code>\n👤 Name: ${pay.upiName || ''}\n\n${text}`
    : `📱 <b>${methodNames[method]}</b>\n\n⚠️ No QR or ID set by admin yet.`;

  h.setUserState(userId, 'awaiting_deposit_amount', { method });
  return edit(chatId, msgId, idText, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'deposit_upi' }]] }
  });
}

async function showBinancePay(chatId, msgId, userId) {
  const db_    = db.getDb();
  const pay    = db_.settings.payments.binance;
  const minDep = db_.settings.minDepositInr;
  const rate   = db_.settings.usdtToInrRate;
  const minUsd = (minDep / rate).toFixed(2);

  if (!pay.enabled) {
    return edit(chatId, msgId, `🚫 Binance Pay is currently disabled.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'deposit' }]] }
    });
  }

  const text =
    `💳 <b>Binance Pay (USDT)</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Minimum: $${minUsd} USDT\n` +
    `${pay.binanceId ? `🆔 Binance ID: <code>${pay.binanceId}</code>` : ''}\n` +
    `${pay.binanceName ? `👤 Name: ${pay.binanceName}` : ''}\n\n` +
    `Enter amount in ₹ (we'll show USDT equivalent):`;

  h.setUserState(userId, 'awaiting_deposit_amount', { method: 'binance' });
  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'deposit' }]] }
  });
}

// ── After user types amount ────────────────────────────
async function handleDepositAmount(msg, state) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const amount = parseFloat(msg.text);
  const minDep = db.getDb().settings.minDepositInr;

  if (isNaN(amount) || amount < minDep) {
    return send(chatId, `⚠️ Please enter a valid amount (minimum ₹${minDep}):`);
  }

  h.setUserState(userId, 'awaiting_screenshot', {
    method: state.data.method,
    amount,
  });

  const rate = db.getDb().settings.usdtToInrRate;
  const usd  = (amount / rate).toFixed(2);

  await send(chatId,
    `💰 Amount: ₹${amount} ($${usd} USDT)\n\n📸 Please send your payment screenshot now:`,
    { reply_markup: { inline_keyboard: [
      [{ text: '❌ Cancel Order', callback_data: 'deposit' }],
    ]}}
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHOTO HANDLER — payment screenshot
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const state  = h.getUserState(userId);

  if (!state || state.state !== 'awaiting_screenshot') return;
  h.clearUserState(userId);

  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const { method, amount } = state.data;
  const rate = db.getDb().settings.usdtToInrRate;
  const usd  = (amount / rate).toFixed(2);
  const user = db.getUser(userId);

  // Save deposit (User-Bot file_id first — reliable fallback)
  const deposit = db.createDeposit({
    userId, amount, method,
    screenshotFileId: fileId,
    screenshotFileIdAdmin: null,
  });

  await send(chatId,
    `✅ Screenshot received!\n\n💰 Amount: ₹${amount} ($${usd})\n📋 Deposit ID: #${deposit.id}\n\n⏳ <b>Please wait a few minutes for admin approval.</b>`,
    { reply_markup: { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'main_menu' }]] } }
  );

  // Relay screenshot to Admin Bot
  const adminFileId = await h.relayPhotoToAdmin(fileId, ADMIN_NOTIFY_CHAT_ID);
  if (adminFileId) {
    db.updateDeposit(deposit.id, { screenshotFileIdAdmin: adminFileId });
  }

  // Admin notification
  const adminText =
    `💰 <b>NEW DEPOSIT REQUEST</b>\n\n` +
    `👤 User: ${user.username ? '@' + user.username : user.firstName || 'Unknown'} (<code>${userId}</code>)\n` +
    `💵 Amount: ₹${amount} ($${usd} USDT)\n` +
    `💳 Method: ${method.toUpperCase()}\n` +
    `💼 Current Balance: ${h.formatBalance(user.balance)}\n` +
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n` +
    `🔁 Deposit Count: ${user.depositCount}\n` +
    `📋 Deposit ID: #${deposit.id}`;

  const adminKeyboard = { inline_keyboard: [
    [
      { text: '✅ Approve', callback_data: `dep_approve_${deposit.id}` },
      { text: '❌ Reject',  callback_data: `dep_reject_${deposit.id}` },
    ],
    [{ text: '✉️ Message User', url: `tg://user?id=${userId}` }],
  ]};

  try {
    const sendFile = adminFileId || fileId;
    await h._adminBot.sendPhoto(ADMIN_NOTIFY_CHAT_ID, sendFile, {
      caption: adminText,
      parse_mode: 'HTML',
      reply_markup: adminKeyboard,
    });
  } catch (_) {
    // Fallback: text only
    try {
      await h._adminBot.sendMessage(ADMIN_NOTIFY_CHAT_ID,
        adminText + '\n\n⚠️ Screenshot relay failed — ask user to resend.',
        { parse_mode: 'HTML', reply_markup: adminKeyboard }
      );
    } catch (err) {
      console.error('[DEPOSIT NOTIFY] Admin notify failed:', err.message);
    }
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CALLBACK QUERY ROUTER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const userId = String(query.from.id);
  const data   = query.data;

  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (db.isBanned(userId)) return;

  // ── Check join gate ──────────────────────────────────
  if (data !== 'check_join') {
    const joined = await checkJoined(userId);
    if (!joined) return showJoinGate(chatId, msgId);
  }

  // ── Route ────────────────────────────────────────────
  if (data === 'check_join') {
    const joined = await checkJoined(userId);
    if (!joined) {
      return edit(chatId, msgId,
        `❌ <b>You haven't joined all required links yet!</b>\n\nPlease join and try again.`,
        { reply_markup: { inline_keyboard: [
          ...db.getDb().settings.joinLinks.filter(l=>l.enabled).map(l => [{ text: l.name, url: l.url }]),
          [{ text: '✅ I Joined', callback_data: 'check_join' }],
        ]}}
      );
    }
    // Complete pending referral
    db.completeReferral(userId);
    return showMainMenu(chatId, msgId, true);
  }

  if (data === 'main_menu')   return showMainMenu(chatId, msgId);
  if (data === 'buy_account') {
    if (!db.getDb().settings.features.buyAccount)
      return edit(chatId, msgId, `🚫 Buy Account is currently disabled.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]] } });
    return showBuyAccount(chatId, msgId);
  }
  if (data === 'buy_session') {
    if (!db.getDb().settings.features.buySession)
      return edit(chatId, msgId, `🚫 Buy Sessions is currently disabled.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]] } });
    return showBuySession(chatId, msgId);
  }
  if (data === 'profile')      return showProfile(chatId, msgId, userId);
  if (data === 'deposit')      return showDeposit(chatId, msgId);
  if (data === 'deposit_upi')  return showUpiOptions(chatId, msgId);
  if (data === 'dep_gpay')     return showUpiQr(chatId, msgId, userId, 'gpay');
  if (data === 'dep_fampay')   return showUpiQr(chatId, msgId, userId, 'fampay');
  if (data === 'dep_anyupi')   return showUpiQr(chatId, msgId, userId, 'anyupi');
  if (data === 'deposit_binance') return showBinancePay(chatId, msgId, userId);
  if (data === 'refer_earn')   return showReferEarn(chatId, msgId, userId);
  if (data === 'support')      return showSupport(chatId, msgId);
  if (data === 'leaderboard_deposit')  return showLeaderboard(chatId, msgId, 'deposit');
  if (data === 'leaderboard_referral') return showLeaderboard(chatId, msgId, 'referral');

  if (data.startsWith('product_')) {
    return showProductDetail(chatId, msgId, data.replace('product_', ''));
  }
  if (data.startsWith('confirm_buy_')) {
    return confirmPurchase(chatId, msgId, userId, data.replace('confirm_buy_', ''));
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEXT MESSAGE HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const userId = String(msg.from.id);
  const state  = h.getUserState(userId);
  if (!state) return;

  if (state.state === 'awaiting_deposit_amount') {
    return handleDepositAmount(msg, state);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PUBLIC API — called by admin-bot for user notifications
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function notifyDepositApproved(userId, deposit) {
  const user = db.getUser(userId);
  const rate = db.getDb().settings.usdtToInrRate;
  const usd  = (deposit.amount / rate).toFixed(2);
  await send(userId,
    `✅ <b>Deposit Approved!</b>\n\n` +
    `💵 Amount: ₹${deposit.amount} ($${usd})\n` +
    `💰 New Balance: ${h.formatBalance(user.balance)}\n` +
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n` +
    `🔁 Deposit Count: ${user.depositCount}\n\n` +
    `Thank you for your deposit! 🙏`
  );
}

async function notifyDepositRejected(userId, deposit) {
  const rate = db.getDb().settings.usdtToInrRate;
  const usd  = (deposit.amount / rate).toFixed(2);
  await send(userId,
    `❌ <b>Deposit Rejected</b>\n\n` +
    `💵 Amount: ₹${deposit.amount} ($${usd})\n\n` +
    `Please contact support if you believe this is an error.`,
    { reply_markup: { inline_keyboard: [[{ text: '📞 Support', callback_data: 'support' }]] } }
  );
}

async function notifyOrderDelivered(userId, order) {
  const p = db.getProduct(order.productId);
  await send(userId,
    `📦 <b>Order Delivered!</b>\n\n` +
    `${p ? (p.emoji || '📦') + ' ' + p.name : 'Your order'} has been delivered.\n\n` +
    `Please check your messages from the admin. Thank you! 🙏`
  );
}

module.exports.notifyDepositApproved = notifyDepositApproved;
module.exports.notifyDepositRejected = notifyDepositRejected;
module.exports.notifyOrderDelivered  = notifyOrderDelivered;
module.exports.bot = bot;

console.log('🛒 CLOUDE CART User Bot started...');
