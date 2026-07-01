// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// user-bot.js — CLOUDE CART 🛒 | Customer-Facing Bot
// FIXED: join gate, duplicate messages, products listing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const h  = require('./helpers');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_NOTIFY_CHAT_ID = process.env.ADMIN_NOTIFY_CHAT_ID;
const OWNER_ID             = process.env.OWNER_ID;
const REFERRAL_REWARD_INR  = Number(process.env.REFERRAL_REWARD_INR) || 10;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DUPLICATE MESSAGE GUARD
// Prevents same callback from firing twice
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const _recentCallbacks = new Map();
function isDuplicate(queryId) {
  if (_recentCallbacks.has(queryId)) return true;
  _recentCallbacks.set(queryId, true);
  setTimeout(() => _recentCallbacks.delete(queryId), 5000);
  return false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function edit(chatId, msgId, text, opts = {}) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', ...opts });
  } catch (_) {}
}

async function send(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JOIN GATE
// FIX: /start pe seedha join buttons aane chahiye
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function checkJoined(userId) {
  const links = db.getDb().settings.joinLinks.filter(l => l.enabled);
  if (links.length === 0) return true; // no links set = open access
  for (const link of links) {
    const match = link.url.match(/t\.me\/(?:\+)?([^/?]+)/);
    if (!match) continue;
    const handle = '@' + match[1];
    try {
      const member = await bot.getChatMember(handle, userId);
      if (['left', 'kicked'].includes(member.status)) return false;
    } catch (_) {
      // bot not admin there — skip check
    }
  }
  return true;
}

async function showJoinGate(chatId, msgId = null) {
  const links = db.getDb().settings.joinLinks.filter(l => l.enabled);

  const text =
    `👋 <b>Welcome to CLOUDE CART BOT 🛒!</b>\n\n` +
    `🔒 Please join to use the bot:\n\n` +
    links.map(l => `📣 ${l.name}`).join('\n') +
    `\n\nTap the buttons below then press ✅`;

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
  const features = db.getDb().settings.features;

  const text = isNew
    ? `🛒 <b>Choose the items you need:</b>\n\n❗️ If you have not used our products before, please make a small test purchase first to avoid unnecessary disputes! Thank you for your cooperation`
    : `🛒 <b>CLOUDE CART</b> — Choose an option:`;

  const row1 = [], row2 = [], row3 = [];
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
// /start COMMAND — FIX: always show join gate if not joined
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const userId  = String(msg.from.id);
  const payload = (match[1] || '').trim();

  if (db.isBanned(userId)) {
    return send(chatId, '🚫 You have been banned from this bot.');
  }

  // Ensure user record
  const user = db.getUser(userId);
  db.updateUser(userId, {
    username:  msg.from.username  || user.username,
    firstName: msg.from.first_name || user.firstName,
  });

  // Handle referral payload
  if (payload.startsWith('ref_') && !db.hasBeenReferred(userId)) {
    const referrerId = payload.replace('ref_', '');
    if (referrerId !== userId) {
      db.createReferral(referrerId, userId, REFERRAL_REWARD_INR);
    }
  }

  // FIX: ALWAYS check join first, show gate if not joined
  const joined = await checkJoined(userId);
  if (!joined) {
    return showJoinGate(chatId); // fresh message, no msgId
  }

  // Complete referral reward if pending
  const ref = db.completeReferral(userId);
  if (ref) {
    try {
      const referrer = db.getUser(ref.referrerId);
      await send(ref.referrerId,
        `🎁 <b>Referral Reward!</b>\nSomeone you referred just joined!\n+₹${ref.rewardAmount} added to balance.\n💰 New balance: ${h.formatBalance(referrer.balance)}`
      );
    } catch (_) {}
  }

  const isNew = !user.totalDeposited && !user.depositCount;
  return showMainMenu(chatId, null, isNew);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUY ACCOUNT — FIX: products show hone chahiye
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showBuyAccount(chatId, msgId) {
  const db_      = db.getDb();
  const rate     = db_.settings.usdtToInrRate || 90;
  // FIX: sessionMode === false for accounts
  const products = db.listProducts(false);

  if (!products.length) {
    return edit(chatId, msgId,
      `📦 <b>No accounts available right now.</b>`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]] } }
    );
  }

  // Flash sale check
  const fs = db_.settings.flashSale;
  let flashText = '';
  if (fs && fs.active && fs.endsAt) {
    const tl = h.flashSaleTimeLeft(fs.endsAt);
    if (tl) flashText = `\n🔥 <b>Flash Sale!</b> Ends in <code>${tl}</code>`;
    else { db_.settings.flashSale.active = false; db.saveDb(); }
  }

  const header =
    `✨ <b>Select Account</b>\n` +
    `⚡ Rate: 1 USDT = ₹${rate}${flashText}\n\n` +
    `🟢 Good Quality 2FA\n` +
    `✅ Age Of The Accounts Are Valued Using (Personal Message)\n\n` +
    products.map(p => {
      const usd = (p.price / rate).toFixed(2);
      const stock = p.stock > 0 ? `${p.stock} In Stock` : `❌ Out of Stock`;
      return `${p.emoji || '📦'} ${p.name} | $${usd} • ₹${p.price} | ${stock}`;
    }).join('\n');

  // Buttons: one per product, show price
  const keyboard = [
    ...products.map(p => [{
      text: `${p.emoji || '📦'} ₹${p.price}`,
      callback_data: p.stock > 0 ? `product_${p.id}` : `out_of_stock_${p.id}`,
    }]),
    [{ text: '🔙 Back', callback_data: 'main_menu' }],
  ];

  return edit(chatId, msgId, header, { reply_markup: { inline_keyboard: keyboard } });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUY SESSION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showBuySession(chatId, msgId) {
  const db_      = db.getDb();
  const rate     = db_.settings.usdtToInrRate || 90;
  const products = db.listProducts(true);

  if (!products.length) {
    return edit(chatId, msgId,
      `📂 <b>No sessions available right now.</b>`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]] } }
    );
  }

  const header =
    `📂 <b>Buy Sessions</b>\n` +
    `⚡ Rate: 1 USDT = ₹${rate}\n\n` +
    `Buy sessions in bulk — up to available stock\n\n` +
    products.map(p => {
      const usd = (p.price / rate).toFixed(2);
      const stock = p.stock > 0 ? `${p.stock} In Stock` : `❌ Out of Stock`;
      return `${p.emoji || '📂'} ${p.name} | $${usd} • ₹${p.price} | ${stock}`;
    }).join('\n');

  const keyboard = [
    ...products.map(p => [{
      text: `${p.emoji || '📂'} ${p.name} — ₹${p.price}`,
      callback_data: p.stock > 0 ? `product_${p.id}` : `out_of_stock_${p.id}`,
    }]),
    [{ text: '🔙 Back', callback_data: 'main_menu' }],
  ];

  return edit(chatId, msgId, header, { reply_markup: { inline_keyboard: keyboard } });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRODUCT DETAIL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showProductDetail(chatId, msgId, productId) {
  const p    = db.getProduct(productId);
  const rate = db.getDb().settings.usdtToInrRate || 90;
  const back = p?.sessionMode ? 'buy_session' : 'buy_account';

  if (!p) {
    return edit(chatId, msgId, `❌ Product not found.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: back }]] }
    });
  }

  const usd  = (p.price / rate).toFixed(2);
  const desc = p.description ? `\n\n📝 ${p.description}` : '';
  const text =
    `${p.emoji || '📦'} <b>${p.name}</b>\n\n` +
    `💵 Price: $${usd} • ₹${p.price}\n` +
    `📦 In Stock: ${p.stock}${desc}\n\n` +
    `⚠️ Confirm your purchase?`;

  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [
      [
        { text: '✅ Buy Now', callback_data: `confirm_buy_${productId}` },
        { text: '❌ Cancel',  callback_data: back },
      ],
      [{ text: '🔙 Back', callback_data: back }],
    ]}
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIRM PURCHASE
// FIX: Admin pe direct pin-able message jaye with user info
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function confirmPurchase(chatId, msgId, userId, productId) {
  const p    = db.getProduct(productId);
  const user = db.getUser(userId);
  const rate = db.getDb().settings.usdtToInrRate || 90;
  const back = p?.sessionMode ? 'buy_session' : 'buy_account';

  if (!p || p.stock < 1) {
    return edit(chatId, msgId, `❌ Sorry, this item just went out of stock.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: back }]] }
    });
  }

  if (user.balance < p.price) {
    const short = (p.price - user.balance).toFixed(2);
    return edit(chatId, msgId,
      `💰 <b>Insufficient Balance</b>\n\nYou need ₹${short} more.\nCurrent: ${h.formatBalance(user.balance)}`,
      { reply_markup: { inline_keyboard: [
        [{ text: '💳 Deposit Now', callback_data: 'deposit' }],
        [{ text: '🔙 Back',       callback_data: back }],
      ]}}
    );
  }

  // Deduct + reduce stock
  db.updateUser(userId, { balance: user.balance - p.price });
  db.updateProduct(productId, { stock: p.stock - 1 });
  const order = db.createOrder({ userId, productId, quantity: 1, totalPrice: p.price });
  const usd   = (p.price / rate).toFixed(2);

  // Tell user to wait
  await edit(chatId, msgId,
    `✅ <b>Order Placed — Waiting for Admin Approval</b>\n\n` +
    `📦 ${p.emoji || ''} ${p.name}\n` +
    `💸 ₹${p.price} ($${usd}) deducted\n` +
    `💰 Remaining Balance: ${h.formatBalance(user.balance - p.price)}\n\n` +
    `⏳ Please wait, admin will deliver your product shortly.`,
    { reply_markup: { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'main_menu' }]] } }
  );

  // Admin notification — direct message with full info + pin-able
  const totalBal = user.balance - p.price;
  const adminText =
    `🛒 <b>NEW ORDER — Customer Waiting for Product</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 User: ${user.username ? '@' + user.username : user.firstName || 'Unknown'}\n` +
    `🆔 User ID: <code>${userId}</code>\n` +
    `📦 Product: ${p.emoji || ''} ${p.name}\n` +
    `💰 Price: ₹${p.price} ($${usd})\n` +
    `💼 Balance After: ₹${totalBal.toFixed(2)} ($${(totalBal / rate).toFixed(2)})\n` +
    `📋 Order ID: #${order.id}\n` +
    `📅 Time: ${new Date().toLocaleString('en-IN')}`;

  try {
    const adminMsg = await h._adminBot.sendMessage(ADMIN_NOTIFY_CHAT_ID, adminText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [
          { text: '✅ Mark Delivered', callback_data: `deliver_${order.id}` },
          { text: '✉️ Message User',   url: `tg://user?id=${userId}` },
        ],
      ]}
    });
    // Auto-pin in admin chat
    try { await h._adminBot.pinChatMessage(ADMIN_NOTIFY_CHAT_ID, adminMsg.message_id); } catch (_) {}
  } catch (err) {
    console.error('[ORDER NOTIFY] Failed:', err.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROFILE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showProfile(chatId, msgId, userId) {
  const user = db.getUser(userId);
  const rate = db.getDb().settings.usdtToInrRate || 90;

  const text =
    `👤 <b>Your Profile</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `👤 Name: ${user.firstName || 'Unknown'}\n` +
    `💰 Balance: ₹${user.balance.toFixed(2)} ($${(user.balance / rate).toFixed(2)})\n` +
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n` +
    `🔁 Deposit Count: ${user.depositCount}\n` +
    `🎁 Referrals: ${user.referralCount} (₹${user.referralEarned.toFixed(2)} earned)\n` +
    `📅 Joined: ${new Date(user.joinedAt).toLocaleDateString('en-IN')}`;

  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [
      [
        { text: '🏆 Deposit Board',  callback_data: 'leaderboard_deposit' },
        { text: '🎁 Referral Board', callback_data: 'leaderboard_referral' },
      ],
      [{ text: '🔙 Back', callback_data: 'main_menu' }],
    ]}
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LEADERBOARD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showLeaderboard(chatId, msgId, type) {
  const list  = type === 'deposit' ? db.getDepositLeaderboard(10) : db.getReferralLeaderboard(10);
  const title = type === 'deposit' ? '💰 Top Depositors' : '🎁 Top Referrers';
  const lines = list.map((u, i) => {
    const name = u.username ? `@${u.username}` : (u.firstName || `User ${u.userId}`);
    const val  = type === 'deposit' ? `₹${u.totalDeposited.toFixed(2)}` : `${u.referralCount} refs`;
    return `${h.medal(i)} ${name} — ${val}`;
  });

  return edit(chatId, msgId,
    `🏆 <b>${title}</b>\n\n${lines.join('\n') || 'No data yet.'}`,
    { reply_markup: { inline_keyboard: [
      [
        { text: '💰 Deposit Board',  callback_data: 'leaderboard_deposit' },
        { text: '🎁 Referral Board', callback_data: 'leaderboard_referral' },
      ],
      [{ text: '🔙 Back', callback_data: 'profile' }],
    ]}}
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REFER & EARN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showReferEarn(chatId, msgId, userId) {
  const botInfo = await bot.getMe();
  const link    = `https://t.me/${botInfo.username}?start=ref_${userId}`;
  const user    = db.getUser(userId);

  return edit(chatId, msgId,
    `🎁 <b>Refer & Earn</b>\n\n` +
    `Share your link — earn <b>₹${REFERRAL_REWARD_INR}</b> per new user!\n\n` +
    `🔗 Your Link:\n<code>${link}</code>\n\n` +
    `👥 Total Referrals: ${user.referralCount}\n` +
    `💵 Total Earned: ₹${user.referralEarned.toFixed(2)}`,
    { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]] } }
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SUPPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showSupport(chatId, msgId) {
  const sup = db.getDb().settings.supportUsername;
  return edit(chatId, msgId,
    `📞 <b>Support</b>\n\nFor help, contact our support team:`,
    { reply_markup: { inline_keyboard: [
      [{ text: '💬 Contact Support', url: `https://t.me/${sup}` }],
      [{ text: '🔙 Back', callback_data: 'main_menu' }],
    ]}}
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEPOSIT FLOW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showDeposit(chatId, msgId) {
  const db_    = db.getDb();
  const pay    = db_.settings.payments;
  const minDep = db_.settings.minDepositInr || 20;

  if (!db_.settings.features.deposit) {
    return edit(chatId, msgId, `🚫 Deposits are currently disabled.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]] }
    });
  }

  const keyboard = [];
  const hasUpi = pay.gpay.enabled || pay.fampay.enabled || pay.anyupi.enabled;
  if (hasUpi)            keyboard.push([{ text: '📱 UPI Payment',         callback_data: 'deposit_upi' }]);
  if (pay.binance.enabled) keyboard.push([{ text: '💳 Binance Pay (USDT)', callback_data: 'deposit_binance' }]);
  keyboard.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);

  return edit(chatId, msgId,
    `💰 <b>Deposit</b>\n\n✅ Minimum: ₹${minDep}\n⚠️ Manual verification after screenshot\n\nChoose payment method:`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function showUpiOptions(chatId, msgId) {
  const pay = db.getDb().settings.payments;
  const keyboard = [];
  if (pay.gpay.enabled)   keyboard.push([{ text: '📱 G Pay',    callback_data: 'dep_gpay' }]);
  if (pay.fampay.enabled) keyboard.push([{ text: '💳 Fam Pay',  callback_data: 'dep_fampay' }]);
  if (pay.anyupi.enabled) keyboard.push([{ text: '🗃️ Any UPI', callback_data: 'dep_anyupi' }]);
  keyboard.push([{ text: '🔙 Back', callback_data: 'deposit' }]);

  return edit(chatId, msgId,
    `📱 <b>UPI Payment</b>\n━━━━━━━━━━━━━━━━━━━━\n✅ Minimum: ₹${db.getDb().settings.minDepositInr || 20}\n⚠️ Manual verification after screenshot\n\nChoose your UPI app:`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function showUpiQr(chatId, msgId, userId, method) {
  const db_    = db.getDb();
  const pay    = db_.settings.payments[method];
  const minDep = db_.settings.minDepositInr || 20;
  const names  = { gpay: 'G Pay', fampay: 'Fam Pay', anyupi: 'Any UPI' };

  if (!pay || !pay.enabled) {
    return edit(chatId, msgId, `🚫 This payment method is currently disabled.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'deposit_upi' }]] }
    });
  }

  h.setUserState(userId, 'awaiting_deposit_amount', { method });

  const caption =
    `📱 <b>${names[method]}</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Minimum: ₹${minDep}\n` +
    (pay.upiId   ? `🆔 UPI ID: <code>${pay.upiId}</code>\n` : '') +
    (pay.upiName ? `👤 Name: ${pay.upiName}\n` : '') +
    `\nEnter amount in ₹ (minimum ₹${minDep}):`;

  // Show QR photo if set
  if (pay.qrFileId) {
    try { await bot.deleteMessage(chatId, msgId); } catch (_) {}
    await bot.sendPhoto(chatId, pay.qrFileId, {
      caption,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'deposit_upi' }]] }
    });
  } else {
    await edit(chatId, msgId, caption, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'deposit_upi' }]] }
    });
  }
}

async function showBinancePay(chatId, msgId, userId) {
  const db_    = db.getDb();
  const pay    = db_.settings.payments.binance;
  const minDep = db_.settings.minDepositInr || 20;
  const rate   = db_.settings.usdtToInrRate || 90;

  if (!pay.enabled) {
    return edit(chatId, msgId, `🚫 Binance Pay is currently disabled.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'deposit' }]] }
    });
  }

  h.setUserState(userId, 'awaiting_deposit_amount', { method: 'binance' });

  return edit(chatId, msgId,
    `💳 <b>Binance Pay (USDT)</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    (pay.binanceId   ? `🆔 Binance ID: <code>${pay.binanceId}</code>\n` : '') +
    (pay.binanceName ? `👤 Name: ${pay.binanceName}\n` : '') +
    `\nEnter amount in ₹ (min ₹${minDep}, = $${(minDep / rate).toFixed(2)} USDT):`,
    { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'deposit' }]] } }
  );
}

async function handleDepositAmount(msg, state) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const amount = parseFloat(msg.text);
  const minDep = db.getDb().settings.minDepositInr || 20;

  if (isNaN(amount) || amount < minDep) {
    return send(chatId, `⚠️ Minimum is ₹${minDep}. Please enter a valid amount:`);
  }

  h.setUserState(userId, 'awaiting_screenshot', { method: state.data.method, amount });
  const rate = db.getDb().settings.usdtToInrRate || 90;
  const usd  = (amount / rate).toFixed(2);

  return send(chatId,
    `💰 Amount: ₹${amount} ($${usd} USDT)\n\n📸 Please send your payment screenshot now:`,
    { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'deposit' }]] } }
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHOTO HANDLER — Cross-Bot Photo Relay (payment screenshot)
// FIX: Admin pe direct pin-able message with screenshot + info
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const state  = h.getUserState(userId);

  if (!state || state.state !== 'awaiting_screenshot') return;
  h.clearUserState(userId);

  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const { method, amount } = state.data;
  const rate = db.getDb().settings.usdtToInrRate || 90;
  const usd  = (amount / rate).toFixed(2);
  const user = db.getUser(userId);

  // Save deposit (User-Bot file_id first)
  const deposit = db.createDeposit({
    userId, amount, method,
    screenshotFileId: fileId,
    screenshotFileIdAdmin: null,
  });

  // Confirm to user immediately
  await send(chatId,
    `✅ <b>Screenshot Received!</b>\n\n💰 Amount: ₹${amount} ($${usd})\n📋 Deposit ID: #${deposit.id}\n\n⏳ Please wait a few minutes for admin approval.`,
    { reply_markup: { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'main_menu' }]] } }
  );

  // Relay screenshot to Admin Bot (Cross-Bot Photo Relay System)
  const adminFileId = await h.relayPhotoToAdmin(fileId, ADMIN_NOTIFY_CHAT_ID);
  if (adminFileId) {
    db.updateDeposit(deposit.id, { screenshotFileIdAdmin: adminFileId });
  }

  // Admin notification — direct pin-able message with screenshot + full info + message box
  const adminCaption =
    `💰 <b>NEW DEPOSIT REQUEST</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 User: ${user.username ? '@' + user.username : user.firstName || 'Unknown'}\n` +
    `🆔 User ID: <code>${userId}</code>\n` +
    `💵 Amount: ₹${amount} ($${usd} USDT)\n` +
    `💳 Method: ${method.toUpperCase()}\n` +
    `💼 Current Balance: ₹${user.balance.toFixed(2)}\n` +
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n` +
    `🔁 Deposit Count: ${user.depositCount + 1}\n` +
    `📋 Deposit ID: #${deposit.id}\n` +
    `📅 Time: ${new Date().toLocaleString('en-IN')}`;

  const adminKeyboard = { inline_keyboard: [
    [
      { text: '✅ Approve', callback_data: `dep_approve_${deposit.id}` },
      { text: '❌ Reject',  callback_data: `dep_reject_${deposit.id}` },
    ],
    [{ text: '✉️ Message User', url: `tg://user?id=${userId}` }],
  ]};

  try {
    const sendFileId = adminFileId || fileId;
    const adminMsg = await h._adminBot.sendPhoto(ADMIN_NOTIFY_CHAT_ID, sendFileId, {
      caption: adminCaption,
      parse_mode: 'HTML',
      reply_markup: adminKeyboard,
    });
    // Auto-pin in admin chat
    try { await h._adminBot.pinChatMessage(ADMIN_NOTIFY_CHAT_ID, adminMsg.message_id); } catch (_) {}
  } catch (_) {
    // Fallback: text only
    try {
      const adminMsg = await h._adminBot.sendMessage(ADMIN_NOTIFY_CHAT_ID,
        adminCaption + '\n\n⚠️ Screenshot relay failed — ask user to resend.',
        { parse_mode: 'HTML', reply_markup: adminKeyboard }
      );
      try { await h._adminBot.pinChatMessage(ADMIN_NOTIFY_CHAT_ID, adminMsg.message_id); } catch (_) {}
    } catch (err) {
      console.error('[DEPOSIT NOTIFY] Failed:', err.message);
    }
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
  if (state.state === 'awaiting_deposit_amount') return handleDepositAmount(msg, state);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CALLBACK QUERY ROUTER
// FIX: duplicate guard added
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

bot.on('callback_query', async (query) => {
  if (isDuplicate(query.id)) return;

  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const userId = String(query.from.id);
  const data   = query.data;

  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (db.isBanned(userId)) {
    return send(chatId, '🚫 You are banned from this bot.');
  }

  // Join check on every action except check_join itself
  if (data !== 'check_join') {
    const joined = await checkJoined(userId);
    if (!joined) return showJoinGate(chatId, msgId);
  }

  if (data === 'check_join') {
    const joined = await checkJoined(userId);
    if (!joined) {
      const links = db.getDb().settings.joinLinks.filter(l => l.enabled);
      return edit(chatId, msgId,
        `❌ <b>Not joined yet!</b>\n\nPlease join all links first, then press ✅`,
        { reply_markup: { inline_keyboard: [
          ...links.map(l => [{ text: l.name, url: l.url }]),
          [{ text: '✅ I Joined', callback_data: 'check_join' }],
        ]}}
      );
    }
    db.completeReferral(userId);
    const user = db.getUser(userId);
    const isNew = !user.totalDeposited && !user.depositCount;
    return edit(chatId, msgId,
      `✅ <b>All Verified!</b>\n\nWelcome! Tap below or send /start.`,
      { reply_markup: { inline_keyboard: [[{ text: '🚀 Start Now', callback_data: isNew ? 'main_menu_new' : 'main_menu' }]] } }
    );
  }

  if (data === 'main_menu')      return showMainMenu(chatId, msgId, false);
  if (data === 'main_menu_new')  return showMainMenu(chatId, msgId, true);
  if (data === 'buy_account')    return showBuyAccount(chatId, msgId);
  if (data === 'buy_session')    return showBuySession(chatId, msgId);
  if (data === 'profile')        return showProfile(chatId, msgId, userId);
  if (data === 'deposit')        return showDeposit(chatId, msgId);
  if (data === 'deposit_upi')    return showUpiOptions(chatId, msgId);
  if (data === 'dep_gpay')       return showUpiQr(chatId, msgId, userId, 'gpay');
  if (data === 'dep_fampay')     return showUpiQr(chatId, msgId, userId, 'fampay');
  if (data === 'dep_anyupi')     return showUpiQr(chatId, msgId, userId, 'anyupi');
  if (data === 'deposit_binance') return showBinancePay(chatId, msgId, userId);
  if (data === 'refer_earn')     return showReferEarn(chatId, msgId, userId);
  if (data === 'support')        return showSupport(chatId, msgId);
  if (data === 'leaderboard_deposit')  return showLeaderboard(chatId, msgId, 'deposit');
  if (data === 'leaderboard_referral') return showLeaderboard(chatId, msgId, 'referral');

  if (data.startsWith('out_of_stock_')) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Out of stock!', show_alert: true });
  }
  if (data.startsWith('product_')) {
    return showProductDetail(chatId, msgId, data.replace('product_', ''));
  }
  if (data.startsWith('confirm_buy_')) {
    return confirmPurchase(chatId, msgId, userId, data.replace('confirm_buy_', ''));
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PUBLIC API — called by admin-bot for notifications
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function notifyDepositApproved(userId, deposit) {
  const user = db.getUser(userId);
  const rate = db.getDb().settings.usdtToInrRate || 90;
  await send(userId,
    `✅ <b>Deposit Approved!</b>\n\n` +
    `💵 Amount: ₹${deposit.amount} ($${(deposit.amount / rate).toFixed(2)})\n` +
    `💰 New Balance: ${h.formatBalance(user.balance)}\n` +
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n` +
    `🔁 Deposit Count: ${user.depositCount}\n\nThank you! 🙏`
  );
}

async function notifyDepositRejected(userId, deposit) {
  const rate = db.getDb().settings.usdtToInrRate || 90;
  await send(userId,
    `❌ <b>Deposit Rejected</b>\n\n` +
    `💵 Amount: ₹${deposit.amount} ($${(deposit.amount / rate).toFixed(2)})\n\n` +
    `Contact support if you believe this is an error.`,
    { reply_markup: { inline_keyboard: [[{ text: '📞 Support', callback_data: 'support' }]] } }
  );
}

async function notifyOrderDelivered(userId, order) {
  const p = db.getProduct(order.productId);
  await send(userId,
    `📦 <b>Order Delivered!</b>\n\n` +
    `${p ? (p.emoji || '📦') + ' ' + p.name : 'Your order'} has been delivered.\n\nThank you! 🙏`
  );
}

module.exports = {
  bot,
  notifyDepositApproved,
  notifyDepositRejected,
  notifyOrderDelivered,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Store _adminBot reference in helpers after both bots init
// This is set by admin-bot.js after startup
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
h._adminBot = null; // will be set by admin-bot.js

console.log('🛒 CLOUDE CART User Bot started...');
