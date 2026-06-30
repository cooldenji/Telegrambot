// user-bot.js — TgApiStore User Bot (v3, rebuilt from scratch)
// Customer-facing bot: browse products, deposit balance, refer friends.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const {
  fmtInr, fmtUsd, fmtBoth, inrToUsd,
  isValidPositiveNumber,
  timeUntilWeekReset,
  escapeHtml, genRefCode, parseRefCode,
  isActiveMember, genId,
} = require('./helpers');

const TOKEN              = process.env.BOT_TOKEN;
const ADMIN_BOT_TOKEN     = process.env.ADMIN_BOT_TOKEN;
const ADMIN_NOTIFY_CHAT_ID = process.env.ADMIN_NOTIFY_CHAT_ID;

if (!TOKEN) { console.error('❌ Missing BOT_TOKEN in .env'); process.exit(1); }

db.initDB();

// ── Force-clear any stuck session before polling starts ──────────
// A 409 Conflict means Telegram still thinks another getUpdates
// connection is open for this token (a previous deploy that didn't
// shut down cleanly, a duplicate replica, etc). Calling deleteWebHook
// with drop_pending_updates resets that server-side lock so THIS
// instance can take over polling cleanly.
const bot = new TelegramBot(TOKEN, { polling: false });

(async () => {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    console.log('🔧 Cleared any stuck webhook/polling session.');
  } catch (e) {
    console.error('Webhook clear failed (non-fatal):', e.message);
  }
  bot.startPolling();
  console.log('✅ User Bot started...');
})();

let adminPushBot = null;
if (ADMIN_BOT_TOKEN) adminPushBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: false });

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

// ── Currency display helper (always shows ₹ + $) ─────────────────
function fmtPrice(amountInr) {
  const s = db.getSettings();
  return fmtBoth(amountInr, s.usdtRate);
}

// ── Navigation: edit-in-place helper (spam reduction) ────────────
// Editing the SAME message for step-by-step menus instead of sending a
// new one each time keeps the chat from filling up with stale screens.
async function navigate(chatId, messageId, text, options = {}) {
  if (messageId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    } catch (e) {
      // fall through to sendMessage — edit not possible (e.g. original
      // message had a photo, or "message is not modified")
    }
  }
  return bot.sendMessage(chatId, text, options);
}

// ── Cross-bot file relay ──────────────────────────────────────────
// A Telegram file_id only works for the bot that originally received
// it. QR images uploaded via the Admin Bot need their bytes re-sent
// through THIS bot once to mint a file_id this bot can actually use.
async function relayPhotoToAdmin(fileId, caption, options = {}) {
  if (!adminPushBot) throw new Error('Admin bot not configured');

  // ── Download as Buffer instead of passing raw URL ───────────────
  // getFileLink() URLs sometimes get rejected by Telegram's own
  // upload-by-URL fetcher (400: failed to get HTTP URL content).
  // Downloading bytes ourselves and sending as a Buffer is reliable.
  const fileStream = bot.getFileStream(fileId);
  const chunks = [];
  for await (const chunk of fileStream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  return adminPushBot.sendPhoto(ADMIN_NOTIFY_CHAT_ID, buffer, { caption, ...options }, {
    filename: 'screenshot.jpg', contentType: 'image/jpeg',
  });
}

// ── Real join verification ────────────────────────────────────────
// Calls Telegram's getChatMember to check if a user is ACTUALLY in the
// channel/group right now. The bot must be an admin in both chats for
// this to work — Telegram requires that to expose membership info.
async function checkOneMembership(chatRef, userId) {
  if (!chatRef) return { ok: true, skipped: true }; // not configured — don't block everyone
  try {
    const member = await bot.getChatMember(chatRef, userId);
    return { ok: isActiveMember(member.status), skipped: false, status: member.status };
  } catch (err) {
    // ── Log the EXACT Telegram error so the real cause is visible ────
    // Common causes:
    //  1. chatRef is wrong (wrong @username / wrong numeric ID)
    //  2. Bot is not an admin in that chat (Telegram blocks getChatMember)
    //  3. chatRef points to a chat this bot was never added to at all
    console.error(`❌ getChatMember FAILED for chatRef="${chatRef}" userId=${userId}:`, err.response?.body?.description || err.message);
    return { ok: false, skipped: false, error: err.message };
  }
}

async function checkJoinStatus(userId) {
  const s = db.getSettings();
  const [channelRes, groupRes] = await Promise.all([
    checkOneMembership(s.channelChatId, userId),
    checkOneMembership(s.groupChatId, userId),
  ]);
  return {
    channelOk: channelRes.ok,
    groupOk: groupRes.ok,
    channelConfigured: !channelRes.skipped,
    groupConfigured: !groupRes.skipped,
    allOk: channelRes.ok && groupRes.ok,
  };
}

// ── Keyboards ──────────────────────────────────────────────────
function joinStepsKeyboard(s) {
  return {
    inline_keyboard: [
      [{ text: '📢 Join Channel', url: s.channelUrl }],
      [{ text: '👥 Join Group', url: s.groupUrl }],
      [{ text: '🔄 Check Status', callback_data: 'check_join' }],
      [{ text: '➡️ Skip', callback_data: 'go_main_menu' }],
    ],
  };
}

function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: '🛍️ Products' }, { text: '💰 Deposit' }],
      [{ text: '👤 My Account' }, { text: '🎁 Refer & Earn' }],
      [{ text: '🏆 Leaderboard' }, { text: '🆘 Support' }],
    ],
    resize_keyboard: true,
  };
}

function backToMenuInline() {
  return { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'go_main_menu' }]] };
}

// ── /start ─────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const payload = match[1] ? match[1].trim() : null;
  const referredBy = payload ? parseRefCode(payload) : null;

  if (db.isBanned(userId)) {
    return bot.sendMessage(chatId, '🚫 You are banned from using this bot. Contact support if you think this is a mistake.');
  }

  const existing = db.getUser(userId);
  const isNew = !existing;

  // Don't let someone refer themselves
  const validReferredBy = (referredBy && referredBy !== userId) ? referredBy : null;

  const user = db.createUserIfNotExists(userId, {
    username: msg.from.username || '',
    firstName: msg.from.first_name || '',
    referredBy: validReferredBy,
  });

  // Referral "click" is counted immediately — the actual REWARD is only
  // credited later, once this user has verified-joined + accepted terms.
  if (isNew && validReferredBy) db.incrementReferralClick(validReferredBy);

  // ── Join gate REMOVED — joining is now optional ──────────────────
  // Everyone goes straight to acceptedTerms=true + main menu. Channel/
  // Group are just suggested (not enforced). Referral reward is credited
  // immediately on first /start instead of waiting for a join-check.
  if (!user.acceptedTerms) {
    db.updateUser(userId, { acceptedTerms: true });
    if (validReferredBy && !user.referralCredited) {
      db.updateUser(userId, { referralCredited: true });
      const s = db.getSettings();
      db.creditReferral(validReferredBy, userId, s.referralRewardInr);
      notifyReferrer(validReferredBy, userId, s.referralRewardInr);
    }
  }

  if (isNew) {
    const s = db.getSettings();
    await bot.sendMessage(chatId,
      `👋 *Welcome to TgApiStore!*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
      `📢 Join our Channel & Group for updates and offers *(optional)*:`,
      { parse_mode: 'Markdown', reply_markup: joinStepsKeyboard(s) }
    );
  }

  return sendMainMenu(chatId, userId);
});

// ── Join check (now purely informational — never blocks access) ──
async function handleJoinCheck(chatId, userId, messageId) {
  const status = await checkJoinStatus(userId);

  if (!status.allOk) {
    const missing = [];
    if (status.channelConfigured && !status.channelOk) missing.push('📢 Channel');
    if (status.groupConfigured && !status.groupOk) missing.push('👥 Group');
    const s = db.getSettings();
    await navigate(chatId, messageId,
      `ℹ️ You haven't joined: ${missing.join(' and ')} yet.\n\n` +
      `This is optional — you can still use the bot freely. Tap below if you'd like to join anyway.`,
      { parse_mode: 'Markdown', reply_markup: joinStepsKeyboard(s) }
    );
    return false;
  }

  await navigate(chatId, messageId,
    `✅ *You're all joined up. Thanks!*`,
    { parse_mode: 'Markdown' }
  );
  sendMainMenu(chatId, userId);
  return true;
}

function notifyReferrer(referrerId, newUserId, rewardInr) {
  bot.sendMessage(referrerId,
    `🎉 *Referral Bonus!*\n\nSomeone joined using your link and ${fmtInr(rewardInr)} (${fmtUsd(inrToUsd(rewardInr, db.getSettings().usdtRate))}) has been added to your balance!`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ── Main Menu ──────────────────────────────────────────────────
function sendMainMenu(chatId, userId) {
  const user = db.getUser(userId);
  bot.sendMessage(chatId,
    `🏠 *Main Menu*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `💰 Balance: *${fmtPrice(user ? user.balanceInr : 0)}*\n\n` +
    `Choose an option below:`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
  );
}

// ── Products ───────────────────────────────────────────────────
function sendProductList(chatId, messageId = null) {
  const products = db.getProducts().filter(p => p.active);
  if (!products.length) {
    return navigate(chatId, messageId, '📦 No products available right now! Check back soon.', { reply_markup: backToMenuInline() });
  }

  let text = `🛍️ *Available Products*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
  products.forEach(p => {
    text += `${p.emoji} *${p.name}*\n💰 ${fmtPrice(p.priceInr)} | 📦 ${p.stock} in stock\n\n`;
  });

  const buttons = [];
  for (let i = 0; i < products.length; i += 2) {
    const row = [{ text: `${products[i].emoji} ${products[i].name}`, callback_data: `prod_${products[i].id}` }];
    if (products[i + 1]) row.push({ text: `${products[i + 1].emoji} ${products[i + 1].name}`, callback_data: `prod_${products[i + 1].id}` });
    buttons.push(row);
  }
  buttons.push([{ text: '🏠 Main Menu', callback_data: 'go_main_menu' }]);

  navigate(chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

function sendProductDetail(chatId, userId, productId, messageId = null) {
  const p = db.getProductById(productId);
  if (!p || !p.active) {
    return navigate(chatId, messageId, '❌ This product is no longer available.', { reply_markup: backToMenuInline() });
  }

  const text =
    `${p.emoji} *${p.name}*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `💰 Price: *${fmtPrice(p.priceInr)}* per unit\n` +
    `📦 In Stock: ${p.stock}\n` +
    (p.description ? `\n📝 ${p.description}\n` : '') +
    `\n${p.stock > 0 ? 'How many would you like to buy?' : '⚠️ Currently out of stock.'}`;

  const buttons = [];
  if (p.stock > 0) {
    buttons.push([
      { text: '1', callback_data: `qty_${p.id}_1` },
      { text: '2', callback_data: `qty_${p.id}_2` },
      { text: '5', callback_data: `qty_${p.id}_5` },
      { text: 'Custom', callback_data: `qty_${p.id}_custom` },
    ]);
  }
  buttons.push([{ text: '« Back to Products', callback_data: 'back_to_products' }]);

  navigate(chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

function handleQtyChosen(chatId, userId, productId, qtyStr, messageId) {
  const p = db.getProductById(productId);
  if (!p) return;

  if (qtyStr === 'custom') {
    db.setUserState(userId, 'awaiting_custom_qty', { productId, navMessageId: messageId });
    return navigate(chatId, messageId, `✏️ Enter the quantity you want to buy:`, {
      reply_markup: { inline_keyboard: [[{ text: '« Cancel', callback_data: `prod_${productId}` }]] },
    });
  }

  const qty = parseInt(qtyStr, 10);
  confirmPurchase(chatId, userId, p, qty, messageId);
}

function confirmPurchase(chatId, userId, product, qty, messageId = null) {
  if (qty > product.stock) {
    return navigate(chatId, messageId, `❌ Only ${product.stock} in stock. Please choose a smaller quantity.`, {
      reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: `prod_${product.id}` }]] },
    });
  }
  const user = db.getUser(userId);
  const totalInr = product.priceInr * qty;

  if (user.balanceInr < totalInr) {
    return navigate(chatId, messageId,
      `❌ *Insufficient balance*\n\nNeeded: ${fmtPrice(totalInr)}\nYour balance: ${fmtPrice(user.balanceInr)}\n\nPlease deposit first.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💰 Deposit', callback_data: 'deposit_methods' }], [{ text: '« Back', callback_data: `prod_${product.id}` }]] } }
    );
  }

  navigate(chatId, messageId,
    `🧾 *Confirm Purchase*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `${product.emoji} ${product.name} x${qty}\n` +
    `💰 Total: *${fmtPrice(totalInr)}*\n` +
    `💼 Balance after: ${fmtPrice(user.balanceInr - totalInr)}\n\n` +
    `⚠️ This order will be manually reviewed and delivered by an admin.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm Purchase', callback_data: `confirm_buy_${product.id}_${qty}` }],
          [{ text: '« Cancel', callback_data: `prod_${product.id}` }],
        ],
      },
    }
  );
}

function finalizePurchase(chatId, userId, productId, qty, messageId) {
  const product = db.getProductById(productId);
  const user = db.getUser(userId);
  if (!product || !user) return;

  const totalInr = product.priceInr * qty;
  if (qty > product.stock) return navigate(chatId, messageId, '❌ Stock changed — please check again.', { reply_markup: backToMenuInline() });
  if (user.balanceInr < totalInr) return navigate(chatId, messageId, '❌ Insufficient balance.', { reply_markup: backToMenuInline() });

  db.deductBalance(userId, totalInr);
  db.decrementStock(productId, qty);
  const order = db.createOrder({
    userId, username: user.username, productId, productName: product.name, qty, amountInr: totalInr,
  });
  db.updateUser(userId, { purchases: (user.purchases || 0) + 1 });

  navigate(chatId, messageId,
    `✅ *Order Placed!*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `🧾 Order ID: \`${order.id}\`\n${product.emoji} ${product.name} x${qty}\n💰 Paid: ${fmtPrice(totalInr)}\n\n` +
    `⏳ An admin will review and deliver this manually. You'll be notified here once it's done.`,
    { parse_mode: 'Markdown', reply_markup: backToMenuInline() }
  );

  notifyAdminOfBuyOrder(order);
}

// ── Account ────────────────────────────────────────────────────
function sendAccount(chatId, userId) {
  const user = db.getUser(userId);
  if (!user) return;
  bot.sendMessage(chatId,
    `👤 *My Account*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `🆔 ID: \`${user.id}\`\n` +
    `📛 Name: ${escapeHtml(user.firstName || user.username || 'N/A')}\n` +
    `💰 Balance: *${fmtPrice(user.balanceInr)}*\n` +
    `🛍️ Total Purchases: ${user.purchases || 0}\n` +
    `🎁 Total Referrals: ${user.referrals || 0}\n` +
    `📅 Member Since: ${new Date(user.joinedAt).toLocaleDateString('en-IN')}`,
    { parse_mode: 'Markdown', reply_markup: backToMenuInline() }
  );
}

// ── Leaderboard ────────────────────────────────────────────────
function sendLeaderboard(chatId, messageId = null) {
  const top = db.getReferralLeaderboard(10);
  if (!top.length) {
    return navigate(chatId, messageId, '🏆 No referrals yet — be the first on the leaderboard!', { reply_markup: backToMenuInline() });
  }
  const medals = ['🥇', '🥈', '🥉'];
  let text = `🏆 *Referral Leaderboard*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
  top.forEach((u, i) => {
    const medal = medals[i] || `${i + 1}.`;
    const name = u.username ? '@' + u.username : (u.firstName || `User ${u.id}`);
    text += `${medal} ${escapeHtml(name)} — *${u.referrals}* referrals\n`;
  });
  navigate(chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
}

// ── Referral System ("Refer & Earn") ─────────────────────────────
async function sendReferEarn(chatId, userId, messageId = null) {
  const user = db.getUser(userId);
  const s = db.getSettings();
  const me = await bot.getMe();
  const refLink = `https://t.me/${me.username}?start=${genRefCode(userId)}`;

  const text =
    `🎁 *Refer & Earn*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `Earn *${fmtPrice(s.referralRewardInr)}* for every friend who joins our channel & group and gets verified!\n\n` +
    `📊 *Your Stats*\n` +
    `🔗 Link clicks: ${user.referralClicks || 0}\n` +
    `✅ Confirmed referrals: ${user.referrals || 0}\n` +
    `💰 Total earned: ${fmtPrice(user.referralEarnedInr || 0)}\n\n` +
    `🔗 *Your Unique Link*\n\`${refLink}\`\n\n` +
    `📋 *How it works:*\n1️⃣ Share your link with friends\n2️⃣ They tap it, join our Channel + Group\n3️⃣ Once verified, you instantly get paid 🎉\n\n` +
    `🟢 Status: ${s.referralEnabled ? 'ACTIVE' : '🔴 PAUSED'}`;

  navigate(chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📤 Share My Link', switch_inline_query: `Join TgApiStore and get rewards! ${refLink}` }],
        [{ text: '🏆 Leaderboard', callback_data: 'leaderboard' }],
        [{ text: '🔄 Refresh', callback_data: 'refresh_referral' }],
        [{ text: '🏠 Main Menu', callback_data: 'go_main_menu' }],
      ],
    },
  });
}

function sendSupport(chatId) {
  const s = db.getSettings();
  const link = s.supportUsername ? `https://t.me/${s.supportUsername}` : (s.supportUserId ? `tg://user?id=${s.supportUserId}` : null);
  bot.sendMessage(chatId,
    `🆘 *Need Help?*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\nContact our support team:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          link ? [{ text: '💬 Contact Support', url: link }] : [{ text: '⚠️ Support not configured yet', callback_data: 'noop' }],
          [{ text: '🏠 Main Menu', callback_data: 'go_main_menu' }],
        ],
      },
    }
  );
}

// ── Deposit Flow (3 methods: UPI, Binance, FamPay) ───────────────
const METHOD_LABELS = { upi: '📱 UPI', binance: '💳 Binance Pay', fampay: '🟣 FamPay' };

function sendDepositMethods(chatId, messageId = null) {
  const s = db.getSettings();
  const buttons = [];
  if (s.upi.enabled)     buttons.push([{ text: '📱 UPI', callback_data: 'dep_method_upi' }]);
  if (s.binance.enabled) buttons.push([{ text: '💳 Binance Pay', callback_data: 'dep_method_binance' }]);
  if (s.fampay.enabled)  buttons.push([{ text: '🟣 FamPay', callback_data: 'dep_method_fampay' }]);

  if (!buttons.length) {
    return navigate(chatId, messageId, '⚠️ No payment methods available right now. Please contact support.', { reply_markup: backToMenuInline() });
  }
  buttons.push([{ text: '🏠 Main Menu', callback_data: 'go_main_menu' }]);

  navigate(chatId, messageId,
    `💰 *Deposit Funds*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n✅ Minimum: ${fmtPrice(s.minDepositInr)}\n⚠️ Manual verification after screenshot upload\n\nChoose a payment method:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

// Each method offers "By QR" or "By ID" — exactly as requested.
function sendMethodChoice(chatId, method, messageId = null) {
  const s = db.getSettings();
  const cfg = s[method];
  const label = METHOD_LABELS[method];

  if (!cfg.qrFileId && !cfg.payId) {
    return navigate(chatId, messageId, `⚠️ ${label} isn't fully set up yet. Please choose another method or contact support.`, {
      reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'deposit_methods' }]] },
    });
  }

  const buttons = [];
  if (cfg.qrFileId) buttons.push({ text: '📷 Pay by QR', callback_data: `dep_via_${method}_qr` });
  if (cfg.payId)    buttons.push({ text: '🔢 Pay by ID', callback_data: `dep_via_${method}_id` });

  navigate(chatId, messageId,
    `${label} *Payment*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\nHow would you like to pay?`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [buttons, [{ text: '« Back', callback_data: 'deposit_methods' }]] },
    }
  );
}

function promptDepositAmount(chatId, userId, method, via, messageId = null) {
  db.setUserState(userId, 'awaiting_deposit_amount', { method, via, navMessageId: messageId });
  const label = METHOD_LABELS[method];
  navigate(chatId, messageId,
    `${label} *Payment*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\nEnter the amount in ₹ (minimum ${fmtInr(db.getSettings().minDepositInr)}):`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: `dep_method_${method}` }]] } }
  );
}

async function handleDepositAmountInput(chatId, userId, text) {
  const user = db.getUser(userId);
  const { method, via, navMessageId } = user.stateData;

  if (!isValidPositiveNumber(text)) {
    return bot.sendMessage(chatId, '❌ Please enter a valid amount (e.g. 100)');
  }

  const s = db.getSettings();
  const amountInr = Math.round(parseFloat(text.trim()));
  if (amountInr < s.minDepositInr) {
    return bot.sendMessage(chatId, `❌ Minimum deposit is ${fmtInr(s.minDepositInr)}.`);
  }

  const deposit = db.createDeposit({
    userId, username: user.username, method, amountInr, prevBalanceInr: user.balanceInr,
  });
  db.setUserState(userId, 'awaiting_screenshot', { depositId: deposit.id });

  // Delete the stale amount-prompt text message — it can't be turned
  // into the photo/text card below via edit, so we clear it instead.
  if (navMessageId) bot.deleteMessage(chatId, navMessageId).catch(() => {});

  const cfg = s[method];
  const label = METHOD_LABELS[method];
  const expiryMin = s.qrValidityMinutes || 15;

  const payButtons = {
    inline_keyboard: [
      [{ text: '✅ I Have Paid', callback_data: 'i_have_paid' }],
      [{ text: '❌ Cancel Deposit', callback_data: 'cancel_deposit' }],
    ],
  };

  let detailsLine = '';
  if (via === 'id') {
    detailsLine =
      method === 'binance'
        ? `🆔 Binance Pay ID: \`${cfg.payId}\`\n👤 Name: *${cfg.accountName || 'N/A'}*\n`
        : `🆔 ${label} ID: \`${cfg.payId}\`\n`;
  }

  const caption =
    `*TgApiStore — ${label} Payment*\n` +
    `⚡ Pay: ${fmtPrice(amountInr)}\n\n` +
    `🧾 Ref ID: \`${deposit.id}\`\n` +
    detailsLine +
    `\n👉 ${via === 'qr' ? 'Scan the QR above' : 'Pay to the ID above'}\n` +
    `👉 Pay exactly ${fmtInr(amountInr)} ⚠️ Do not change the amount\n` +
    `🟢 After payment tap ✅ I Have Paid below\n\n` +
    (via === 'qr' ? `⚠️ QR valid for ${expiryMin} minutes!` : '');

  if (via === 'qr' && cfg.qrFileId) {
    bot.sendPhoto(chatId, cfg.qrFileId, { caption, parse_mode: 'Markdown', reply_markup: payButtons }).catch(err => {
      console.error('QR send error:', err.message);
      bot.sendMessage(chatId, caption + '\n\n_(QR image unavailable — use the ID instead, or contact support)_', {
        parse_mode: 'Markdown', reply_markup: payButtons,
      });
    });
  } else {
    bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: payButtons });
  }
}

function handleIHavePaid(chatId, userId) {
  bot.sendMessage(chatId, '📸 *Send a screenshot of your payment now...*', { parse_mode: 'Markdown' });
}

async function handleDepositScreenshot(chatId, userId, fileId) {
  const user = db.getUser(userId);
  const { depositId } = user.stateData;
  const deposit = db.getDeposit(depositId);
  if (!deposit) return;

  // ── Save user-bot-valid file_id into DB immediately ──────────────
  // fileId here is valid for THIS (user) bot only.
  db.updateDeposit(depositId, { screenshotFileId: fileId });
  db.clearUserState(userId);

  bot.sendMessage(chatId,
    `✅ *Screenshot received!*\n\nYour deposit of ${fmtPrice(deposit.amountInr)} is pending admin approval. You'll be notified here once it's processed.`,
    { parse_mode: 'Markdown', reply_markup: backToMenuInline() }
  );

  // ── Relay screenshot to admin bot ────────────────────────────────
  // We call relayPhotoToAdmin() which:
  //   1. Gets the actual download link via getFileLink(fileId) — user bot owns this
  //   2. Re-sends it via adminPushBot — so admin bot gets its OWN fresh file_id
  // This means admin bot can re-send / preview it anytime without issues.
  notifyAdminOfDeposit(deposit, fileId);
}

// ── Admin notification (with cross-bot photo relay) ──────────────
// IMPORTANT — File ID System:
// fileId received here is valid for the USER BOT only.
// We call relayPhotoToAdmin() which downloads the photo via getFileLink()
// and re-uploads it through the ADMIN BOT — this mints a brand new
// file_id that the admin bot owns and can use forever (preview, resend etc).
// Every new screenshot = new relay = new admin-bot file_id. Automatic. ✅
async function notifyAdminOfDeposit(deposit, fileId) {
  const user = db.getUser(deposit.userId);
  const joined = user ? new Date(user.joinedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'N/A';

  const text =
    `🆕 *New Deposit Approval Request*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `👤 User: ${deposit.username ? '@' + deposit.username : 'N/A'} (ID: \`${deposit.userId}\`)\n` +
    `📛 Name: ${user ? escapeHtml(user.firstName || user.username || 'N/A') : 'N/A'}\n` +
    `📅 Member Since: ${joined}\n` +
    `💼 Total Purchases: ${user ? user.purchases : 0}\n\n` +
    `💳 Method: ${METHOD_LABELS[deposit.method] || deposit.method.toUpperCase()}\n` +
    `💰 Amount: ${fmtPrice(deposit.amountInr)}\n` +
    `📊 Previous Balance: ${fmtPrice(deposit.prevBalanceInr)}\n` +
    `🧾 Ref ID: \`${deposit.id}\`\n\n` +
    `⏳ _Waiting for admin approval..._`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `a_dep_approve_${deposit.id}` },
        { text: '❌ Reject', callback_data: `a_dep_reject_${deposit.id}` },
      ],
      [{ text: '💬 Message User', callback_data: `a_msg_user_${deposit.userId}` }],
    ],
  };

  if (!adminPushBot || !ADMIN_NOTIFY_CHAT_ID) {
    console.log('⚠️ ADMIN_BOT_TOKEN / ADMIN_NOTIFY_CHAT_ID not set — deposit not forwarded:', deposit.id);
    return;
  }

  if (fileId) {
    try {
      // ── RELAY: user-bot file_id → download link → re-upload via admin bot ──
      // This gives admin bot its OWN fresh file_id for this screenshot.
      const relayResult = await relayPhotoToAdmin(fileId, text, {
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
      });

      // Save admin-bot's new file_id into DB so admin panel can preview it anytime
      const adminFileId = relayResult.photo[relayResult.photo.length - 1].file_id;
      db.updateDeposit(deposit.id, { screenshotFileIdAdmin: adminFileId });

    } catch (e) {
      console.error('Admin photo relay failed:', e.message);
      // Fallback: send text-only notification with error note
      adminPushBot.sendMessage(ADMIN_NOTIFY_CHAT_ID,
        text + '\n\n⚠️ _(Screenshot relay failed — ask user to resend)_', {
        parse_mode: 'Markdown', reply_markup: replyMarkup,
      }).catch(() => {});
    }
  } else {
    adminPushBot.sendMessage(ADMIN_NOTIFY_CHAT_ID, text + '\n\n_(No screenshot)_', {
      parse_mode: 'Markdown', reply_markup: replyMarkup,
    }).catch(() => {});
  }
}

function notifyAdminOfBuyOrder(order) {
  if (!adminPushBot || !ADMIN_NOTIFY_CHAT_ID) return;
  const text =
    `🛍️ *New Order — Manual Delivery Needed*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `👤 User: ${order.username ? '@' + order.username : order.userId}\n` +
    `📦 ${order.productName} x${order.qty}\n💰 ${fmtPrice(order.amountInr)}\n🧾 Order ID: \`${order.id}\``;
  adminPushBot.sendMessage(ADMIN_NOTIFY_CHAT_ID, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Mark Delivered', callback_data: `a_buy_approve_${order.id}` }, { text: '❌ Reject & Refund', callback_data: `a_buy_reject_${order.id}` }],
        [{ text: '💬 Message User', callback_data: `a_msg_user_${order.userId}` }],
      ],
    },
  }).catch(() => {});
}

// ── Callback Query Router ─────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const messageId = query.message.message_id;
  const data = query.data;

  if (db.isBanned(userId)) {
    return bot.answerCallbackQuery(query.id, { text: '🚫 You are banned.', show_alert: true });
  }

  try {
    if (data === 'check_join') {
      await bot.answerCallbackQuery(query.id, { text: '🔍 Checking your membership…' });
      await handleJoinCheck(chatId, userId, messageId);
      return;
    } else if (data === 'go_main_menu') {
      sendMainMenu(chatId, userId);
    } else if (data === 'noop') {
      await bot.answerCallbackQuery(query.id, { text: 'Not available yet.' });
      return;

    } else if (data === 'back_to_products')        { sendProductList(chatId, messageId);
    } else if (data.startsWith('prod_'))            { sendProductDetail(chatId, userId, data.replace('prod_', ''), messageId);
    } else if (data.startsWith('qty_')) {
      const parts = data.split('_'); // qty_<productId>_<qty|custom>
      const qtyStr = parts.pop();
      const productId = parts.slice(1).join('_');
      handleQtyChosen(chatId, userId, productId, qtyStr, messageId);
    } else if (data.startsWith('confirm_buy_')) {
      const rest = data.replace('confirm_buy_', '');
      const lastUnderscore = rest.lastIndexOf('_');
      const productId = rest.slice(0, lastUnderscore);
      const qty = parseInt(rest.slice(lastUnderscore + 1), 10);
      finalizePurchase(chatId, userId, productId, qty, messageId);

    } else if (data === 'leaderboard')              { sendLeaderboard(chatId, messageId);
    } else if (data === 'refresh_referral')         { sendReferEarn(chatId, userId, messageId);

    } else if (data === 'deposit_methods')          { sendDepositMethods(chatId, messageId);
    } else if (data.startsWith('dep_method_'))      { sendMethodChoice(chatId, data.replace('dep_method_', ''), messageId);
    } else if (data.startsWith('dep_via_')) {
      const rest = data.replace('dep_via_', ''); // <method>_<qr|id>
      const via = rest.endsWith('_qr') ? 'qr' : 'id';
      const method = rest.replace(/_(qr|id)$/, '');
      promptDepositAmount(chatId, userId, method, via, messageId);
    } else if (data === 'i_have_paid')              { handleIHavePaid(chatId, userId);
    } else if (data === 'cancel_deposit') {
      db.clearUserState(userId);
      await bot.editMessageCaption('❌ Deposit cancelled.', { chat_id: chatId, message_id: messageId }).catch(() =>
        bot.editMessageText('❌ Deposit cancelled.', { chat_id: chatId, message_id: messageId })
      );
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
  } catch (e) {
    console.error('Callback error:', e.message);
    await bot.answerCallbackQuery(query.id, { text: '⚠️ Something went wrong, please try again.' }).catch(() => {});
  }
});

// ── Text message handler ──────────────────────────────────────
bot.on('message', async (msg) => {
  if (msg.photo) return; // handled separately below
  if (!msg.text || msg.text.startsWith('/start')) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();

  if (db.isBanned(userId)) return;

  const user = db.getUser(userId);
  if (!user) return bot.sendMessage(chatId, 'Please send /start first.');

  // ── Stateful text inputs ──────────────────────────────────────
  if (user.state === 'awaiting_deposit_amount') return handleDepositAmountInput(chatId, userId, text);
  if (user.state === 'awaiting_custom_qty') {
    const { productId } = user.stateData;
    const qty = parseInt(text, 10);
    if (!qty || qty < 1) return bot.sendMessage(chatId, '❌ Please enter a valid quantity (e.g. 3)');
    const product = db.getProductById(productId);
    if (!product) return bot.sendMessage(chatId, '❌ Product not found.');
    db.clearUserState(userId);
    return confirmPurchase(chatId, userId, product, qty);
  }

  // ── Reply-keyboard menu buttons ─────────────────────────────────
  switch (text) {
    case '🛍️ Products':    return sendProductList(chatId);
    case '💰 Deposit':      return sendDepositMethods(chatId);
    case '👤 My Account':   return sendAccount(chatId, userId);
    case '🎁 Refer & Earn': return sendReferEarn(chatId, userId);
    case '🏆 Leaderboard':  return sendLeaderboard(chatId);
    case '🆘 Support':      return sendSupport(chatId);
    default:
      return; // ignore unrecognized text rather than spamming "unknown command"
  }
});

// ── Photo message handler (deposit screenshots) ──────────────────
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (db.isBanned(userId)) return;

  const user = db.getUser(userId);
  if (!user || user.state !== 'awaiting_screenshot') return;

  const fileId = msg.photo[msg.photo.length - 1].file_id;
  handleDepositScreenshot(chatId, userId, fileId);
});

// ── Cross-bot command interface (admin bot calls these via sendMessage
// to itself is not possible — instead the ADMIN BOT directly calls
// THIS bot's token for things like balance credit notifications. Those
// are simple sendMessage calls from admin-bot.js, no special handler
// needed here.) Exposed for documentation purposes only.



