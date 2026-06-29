// user-bot.js — TgApiStore User Bot (FIXED)
// Fixes: QR photo sending, screenshot forwarding, buttons clean (no colour emoji), support ID, $ / ₹ toggle

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const {
  fmtUsd, fmtInr, fmtMoney,
  isValidPositiveInt, isValidPositiveNumber,
  todayKey, weekKey, timeUntilWeekReset,
  escapeHtml, genRefCode,
} = require('./helpers');

const TOKEN               = process.env.BOT_TOKEN;
const ADMIN_BOT_TOKEN     = process.env.ADMIN_BOT_TOKEN;
const ADMIN_NOTIFY_CHAT_ID = process.env.ADMIN_NOTIFY_CHAT_ID;

if (!TOKEN) { console.error('❌ Missing BOT_TOKEN'); process.exit(1); }

db.initDB();
const bot = new TelegramBot(TOKEN, { polling: true });

let adminPushBot = null;
if (ADMIN_BOT_TOKEN) adminPushBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: false });

console.log('✅ User Bot started...');

// ── Currency helper ───────────────────────────────────────────
function fmt(usd, inr) {
  const s = db.getSettings();
  return s.displayCurrency === 'usd' ? fmtUsd(usd) : fmtInr(inr);
}
function fmtBoth(usd, inr) {
  const s = db.getSettings();
  return s.displayCurrency === 'usd'
    ? `${fmtUsd(usd)}`
    : `${fmtInr(inr)} (${fmtUsd(usd)})`;
}

// ── Keyboards (CLEAN — no colour-dot emojis on buttons) ───────
function joinStepsKeyboard(settings) {
  return {
    inline_keyboard: [
      [{ text: '📢 Join Channel', url: settings.channelUrl }],
      [{ text: '👥 Join Group',   url: settings.groupUrl }],
      [{ text: '📜 Review & Accept Terms', callback_data: 'show_terms' }],
    ],
  };
}

function termsKeyboard(accepted) {
  return {
    inline_keyboard: [
      [{ text: accepted ? '✅ Accepted' : '☑️ I have read and agree', callback_data: 'accept_terms' }],
      [{ text: accepted ? '➡️ Continue' : '✅ Accept & Continue', callback_data: accepted ? 'go_main_menu' : 'noop' }],
    ],
  };
}

function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: '🛒 Buy Product' },   { text: '🔑 Buy Keys/Codes' }],
      [{ text: '👤 Profile' },       { text: '💰 Deposit' }],
      [{ text: '🎁 Refer & Earn' }],
      [{ text: '📞 Support' }],
    ],
    resize_keyboard: true,
  };
}

function backToMenuInline() {
  return { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'go_main_menu' }]] };
}

// ── Welcome ───────────────────────────────────────────────────
function welcomeText() {
  return (
    `👋 *Welcome to TgApiStore!*\n\n` +
    `To start using the bot, please complete these steps:\n\n` +
    `📋 *Step 1 — Our Rules:*\n` +
    `🔒 Products & keys are sold as-is — keep your files secure\n` +
    `⏱️ Redeem one key/file at a time, wait 2-3 min between each\n` +
    `🚫 No spam or mass messaging — misuse may restrict your access\n` +
    `💰 Failed deliveries are auto-refunded to your balance\n` +
    `🎁 One genuine account per person — fake referrals void rewards\n\n` +
    `📢 *Step 2 — Join our community:*\n\n` +
    `Tap the buttons below, then accept the terms 👇`
  );
}

function termsText(accepted) {
  return (
    `🔒 Products & keys are sold *as-is*. Keep your files secure.\n\n` +
    `⏱️ Redeem *one item at a time*, waiting 2-3 minutes between each.\n\n` +
    `🚫 No spam, mass messaging, or abuse. Misused accounts may be restricted.\n\n` +
    `💰 Refunds apply only as described at purchase.\n\n` +
    `🎁 One genuine account per person. Fake referrals void all rewards.` +
    (accepted ? `\n\n✅ *You have accepted the Terms & Conditions.*` : '')
  );
}

// ── /start ────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (db.isBanned(userId))
    return bot.sendMessage(chatId, '🚫 Your account has been restricted. Contact support if you believe this is a mistake.');

  const payload    = match && match[1] ? match[1].trim() : null;
  let referredBy   = null;
  if (payload && payload.startsWith('ref_')) {
    const refId = payload.replace('ref_', '');
    if (refId !== String(userId)) referredBy = refId;
  }

  const existing = db.getUser(userId);
  const isNew    = !existing;

  const user = db.createUserIfNotExists(userId, {
    username: msg.from.username || '',
    firstName: msg.from.first_name || '',
    referredBy,
  });

  if (isNew && referredBy) creditReferral(referredBy, userId);

  if (user.acceptedTerms) return sendMainMenu(chatId, userId);

  const settings = db.getSettings();
  bot.sendMessage(chatId, welcomeText(), { parse_mode: 'Markdown', reply_markup: joinStepsKeyboard(settings) });
});

// ── Referral credit ───────────────────────────────────────────
function creditReferral(referrerId, newUserId) {
  const referrer = db.getUser(referrerId);
  if (!referrer) return;
  const s    = db.getSettings();
  if (!s.referralEnabled) return;
  const tKey = todayKey(), wKey = weekKey();

  db.updateUser(referrerId, {
    referrals:          (referrer.referrals || 0) + 1,
    referralEarnedUsd:  db.round2((referrer.referralEarnedUsd||0) + s.referralRewardUsd),
    referralEarnedInr:  Math.round((referrer.referralEarnedInr||0) + s.referralRewardInr),
    balanceUsd:         db.round2((referrer.balanceUsd||0) + s.referralRewardUsd),
    balanceInr:         Math.round((referrer.balanceInr||0) + s.referralRewardInr),
    referralsToday:     referrer.lastReferralDay===tKey ? (referrer.referralsToday||0)+1 : 1,
    referralsThisWeek:  referrer.lastReferralWeek===wKey ? (referrer.referralsThisWeek||0)+1 : 1,
    lastReferralDay: tKey, lastReferralWeek: wKey,
  });

  bot.sendMessage(referrerId,
    `🎉 *New referral joined!*\nYou earned ${fmtBoth(s.referralRewardUsd, s.referralRewardInr)}`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ── Main Menu ─────────────────────────────────────────────────
function sendMainMenu(chatId, userId) {
  const s       = db.getSettings();
  const refLink = `https://t.me/${s.botUsername}?start=${genRefCode(userId)}`;
  const text    =
    `🎁 *Earn Money!*\nRefer friends and get ${fmtBoth(s.referralRewardUsd, s.referralRewardInr)} when they join!\n` +
    `🔗 ${refLink}\n\n` +
    `🛍️ *Choose the items you need:*\n\n` +
    `❗ If you have not used our products before, please make a small test purchase first!`;

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
}

// ── Callback queries ──────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId    = query.message.chat.id;
  const userId    = query.from.id;
  const data      = query.data;
  const messageId = query.message.message_id;

  if (db.isBanned(userId) && data !== 'noop')
    return bot.answerCallbackQuery(query.id, { text: '🚫 Your account is restricted.', show_alert: true });

  try {
    if (data === 'show_terms') {
      await bot.sendMessage(chatId, termsText(false), { parse_mode: 'Markdown', reply_markup: termsKeyboard(false) });
    } else if (data === 'accept_terms') {
      db.updateUser(userId, { acceptedTerms: true, joinedChannel: true, joinedGroup: true });
      await bot.editMessageText(termsText(true), {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: termsKeyboard(true),
      });
    } else if (data === 'go_main_menu') {
      sendMainMenu(chatId, userId);
    } else if (data === 'noop') {
      await bot.answerCallbackQuery(query.id, { text: 'Please accept the terms first.' });
      return;
    } else if (data.startsWith('cat_'))         { handleCategorySelect(chatId, userId, data.replace('cat_',''));
    } else if (data.startsWith('buyprod_'))      { handleProductSelected(chatId, userId, data.replace('buyprod_',''));
    } else if (data.startsWith('confirmbuy_'))   { handleConfirmPurchase(chatId, userId, data.replace('confirmbuy_',''));
    } else if (data.startsWith('qty_'))          { handleQuickQty(chatId, userId, data);
    } else if (data === 'custom_qty')            { handleCustomQtyPrompt(chatId, userId);
    } else if (data === 'back_to_products')      { sendProductCategories(chatId);
    } else if (data === 'back_to_keys')          { sendKeysProducts(chatId);
    } else if (data === 'deposit_upi')           { sendUpiAppChoice(chatId);
    } else if (data === 'deposit_binance')       { sendBinanceDepositInfo(chatId, userId);
    } else if (data.startsWith('upiapp_'))       { handleUpiAppChosen(chatId, userId, data.replace('upiapp_',''));
    } else if (data === 'i_have_paid')           { handleIHavePaid(chatId, userId);
    } else if (data === 'cancel_deposit') {
      db.clearUserState(userId);
      await bot.editMessageCaption('❌ Deposit cancelled.', { chat_id: chatId, message_id: messageId }).catch(() =>
        bot.editMessageText('❌ Deposit cancelled.', { chat_id: chatId, message_id: messageId })
      );
    } else if (data === 'share_link')           { handleReferEarn(chatId, userId, false);
    } else if (data === 'leaderboard')           { handleLeaderboard(chatId);
    } else if (data === 'refresh_referral')      { handleReferEarn(chatId, userId, true, messageId);
    } else if (data === 'contact_support')       { handleContactSupport(chatId);
    } else if (data === 'back_deposit_methods')  { sendDepositMethods(chatId);
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
  } catch (err) {
    console.error('callback_query error:', err.message);
    bot.answerCallbackQuery(query.id, { text: '⚠️ Something went wrong, try again.' }).catch(() => {});
  }
});

// ── Text / keyboard button handler ────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/start')) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (db.isBanned(userId))
    return bot.sendMessage(chatId, '🚫 Your account has been restricted.');

  const user = db.getUser(userId);
  if (!user) return;

  const text = msg.text.trim();

  if (user.state === 'awaiting_custom_qty')    return handleCustomQtyInput(chatId, userId, text);
  if (user.state === 'awaiting_deposit_amount') return handleDepositAmountInput(chatId, userId, text);

  switch (text) {
    case '🛒 Buy Product':    return sendProductCategories(chatId);
    case '🔑 Buy Keys/Codes': return sendKeysProducts(chatId);
    case '👤 Profile':        return sendProfile(chatId, userId);
    case '💰 Deposit':        return sendDepositMethods(chatId);
    case '🎁 Refer & Earn':   return handleReferEarn(chatId, userId, false);
    case '📞 Support':        return handleSupportMenu(chatId);
    case '🏠 Main Menu':      return sendMainMenu(chatId, userId);
  }
});

// ── Photo handler (deposit screenshot) ───────────────────────
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const user   = db.getUser(userId);
  if (!user || user.state !== 'awaiting_screenshot') return;

  const fileId    = msg.photo[msg.photo.length - 1].file_id;
  const depositId = user.stateData.depositId;
  const deposit   = db.getDeposit(depositId);
  if (!deposit) return;

  // ✅ Save screenshot file_id into the deposit record
  db.updateDeposit(depositId, { screenshotFileId: fileId });
  db.clearUserState(userId);

  await bot.sendMessage(chatId,
    `✅ *Screenshot received!*\n\n` +
    `Your deposit is awaiting admin approval.\n\n` +
    `🧾 Ref ID: \`${depositId}\`\n\n` +
    `_You will be notified once approved._`,
    { parse_mode: 'Markdown' }
  );

  // ✅ Forward deposit + screenshot to admin bot
  notifyAdminOfDeposit(deposit, fileId);
});

// ── Products ──────────────────────────────────────────────────
function sendProductCategories(chatId) {
  const products = db.getProducts().filter(p => p.active && p.category !== 'Keys');
  const s        = db.getSettings();

  if (!products.length)
    return bot.sendMessage(chatId, '📦 No products available right now!', { reply_markup: backToMenuInline() });

  let text = `✨ *Select Product*\n⚡ Rate: 1 USDT = ${fmtInr(s.usdtRate)}\n✅ Quality checked before listing\n\n`;
  products.forEach(p => { text += `${p.emoji} ${p.name} | ${fmtBoth(p.priceUsd, p.priceInr)} | ${p.stock} In Stock\n`; });

  const buttons = [];
  for (let i = 0; i < products.length; i += 2) {
    const row = [{ text: `${products[i].emoji} ${products[i].name} | ${fmt(products[i].priceUsd, products[i].priceInr)}`, callback_data: `buyprod_${products[i].id}` }];
    if (products[i+1]) row.push({ text: `${products[i+1].emoji} ${products[i+1].name} | ${fmt(products[i+1].priceUsd, products[i+1].priceInr)}`, callback_data: `buyprod_${products[i+1].id}` });
    buttons.push(row);
  }
  buttons.push([{ text: '🏠 Main Menu', callback_data: 'go_main_menu' }]);
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

function sendKeysProducts(chatId) {
  const products = db.getProducts().filter(p => p.active && p.category === 'Keys');
  if (!products.length)
    return bot.sendMessage(chatId, '🔑 No keys/codes available right now.', { reply_markup: backToMenuInline() });

  let text =
    `⚠️ *IMPORTANT — READ BEFORE BUYING*\n\n` +
    `❌ Do NOT spam requests\n❌ Do NOT place multiple orders at once\n` +
    `✅ Order one batch at a time, with patience\n✅ Wait 2-3 mins between orders\n\n`;
  products.forEach(p => {
    text += `\n📁 *${p.name}*\n💰 Price: ${fmtBoth(p.priceUsd, p.priceInr)} per unit\n📦 In Stock: ${p.stock}\n`;
  });

  const buttons = products.map(p => [{ text: `${p.emoji} ${p.name} | ${fmt(p.priceUsd, p.priceInr)}`, callback_data: `buyprod_${p.id}` }]);
  buttons.push([{ text: '🏠 Main Menu', callback_data: 'go_main_menu' }]);
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

// ── Purchase flow ─────────────────────────────────────────────
function handleProductSelected(chatId, userId, productId) {
  const product = db.getProductById(productId);
  if (!product || !product.active) return bot.sendMessage(chatId, '⚠️ This product is no longer available.');
  if (product.stock <= 0)          return bot.sendMessage(chatId, '⚠️ Out of stock! Please check back later.');

  db.setUserState(userId, 'choosing_qty', { productId });

  const text =
    `📦 *${product.emoji} ${product.name}*\n` +
    `💰 Price: ${fmtBoth(product.priceUsd, product.priceInr)} per unit\n` +
    `📦 In Stock: ${product.stock}\n\n` +
    (product.description ? `${escapeHtml(product.description)}\n\n` : '') +
    `How many do you want?`;

  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [1,2,5].map(n => ({ text: `  ${n}  `, callback_data: `qty_${productId}_${n}` })),
        [{ text: '✏️ Enter Custom Amount', callback_data: 'custom_qty' }],
        [{ text: '« Back', callback_data: product.category === 'Keys' ? 'back_to_keys' : 'back_to_products' }],
      ],
    },
  });
}

function handleQuickQty(chatId, userId, data) {
  const parts     = data.split('_');
  const qty       = parseInt(parts[parts.length - 1], 10);
  const productId = parts.slice(1, parts.length - 1).join('_');
  confirmPurchasePrompt(chatId, userId, productId, qty);
}

function handleCustomQtyPrompt(chatId, userId) {
  const user = db.getUser(userId);
  db.setUserState(userId, 'awaiting_custom_qty', { productId: user.stateData.productId });
  bot.sendMessage(chatId, '✏️ Please enter the quantity you want (e.g. 3):');
}

function handleCustomQtyInput(chatId, userId, text) {
  const user = db.getUser(userId);
  if (!isValidPositiveInt(text)) return bot.sendMessage(chatId, '❌ Please enter a valid number (e.g. 3)');
  const qty = parseInt(text.trim(), 10);
  db.clearUserState(userId);
  confirmPurchasePrompt(chatId, userId, user.stateData.productId, qty);
}

function confirmPurchasePrompt(chatId, userId, productId, qty) {
  const product = db.getProductById(productId);
  if (!product) return bot.sendMessage(chatId, '⚠️ Product not found.');
  if (qty > product.stock) return bot.sendMessage(chatId, `⚠️ Only ${product.stock} in stock. Enter a smaller amount.`);

  const totalUsd = db.round2(product.priceUsd * qty);
  const totalInr = Math.round(product.priceInr * qty);
  db.setUserState(userId, 'confirming_purchase', { productId, qty, totalUsd, totalInr });

  bot.sendMessage(chatId,
    `🧾 *Order Summary*\n\n${product.emoji} ${product.name}\nQty: ${qty}\nTotal: ${fmtBoth(totalUsd, totalInr)}\n\nConfirm purchase?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm Purchase', callback_data: `confirmbuy_${productId}_${qty}` }],
          [{ text: '❌ Cancel',           callback_data: product.category === 'Keys' ? 'back_to_keys' : 'back_to_products' }],
        ],
      },
    }
  );
}

function handleConfirmPurchase(chatId, userId, payload) {
  const parts     = payload.split('_');
  const qty       = parseInt(parts[parts.length - 1], 10);
  const productId = parts.slice(0, parts.length - 1).join('_');
  const product   = db.getProductById(productId);
  const user      = db.getUser(userId);
  if (!product || !user) return;
  if (qty > product.stock) return bot.sendMessage(chatId, `⚠️ Only ${product.stock} in stock now.`);

  const totalUsd = db.round2(product.priceUsd * qty);
  const totalInr = Math.round(product.priceInr * qty);

  if (user.balanceUsd < totalUsd) {
    return bot.sendMessage(chatId,
      `❌ *Insufficient balance.*\nNeed ${fmtBoth(totalUsd, totalInr)} — your balance is ${fmtBoth(user.balanceUsd, user.balanceInr)}.\n\nPlease deposit first.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💰 Deposit Now', callback_data: 'back_deposit_methods' }]] } }
    );
  }

  db.deductBalance(userId, totalUsd, totalInr);
  db.decrementStock(productId, qty);
  db.updateUser(userId, {
    spentUsd: db.round2(user.spentUsd + totalUsd),
    spentInr: Math.round(user.spentInr + totalInr),
    purchases: user.purchases + 1,
  });
  db.clearUserState(userId);

  const order = db.createOrder({
    userId, username: user.username, productId,
    productName: product.name, qty, amountUsd: totalUsd, amountInr: totalInr,
    status: product.deliveryType === 'manual' ? 'pending_delivery' : 'completed',
  });

  let deliveryMsg = '';
  if (product.deliveryType === 'auto-text' && product.deliveryText) {
    deliveryMsg = `\n\n🔑 *Your delivery:*\n\`${escapeHtml(product.deliveryText)}\``;
  } else if (product.deliveryType === 'auto-file' && product.deliveryFileId) {
    bot.sendDocument(chatId, product.deliveryFileId, { caption: `📦 ${product.name} — your file` }).catch(() => {});
  } else {
    deliveryMsg = `\n\n📦 Please wait — admin will deliver shortly.\nOrder ID: \`${order.id}\``;
    notifyAdminOfBuyOrder(order);
  }

  bot.sendMessage(chatId,
    `✅ *Purchase successful!*\n\n${product.emoji} ${product.name} x${qty}\nPaid: ${fmtBoth(totalUsd, totalInr)}${deliveryMsg}`,
    { parse_mode: 'Markdown', reply_markup: backToMenuInline() }
  );
}

function handleCategorySelect(chatId) { sendProductCategories(chatId); }

// ── Profile ───────────────────────────────────────────────────
function sendProfile(chatId, userId) {
  const user    = db.getUser(userId);
  const s       = db.getSettings();
  const joined  = new Date(user.joinedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const refLink = `https://t.me/${s.botUsername}?start=${genRefCode(userId)}`;

  const text =
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n👤 *YOUR PROFILE*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `*Account*\n👤 ${escapeHtml(user.firstName||user.username||'User')}\n🆔 ${user.id}\n📅 Joined ${joined}\n\n` +
    `*Wallet*\n💰 Balance: ${fmtBoth(user.balanceUsd, user.balanceInr)}\n📥 Deposited: ${fmtBoth(user.depositedUsd, user.depositedInr)}\n🛍️ Spent: ${fmtBoth(user.spentUsd, user.spentInr)}\n🛒 Purchases: ${user.purchases}\n\n` +
    `*Referrals*\n👥 Total: ${user.referrals}\n💰 Earned: ${fmtBoth(user.referralEarnedUsd, user.referralEarnedInr)}\n💡 Reward: ${fmtBoth(s.referralRewardUsd, s.referralRewardInr)} per join\n\n` +
    `*Your Referral Link:*\n${refLink}`;

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
}

// ── Deposit ───────────────────────────────────────────────────
function sendDepositMethods(chatId) {
  const s   = db.getSettings();
  const row = [];
  if (s.upiEnabled)     row.push({ text: '📱 UPI',         callback_data: 'deposit_upi' });
  if (s.binanceEnabled) row.push({ text: '💳 Binance Pay', callback_data: 'deposit_binance' });

  if (!row.length)
    return bot.sendMessage(chatId, '⚠️ No payment methods available right now. Please contact support.', { reply_markup: backToMenuInline() });

  bot.sendMessage(chatId,
    `💰 *Deposit Methods*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n✅ Minimum: ${fmtInr(s.minDeposit)}\n⚠️ Manual verification after screenshot\n\nChoose your deposit method:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [row, [{ text: '« Back', callback_data: 'go_main_menu' }]],
      },
    }
  );
}

function sendUpiAppChoice(chatId) {
  bot.sendMessage(chatId,
    `📱 *UPI Payment*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n✅ Minimum: ₹20\n\nChoose your UPI app:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'GPay',    callback_data: 'upiapp_gpay' },
            { text: 'PhonePe', callback_data: 'upiapp_phonepe' },
            { text: 'Any UPI', callback_data: 'upiapp_any' },
          ],
          [{ text: '« Back', callback_data: 'back_deposit_methods' }],
        ],
      },
    }
  );
}

function handleUpiAppChosen(chatId, userId, app) {
  const appNames = { gpay: 'GPay', phonepe: 'PhonePe', any: 'Any UPI' };
  db.setUserState(userId, 'awaiting_deposit_amount', { method: 'upi', app });
  bot.sendMessage(chatId,
    `📱 *${appNames[app]||'UPI'} Payment*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\nEnter amount in ₹ (minimum ₹20):`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'deposit_upi' }]] } }
  );
}

function sendBinanceDepositInfo(chatId, userId) {
  const s = db.getSettings();
  db.setUserState(userId, 'awaiting_deposit_amount', { method: 'binance' });
  bot.sendMessage(chatId,
    `💳 *Binance Pay (USDT)*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `🆔 Binance Pay ID: \`${s.binancePayId||'NOT SET'}\`\n` +
    `👤 Account Name: *${s.binanceAccountName||'NOT SET'}*\n\n` +
    `⚠️ Binance to Binance only — USDT only — Minimum $0.2\n\n` +
    `After sending, enter the USD amount you sent:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'back_deposit_methods' }]] } }
  );
}

function handleDepositAmountInput(chatId, userId, text) {
  const user   = db.getUser(userId);
  const method = user.stateData.method;

  if (!isValidPositiveNumber(text))
    return bot.sendMessage(chatId, '❌ Please enter a valid amount (e.g. 50)');

  const s      = db.getSettings();
  const amount = parseFloat(text.trim());
  let amountInr, amountUsd;

  if (method === 'upi') {
    if (amount < s.minDeposit)
      return bot.sendMessage(chatId, `❌ Minimum deposit is ₹${s.minDeposit}.`);
    amountInr = amount;
    amountUsd = db.round2(amount / s.usdtRate);
  } else {
    if (amount < 0.2)
      return bot.sendMessage(chatId, `❌ Minimum deposit is $0.2.`);
    amountUsd = amount;
    amountInr = Math.round(amount * s.usdtRate);
  }

  const deposit = db.createDeposit({
    userId, username: user.username, method, amountInr, amountUsd,
    prevBalanceUsd: user.balanceUsd, prevBalanceInr: user.balanceInr,
  });

  db.setUserState(userId, 'awaiting_screenshot', { depositId: deposit.id });

  const payButtons = {
    inline_keyboard: [
      [{ text: '✅ I Have Paid',    callback_data: 'i_have_paid' }],
      [{ text: '❌ Cancel Deposit', callback_data: 'cancel_deposit' }],
    ],
  };

  if (method === 'upi') {
    const expiryMin = s.qrValidityMinutes || 15;
    const caption =
      `*TgApiStore — UPI Payment*\n` +
      `⚡ Pay: ${fmtInr(amountInr)} (${fmtUsd(amountUsd)})\n\n` +
      `🧾 Ref ID: \`${deposit.id}\`\n` +
      `💳 UPI ID: \`${s.upiId}\`\n\n` +
      `👉 Scan QR or enter UPI ID above\n` +
      `👉 Pay exactly ${fmtInr(amountInr)} ⚠️ Do Not Change The Amount\n` +
      `🟢 After payment tap ✅ I Have Paid below\n\n` +
      `⚠️ QR Code valid for ${expiryMin} minutes!`;

    // ✅ FIX: Send photo only if QR file_id exists, else send text
    if (s.upiQrFileId && s.upiQrFileId.trim() !== '') {
      bot.sendPhoto(chatId, s.upiQrFileId, {
        caption,
        parse_mode: 'Markdown',
        reply_markup: payButtons,
      }).catch(err => {
        console.error('QR send error:', err.message);
        bot.sendMessage(chatId, caption + '\n\n_(QR image unavailable — pay using UPI ID above)_', {
          parse_mode: 'Markdown',
          reply_markup: payButtons,
        });
      });
    } else {
      bot.sendMessage(chatId, caption + '\n\n_(Admin has not uploaded a QR code yet — pay using the UPI ID above.)_', {
        parse_mode: 'Markdown',
        reply_markup: payButtons,
      });
    }
  } else {
    // Binance — show Binance QR if available
    const caption =
      `💳 *Binance Pay*\n🧾 Ref ID: \`${deposit.id}\`\nAmount: ${fmtUsd(amountUsd)} (${fmtInr(amountInr)})\n\nAfter sending USDT, tap I Have Paid and upload your screenshot.`;

    if (s.binanceQrFileId && s.binanceQrFileId.trim() !== '') {
      bot.sendPhoto(chatId, s.binanceQrFileId, {
        caption,
        parse_mode: 'Markdown',
        reply_markup: payButtons,
      }).catch(() => {
        bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: payButtons });
      });
    } else {
      bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: payButtons });
    }
  }
}

function handleIHavePaid(chatId, userId) {
  bot.sendMessage(chatId, '📸 *Send the screenshot image of your payment now...*', { parse_mode: 'Markdown' });
}

// ✅ FIX: Notify admin with screenshot properly forwarded
function notifyAdminOfDeposit(deposit, fileId) {
  const user   = db.getUser(deposit.userId);
  const joined = user ? new Date(user.joinedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'N/A';

  const text =
    `🆕 *New Deposit Approval Request*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `👤 User: ${deposit.username ? '@' + deposit.username : 'N/A'} (ID: \`${deposit.userId}\`)\n` +
    `📛 Name: ${user ? escapeHtml(user.firstName||user.username||'N/A') : 'N/A'}\n` +
    `📅 Member Since: ${joined}\n` +
    `💼 Total Purchases: ${user ? user.purchases : 0}\n\n` +
    `💳 Method: ${deposit.method.toUpperCase()}\n` +
    `💰 Amount: ${fmtUsd(deposit.amountUsd)} (${fmtInr(deposit.amountInr)})\n` +
    `📊 Previous Balance: ${fmtUsd(deposit.prevBalanceUsd)} (${fmtInr(deposit.prevBalanceInr)})\n` +
    `🧾 Ref ID: \`${deposit.id}\`\n\n` +
    `⏳ _Waiting for admin approval..._`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `a_dep_approve_${deposit.id}` },
        { text: '❌ Reject',  callback_data: `a_dep_reject_${deposit.id}` },
      ],
      [{ text: '💬 Message User', callback_data: `a_msg_user_${deposit.userId}` }],
    ],
  };

  if (!adminPushBot || !ADMIN_NOTIFY_CHAT_ID) {
    console.log('⚠️ ADMIN_BOT_TOKEN / ADMIN_NOTIFY_CHAT_ID not set — deposit not forwarded:', deposit.id);
    return;
  }

  // ✅ FIX: Always send photo with caption if screenshot exists
  if (fileId) {
    adminPushBot.sendPhoto(ADMIN_NOTIFY_CHAT_ID, fileId, {
      caption: text, parse_mode: 'Markdown', reply_markup: replyMarkup,
    }).catch(e => {
      console.error('Admin photo notify failed:', e.message);
      adminPushBot.sendMessage(ADMIN_NOTIFY_CHAT_ID, text + '\n\n_(Screenshot upload failed)_', {
        parse_mode: 'Markdown', reply_markup: replyMarkup,
      }).catch(() => {});
    });
  } else {
    adminPushBot.sendMessage(ADMIN_NOTIFY_CHAT_ID, text + '\n\n_(No screenshot)_', {
      parse_mode: 'Markdown', reply_markup: replyMarkup,
    }).catch(() => {});
  }
}

function notifyAdminOfBuyOrder(order) {
  if (!adminPushBot || !ADMIN_NOTIFY_CHAT_ID) return;
  const user   = db.getUser(order.userId);
  const joined = user ? new Date(user.joinedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'N/A';

  const text =
    `🛒 *New Product Order — Approval Needed*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `👤 User: ${order.username ? '@' + order.username : 'N/A'} (ID: \`${order.userId}\`)\n` +
    `📛 Name: ${user ? escapeHtml(user.firstName||user.username||'N/A') : 'N/A'}\n` +
    `📅 Member Since: ${joined}\n` +
    `💼 Total Purchases: ${user ? user.purchases : 0}\n` +
    `💰 Total Spent: ${user ? fmtBoth(user.spentUsd, user.spentInr) : 'N/A'}\n\n` +
    `📦 Product: *${order.productName}* x${order.qty}\n` +
    `💵 Amount Paid: ${fmtBoth(order.amountUsd, order.amountInr)}\n` +
    `🆔 Order ID: \`${order.id}\``;

  const replyMarkup = {
    inline_keyboard: [
      [{ text: '✅ Approve & Deliver', callback_data: `a_buy_approve_${order.id}` }, { text: '❌ Reject & Refund', callback_data: `a_buy_reject_${order.id}` }],
      [{ text: '💬 Message User', callback_data: `a_msg_user_${order.userId}` }],
    ],
  };

  adminPushBot.sendMessage(ADMIN_NOTIFY_CHAT_ID, text, { parse_mode: 'Markdown', reply_markup: replyMarkup }).catch(() => {});
}

// ── Referral ──────────────────────────────────────────────────
function handleReferEarn(chatId, userId, isRefresh, existingMessageId) {
  const user    = db.getUser(userId);
  const s       = db.getSettings();
  const refLink = `https://t.me/${s.botUsername}?start=${genRefCode(userId)}`;
  const tKey    = todayKey(), wKey = weekKey();

  const todayCount = user.lastReferralDay===tKey ? user.referralsToday : 0;
  const weekCount  = user.lastReferralWeek===wKey ? user.referralsThisWeek : 0;

  const text =
    `🎁 *TgApiStore — Refer & Earn*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `🎫 Earn ${fmtBoth(s.referralRewardUsd, s.referralRewardInr)} for every friend who joins!\n\n` +
    `📊 *Your Performance*\n` +
    `📅 Today: ${todayCount}\n📅 This week: ${weekCount} (resets in ${timeUntilWeekReset()})\n` +
    `✅ Total paid: ${user.referrals}\n` +
    `💰 Total earned: ${fmtBoth(user.referralEarnedUsd, user.referralEarnedInr)}\n\n` +
    `🔗 *Your Referral Link*\n${refLink}\n\n` +
    `📋 *How it works:*\n1️⃣ Share your link\n2️⃣ They join channel & group\n3️⃣ You get paid instantly 🎉\n\n` +
    `🟢 Status: ${s.referralEnabled ? 'ACTIVE' : '🔴 PAUSED'}`;

  const replyMarkup = {
    inline_keyboard: [
      [{ text: '📤 Share My Link', url: `https://t.me/share/url?url=${encodeURIComponent(refLink)}` }],
      [{ text: '🏆 Leaderboard', callback_data: 'leaderboard' }],
      [{ text: '🔄 Refresh',     callback_data: 'refresh_referral' }],
    ],
  };

  if (isRefresh && existingMessageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: existingMessageId, parse_mode: 'Markdown', reply_markup: replyMarkup })
      .catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: replyMarkup }));
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: replyMarkup });
  }
}

function handleLeaderboard(chatId) {
  const users = Object.values(db.getUsers()).filter(u => u.referrals > 0).sort((a,b) => b.referrals-a.referrals).slice(0,10);
  if (!users.length) return bot.sendMessage(chatId, '🏆 *Leaderboard*\n\nNo referrals yet — be the first!', { parse_mode: 'Markdown' });
  let text = `🏆 *Top Referrers*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
  const medals = ['🥇','🥈','🥉'];
  users.forEach((u,i) => { text += `${medals[i]||`${i+1}.`} ${escapeHtml(u.username?'@'+u.username:(u.firstName||'User'))} — ${u.referrals} referrals\n`; });
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
}

// ── Support ───────────────────────────────────────────────────
function handleSupportMenu(chatId) {
  const s = db.getSettings();
  bot.sendMessage(chatId,
    `✅ *TgApiStore Support*\n\n⚠️ All purchases are final — no refunds or replacements under any circumstances.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '📞 Contact Support', url: `https://t.me/${s.supportUserId||s.supportUsername}` }]],
      },
    }
  );
}

function handleContactSupport(chatId) {
  const s = db.getSettings();
  bot.sendMessage(chatId, `📞 Contact our support: @${s.supportUsername}`);
}

module.exports = { bot, sendMainMenu };
