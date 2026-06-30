// admin-bot.js — TgApiStore Admin Bot (v3, rebuilt from scratch)
// Owner/Admin-facing bot: manage products, payments, deposits, links, referrals.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const {
  fmtInr, fmtUsd, fmtBoth, inrToUsd,
  isValidPositiveInt, isValidPositiveNumber, isValidChatIdOrUsername,
  escapeHtml, fmtDateTime,
} = require('./helpers');

const TOKEN          = process.env.ADMIN_BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hero.96';
const OWNER_ID        = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null;
const ADMIN_NOTIFY_CHAT_ID = process.env.ADMIN_NOTIFY_CHAT_ID || OWNER_ID;

if (!TOKEN) { console.error('❌ Missing ADMIN_BOT_TOKEN in .env'); process.exit(1); }
if (!OWNER_ID) { console.error('❌ Missing OWNER_ID in .env'); process.exit(1); }

db.initDB();
db.ensureOwner(OWNER_ID);

// ── Force-clear any stuck session before polling starts ──────────
// See user-bot.js for full explanation — same fix for 409 Conflict.
const bot = new TelegramBot(TOKEN, { polling: false });

(async () => {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    console.log('🔧 Cleared any stuck webhook/polling session.');
  } catch (e) {
    console.error('Webhook clear failed (non-fatal):', e.message);
  }
  bot.startPolling();
  console.log('✅ Admin Bot started...');
})();

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

// In-memory session state (resets on restart — fine for a single admin process)
const verifiedSessions = new Set();
const adminState = {};

function isAuthorized(userId) { return db.isAdminOrOwner(userId) && verifiedSessions.has(userId); }
function setAdminState(u, state, data = {}) { adminState[u] = { state, data }; }
function getAdminState(u) { return adminState[u] || null; }
function clearAdminState(u) { delete adminState[u]; }

// ── Cross-bot bridge to the User Bot ─────────────────────────────
// Used for: (1) pushing balance/order notifications to users, and
// (2) relaying QR images so the User Bot ends up with its OWN valid
// file_id, since file_ids never transfer between different bot tokens.
const UserNotifier = process.env.BOT_TOKEN
  ? new TelegramBot(process.env.BOT_TOKEN, { polling: false })
  : null;

function notifyUser(userId, text, extra = {}) {
  if (!UserNotifier) return Promise.resolve();
  return UserNotifier.sendMessage(userId, text, { parse_mode: 'Markdown', ...extra }).catch(() => {});
}

async function mintUserBotFileId(adminFileId) {
  if (!UserNotifier) throw new Error('BOT_TOKEN not configured — cannot relay QR to the user bot');

  // ── Download as Buffer instead of passing raw URL ───────────────
  // bot.getFileLink() sometimes returns a URL that Telegram's own
  // upload-by-URL fetcher rejects (400 Bad Request: failed to get
  // HTTP URL content). Downloading the bytes ourselves and sending
  // them as a Buffer/stream is far more reliable.
  const fileStream = bot.getFileStream(adminFileId); // Admin Bot owns this file_id
  const chunks = [];
  for await (const chunk of fileStream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  const sent = await UserNotifier.sendPhoto(ADMIN_NOTIFY_CHAT_ID, buffer, {
    caption: '🔧 (internal) relayed image — generates a User-Bot-valid file_id',
  }, { filename: 'qr.jpg', contentType: 'image/jpeg' });

  const sizes = sent.photo;
  return sizes[sizes.length - 1].file_id; // now valid for the User Bot
}

// ── Navigation: edit-in-place helper (spam reduction) ────────────
async function navigate(chatId, messageId, text, options = {}) {
  if (messageId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    } catch (e) {
      // fall through — edit impossible (different content type, or unchanged)
    }
  }
  return bot.sendMessage(chatId, text, options);
}

// ── Price display helper (₹ entered → both shown) ────────────────
function fmtPrice(amountInr) {
  const s = db.getSettings();
  return fmtBoth(amountInr, s.usdtRate);
}

// ── /start + password gate ────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id, userId = msg.from.id;

  if (!db.isAdminOrOwner(userId)) {
    return bot.sendMessage(chatId, '🚫 You are not authorized to use this bot.');
  }
  if (verifiedSessions.has(userId)) {
    return sendMainPanel(chatId, userId);
  }
  setAdminState(userId, 'awaiting_password');
  bot.sendMessage(chatId, '🔐 Enter the admin password:');
});

function mainPanelKeyboard(isOwnerUser) {
  const rows = [
    [{ text: '➕ Add Product', callback_data: 'a_add_product' }, { text: '📦 Products', callback_data: 'a_list_products' }],
    [{ text: '📊 Statistics', callback_data: 'a_stats' }, { text: '🔗 Link System', callback_data: 'a_links' }],
    [{ text: '📁 Pending Orders', callback_data: 'a_orders' }, { text: '🧾 Pending Deposits', callback_data: 'a_deposits' }],
    [{ text: '💳 Payment Methods', callback_data: 'a_payments' }, { text: '🚫 Ban / Restrict', callback_data: 'a_ban' }],
    [{ text: '⚙️ Toggles', callback_data: 'a_toggles' }, { text: '👮 Manage Admins', callback_data: 'a_manage_admins' }],
    [{ text: '📢 Broadcast', callback_data: 'a_broadcast' }, { text: '👥 All Users', callback_data: 'a_view_users' }],
  ];
  if (isOwnerUser) {
    rows.push([{ text: '👑 Transfer Ownership', callback_data: 'a_transfer_ownership' }]);
  }
  return { inline_keyboard: rows };
}

function sendMainPanel(chatId, userId, messageId = null) {
  navigate(chatId, messageId, '👋 *Admin Panel*\n\nSelect an option below:',
    { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
}

// ── Products CRUD ────────────────────────────────────────────────
function startAddProduct(chatId, userId) {
  setAdminState(userId, 'awaiting_prod_name', {});
  bot.sendMessage(chatId, '✏️ Send the *product name*:', { parse_mode: 'Markdown' });
}

function sendProductList(chatId, userId, messageId = null) {
  const products = db.getProducts();
  if (!products.length) {
    return navigate(chatId, messageId, '📦 No products yet. Tap "Add Product" to create one.',
      { reply_markup: { inline_keyboard: [[{ text: '➕ Add Product', callback_data: 'a_add_product' }], [{ text: '🔙 « Back', callback_data: 'a_back_main' }]] } });
  }
  const buttons = products.map(p => [{ text: `${p.active ? '🟢' : '🔴'} ${p.emoji} ${p.name} (${p.stock})`, callback_data: `a_prod_${p.id}` }]);
  buttons.push([{ text: '🔙 « Back', callback_data: 'a_back_main' }]);
  navigate(chatId, messageId, `📦 *All Products (${products.length})*\n\nTap a product to manage it:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

function sendProductDetail(chatId, userId, productId, messageId = null) {
  const p = db.getProductById(productId);
  if (!p) return navigate(chatId, messageId, '❌ Product not found.', { reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_list_products' }]] } });

  const text =
    `${p.emoji} *${p.name}*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `💰 Price: ${fmtPrice(p.priceInr)}\n📦 Stock: ${p.stock}\n✅ Sold: ${p.sold || 0}\n` +
    `🟢 Status: ${p.active ? 'Active' : 'Hidden'}\n` +
    (p.description ? `📝 ${p.description}\n` : '');

  navigate(chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Add Stock', callback_data: `a_addstock_${p.id}` }, { text: '💰 Change Price', callback_data: `a_setprice_${p.id}` }],
        [{ text: p.active ? '🔴 Hide' : '🟢 Show', callback_data: `a_toggleprod_${p.id}` }],
        [{ text: '🗑️ Delete', callback_data: `a_delprod_${p.id}` }],
        [{ text: '🔙 « Back', callback_data: 'a_list_products' }],
      ],
    },
  });
}

function startAddStock(chatId, userId, productId) {
  setAdminState(userId, 'awaiting_addstock_qty', { productId });
  bot.sendMessage(chatId, '✏️ Enter quantity to add to stock:');
}

function startSetPrice(chatId, userId, productId) {
  setAdminState(userId, 'awaiting_setprice', { productId });
  bot.sendMessage(chatId, '✏️ Enter the new price in ₹ (just the number — $ is calculated automatically):');
}

function toggleProductActive(chatId, userId, productId, messageId) {
  const p = db.getProductById(productId);
  if (!p) return;
  db.updateProduct(productId, { active: !p.active });
  sendProductDetail(chatId, userId, productId, messageId);
}

function confirmDeleteProduct(chatId, userId, productId, messageId) {
  const p = db.getProductById(productId);
  if (!p) return;
  navigate(chatId, messageId, `⚠️ Delete *${p.name}* permanently? This cannot be undone.`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Yes, delete', callback_data: `a_delprodyes_${p.id}` }, { text: '❌ Cancel', callback_data: `a_prod_${p.id}` }],
      ],
    },
  });
}

function doDeleteProduct(chatId, userId, productId, messageId) {
  db.deleteProduct(productId);
  navigate(chatId, messageId, '🗑️ Product deleted.', { reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_list_products' }]] } });
}

// ── Payment Methods (UPI / Binance / FamPay) — QR + ID, all changeable ──
const METHOD_LABELS = { upi: '📱 UPI', binance: '💳 Binance Pay', fampay: '🟣 FamPay' };

function sendPaymentsMenu(chatId, messageId = null) {
  const s = db.getSettings();
  let text = `💳 *Payment Methods*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
  for (const m of ['upi', 'binance', 'fampay']) {
    const cfg = s[m];
    text += `${METHOD_LABELS[m]}\n` +
      `   QR: ${cfg.qrFileId ? '✅ Uploaded' : '❌ Not set'}\n` +
      `   ID: \`${cfg.payId || 'Not set'}\`\n` +
      (m === 'binance' ? `   Name: \`${cfg.accountName || 'Not set'}\`\n` : '') +
      `   Status: ${cfg.enabled ? '🟢 ON' : '🔴 OFF'}\n\n`;
  }
  navigate(chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📱 Manage UPI', callback_data: 'a_pm_upi' }],
        [{ text: '💳 Manage Binance Pay', callback_data: 'a_pm_binance' }],
        [{ text: '🟣 Manage FamPay', callback_data: 'a_pm_fampay' }],
        [{ text: '🔙 « Back', callback_data: 'a_back_main' }],
      ],
    },
  });
}

function sendMethodManage(chatId, method, messageId = null) {
  const s = db.getSettings();
  const cfg = s[method];
  const label = METHOD_LABELS[method];
  let text = `${label} *Settings*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `QR: ${cfg.qrFileId ? '✅ Uploaded' : '❌ Not set'}\n` +
    `ID: \`${cfg.payId || 'Not set'}\`\n` +
    (method === 'binance' ? `Name: \`${cfg.accountName || 'Not set'}\`\n` : '') +
    `Status: ${cfg.enabled ? '🟢 ON (visible to users)' : '🔴 OFF (hidden from users)'}`;

  const buttons = [
    [{ text: '📷 Upload/Replace QR', callback_data: `a_uploadqr_${method}` }, { text: '👁️ Preview QR', callback_data: `a_previewqr_${method}` }],
    [{ text: '🔢 Change ID', callback_data: `a_setid_${method}` }],
  ];
  if (method === 'binance') buttons.push([{ text: '👤 Change Account Name', callback_data: 'a_setbinancename' }]);
  buttons.push([{ text: '🗑️ Clear QR', callback_data: `a_clearqr_${method}` }]);
  buttons.push([{ text: cfg.enabled ? '🔴 Turn OFF' : '🟢 Turn ON', callback_data: `a_togglepm_${method}` }]);
  buttons.push([{ text: '🔙 « Back', callback_data: 'a_payments' }]);

  navigate(chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

function startUploadQr(chatId, userId, method) {
  setAdminState(userId, 'awaiting_qr_upload', { method });
  bot.sendMessage(chatId, `🖼️ Send the *${METHOD_LABELS[method]}* QR code now as a photo:`, { parse_mode: 'Markdown' });
}

function startSetId(chatId, userId, method) {
  setAdminState(userId, 'awaiting_pm_id', { method });
  const label = method === 'binance' ? 'Binance Pay ID' : `${METHOD_LABELS[method]} ID`;
  bot.sendMessage(chatId, `✏️ Send the new *${label}*:`, { parse_mode: 'Markdown' });
}

function startSetBinanceName(chatId, userId) {
  setAdminState(userId, 'awaiting_binance_name', {});
  bot.sendMessage(chatId, '✏️ Send the new Binance account *display name*:', { parse_mode: 'Markdown' });
}

async function handleQrUpload(chatId, userId, method, adminFileId) {
  const waitMsg = await bot.sendMessage(chatId, '⏳ Saving QR and syncing it to the user bot…');
  try {
    const userBotFileId = await mintUserBotFileId(adminFileId);
    db.updatePaymentMethod(method, { qrFileId: userBotFileId, qrFileIdAdmin: adminFileId });
    await bot.editMessageText(
      `✅ *${METHOD_LABELS[method]} QR saved!*\n\nUsers will now see this QR when depositing.`,
      { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown' }
    );
    bot.sendMessage(chatId, '👁️ Preview (exactly what users will see):');
    bot.sendPhoto(chatId, adminFileId, {}).catch(() => {});
  } catch (e) {
    console.error('QR relay failed:', e.message);
    await bot.editMessageText(
      `❌ Saved locally, but failed to sync to the user bot: ${e.message}\n\n` +
      `Make sure BOT_TOKEN is set in .env and that the Owner has /start'd the User Bot at least once.`,
      { chat_id: chatId, message_id: waitMsg.message_id }
    );
  }
}

function previewQr(chatId, method) {
  const s = db.getSettings();
  const id = s[method].qrFileIdAdmin;
  if (!id) return bot.sendMessage(chatId, `❌ No ${METHOD_LABELS[method]} QR uploaded yet.`);
  bot.sendPhoto(chatId, id, { caption: `${METHOD_LABELS[method]} QR Preview` }).catch(() =>
    bot.sendMessage(chatId, '❌ Failed to load QR preview — try re-uploading it.')
  );
}

function clearQr(chatId, userId, method, messageId) {
  db.updatePaymentMethod(method, { qrFileId: '', qrFileIdAdmin: '' });
  sendMethodManage(chatId, method, messageId);
}

function togglePaymentMethod(chatId, userId, method, messageId) {
  const s = db.getSettings();
  db.updatePaymentMethod(method, { enabled: !s[method].enabled });
  sendMethodManage(chatId, method, messageId);
}

// ── Link System ───────────────────────────────────────────────
function sendLinksMenu(chatId, messageId = null) {
  const s = db.getSettings();
  const text =
    `🔗 *Link & Settings System*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `📢 Channel link: ${s.channelUrl}\n` +
    `🆔 Channel chat ID: ${s.channelChatId || '⚠️ not set (verification skipped)'}\n` +
    `👥 Group link: ${s.groupUrl}\n` +
    `🆔 Group chat ID: ${s.groupChatId || '⚠️ not set (verification skipped)'}\n` +
    `📞 Support: ${s.supportUsername ? '@' + s.supportUsername : '(not set)'}\n` +
    `🆔 Support ID: ${s.supportUserId || '(not set)'}\n` +
    `🤖 User Bot: @${s.botUsername}\n` +
    `⚡ USDT Rate: 1 $ = ₹${s.usdtRate}\n` +
    `📥 Min Deposit: ₹${s.minDepositInr}\n` +
    `🎁 Referral Reward: ₹${s.referralRewardInr}\n` +
    `⏱️ QR Expiry: ${s.qrValidityMinutes} min\n\n` +
    `Tap below to change any value:`;

  navigate(chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📢 Channel Link', callback_data: 'a_set_channel_url' }, { text: '🆔 Channel Chat ID', callback_data: 'a_set_channel_id' }],
        [{ text: '👥 Group Link', callback_data: 'a_set_group_url' }, { text: '🆔 Group Chat ID', callback_data: 'a_set_group_id' }],
        [{ text: '📞 Support @', callback_data: 'a_set_support_u' }, { text: '🆔 Support ID', callback_data: 'a_set_support_id' }],
        [{ text: '🔁 Reassign Support Contact', callback_data: 'a_change_support' }],
        [{ text: '🤖 Bot Username', callback_data: 'a_set_botusername' }],
        [{ text: '⚡ USDT Rate', callback_data: 'a_set_rate' }, { text: '📥 Min Deposit', callback_data: 'a_set_mindeposit' }],
        [{ text: '🎁 Ref Reward', callback_data: 'a_set_ref_reward' }, { text: '⏱️ QR Expiry', callback_data: 'a_set_qr_expiry' }],
        [{ text: '🔙 « Back', callback_data: 'a_back_main' }],
      ],
    },
  });
}

function promptSetting(chatId, userId, settingKey, label) {
  setAdminState(userId, 'awaiting_setting_value', { settingKey, label });
  const s = db.getSettings();
  const current = s[settingKey] !== undefined ? `\n\nCurrent value: \`${s[settingKey]}\`` : '';
  bot.sendMessage(chatId, `✏️ Send the new value for *${label}*:${current}`, { parse_mode: 'Markdown' });
}

function promptChatIdSetting(chatId, userId, settingKey, label) {
  setAdminState(userId, 'awaiting_chatid_value', { settingKey, label });
  const s = db.getSettings();
  const current = s[settingKey] ? `\n\nCurrent value: \`${s[settingKey]}\`` : '\n\n_Not set yet — join verification for this is currently skipped._';
  bot.sendMessage(chatId,
    `🆔 *Set ${label} Chat ID (for join verification)*\n\n` +
    `Send either:\n• \`@public_username\` (if the chat has one), or\n• numeric ID like \`-1001234567890\`\n\n` +
    `⚠️ Different from the invite link. The bot must be an *admin* in that ${label.toLowerCase()} for this to work.` +
    current,
    { parse_mode: 'Markdown' }
  );
}

function startChangeSupport(chatId, userId) {
  if (!db.isOwner(userId)) return;
  setAdminState(userId, 'awaiting_new_support', {});
  bot.sendMessage(chatId,
    '🔁 *Reassign Support Contact*\n\nSend the new support person as either:\n• `@username`\n• numeric Telegram user ID',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a_back_main' }]] } }
  );
}

// ── Toggles ────────────────────────────────────────────────────
function sendTogglesMenu(chatId, messageId = null) {
  const s = db.getSettings();
  const on = (v) => v ? '🟢 ON' : '🔴 OFF';
  navigate(chatId, messageId,
    `⚙️ *Toggles*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `📱 UPI: ${on(s.upi.enabled)}\n💳 Binance Pay: ${on(s.binance.enabled)}\n🟣 FamPay: ${on(s.fampay.enabled)}\n` +
    `🎁 Referral System: ${on(s.referralEnabled)}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `UPI: ${on(s.upi.enabled)}`, callback_data: 'a_togglepm_upi' }],
          [{ text: `Binance: ${on(s.binance.enabled)}`, callback_data: 'a_togglepm_binance' }],
          [{ text: `FamPay: ${on(s.fampay.enabled)}`, callback_data: 'a_togglepm_fampay' }],
          [{ text: `Referral System: ${on(s.referralEnabled)}`, callback_data: 'a_toggle_referral' }],
          [{ text: '🔙 « Back', callback_data: 'a_back_main' }],
        ],
      },
    }
  );
}

// ── Stats ──────────────────────────────────────────────────────
function sendStats(chatId, messageId = null) {
  const products = db.getProducts();
  const orders   = Object.values(db.getOrders());
  const users    = Object.values(db.getUsers());
  const deposits = Object.values(db.getDeposits());
  const approved = deposits.filter(d => d.status === 'approved');

  const text =
    `📊 *Store Statistics*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `👥 Total Users: *${users.length}*\n` +
    `🛍️ Total Orders: *${orders.length}*\n` +
    `✅ Units Sold: *${products.reduce((s, p) => s + (p.sold || 0), 0)}*\n` +
    `📦 In Stock: *${products.reduce((s, p) => s + p.stock, 0)}*\n\n` +
    `💰 Revenue: *${fmtPrice(orders.reduce((s, o) => s + o.amountInr, 0))}*\n` +
    `📥 Deposited: *${fmtPrice(approved.reduce((s, d) => s + d.amountInr, 0))}*\n` +
    `⏳ Pending Deposits: *${deposits.filter(d => d.status === 'pending').length}*\n` +
    `⏳ Pending Orders: *${orders.filter(o => o.status === 'pending_delivery').length}*\n\n` +
    `🎁 Total Referrals: *${users.reduce((s, u) => s + (u.referrals || 0), 0)}*\n\n` +
    (products.length ? `📦 *Per-Product:*\n` + products.map(p => `${p.emoji} ${p.name}: ${p.sold || 0} sold, ${p.stock} left`).join('\n') : '');

  navigate(chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_back_main' }]] } });
}

// ── Pending Deposits ───────────────────────────────────────────
function buildDepositCard(d) {
  return (
    `🧾 *Deposit Request*\n` +
    `👤 User: ${d.username ? '@' + d.username : d.userId} (ID: \`${d.userId}\`)\n` +
    `💳 Method: ${METHOD_LABELS[d.method] || d.method}\n` +
    `💰 Amount: ${fmtPrice(d.amountInr)}\n` +
    `📊 Previous Balance: ${fmtPrice(d.prevBalanceInr)}\n` +
    `🧾 Ref ID: \`${d.id}\`\n` +
    `📅 ${fmtDateTime(d.createdAt)}`
  );
}

function buildDepositButtons(d) {
  return {
    inline_keyboard: [
      [{ text: '✅ Approve', callback_data: `a_dep_approve_${d.id}` }, { text: '❌ Reject', callback_data: `a_dep_reject_${d.id}` }],
      [{ text: '💬 Message User', callback_data: `a_msg_user_${d.userId}` }],
      [{ text: '🔙 « Back to Panel', callback_data: 'a_back_main' }],
    ],
  };
}

function sendPendingDeposits(chatId) {
  const pending = db.getPendingDeposits().sort((a, b) => b.createdAt - a.createdAt);
  if (!pending.length) {
    return bot.sendMessage(chatId, '🧾 No pending deposits right now.', { reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_back_main' }]] } });
  }
  bot.sendMessage(chatId, `🧾 *${pending.length} Pending Deposit${pending.length > 1 ? 's' : ''}* — showing below ↓`, { parse_mode: 'Markdown' });

  pending.forEach((d, i) => {
    const text = `*[${i + 1}/${pending.length}]*\n` + buildDepositCard(d);
    const markup = buildDepositButtons(d);

    // ── Use admin-bot's own file_id (screenshotFileIdAdmin) ──────────
    // screenshotFileIdAdmin is minted when user first sends the screenshot —
    // the user-bot relays it through the admin bot, giving admin bot its
    // own valid file_id. We use that here so preview always works.
    const adminScreenshotId = d.screenshotFileIdAdmin || d.screenshotFileId;

    if (adminScreenshotId) {
      bot.sendPhoto(chatId, adminScreenshotId, { caption: text, parse_mode: 'Markdown', reply_markup: markup }).catch(() => {
        bot.sendMessage(chatId, text + '\n\n_(Screenshot failed to load)_', { parse_mode: 'Markdown', reply_markup: markup });
      });
    } else {
      bot.sendMessage(chatId, text + '\n\n_(No screenshot uploaded yet)_', { parse_mode: 'Markdown', reply_markup: markup });
    }
  });
}

function approveDeposit(chatId, userId, depositId) {
  const d = db.getDeposit(depositId);
  if (!d || d.status !== 'pending') return bot.sendMessage(chatId, '⚠️ Already processed or not found.');
  db.updateDeposit(depositId, { status: 'approved', approvedBy: userId, approvedAt: Date.now() });
  db.addBalance(d.userId, d.amountInr);
  bot.sendMessage(chatId, `✅ Deposit \`${depositId}\` approved. ${fmtPrice(d.amountInr)} credited.`, { parse_mode: 'Markdown' });
  notifyUser(d.userId, `✅ *Deposit Approved!*\n\n${fmtPrice(d.amountInr)} has been added to your balance.`);
}

function rejectDeposit(chatId, userId, depositId) {
  const d = db.getDeposit(depositId);
  if (!d || d.status !== 'pending') return bot.sendMessage(chatId, '⚠️ Already processed or not found.');
  db.updateDeposit(depositId, { status: 'rejected', rejectedBy: userId, rejectedAt: Date.now() });
  bot.sendMessage(chatId, `❌ Deposit \`${depositId}\` rejected.`, { parse_mode: 'Markdown' });
  notifyUser(d.userId, `❌ *Deposit Rejected*\n\nYour deposit of ${fmtPrice(d.amountInr)} could not be verified. Contact support if you believe this is an error.`);
}

// ── Pending Orders (manual delivery) ─────────────────────────────
function sendPendingOrders(chatId) {
  const all = Object.values(db.getOrders()).filter(o => o.status === 'pending_delivery').sort((a, b) => b.createdAt - a.createdAt);
  const orders = all.slice(0, 20);
  if (!orders.length) {
    return bot.sendMessage(chatId, '📁 No pending manual-delivery orders.', { reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_back_main' }]] } });
  }
  let text = `📁 *Pending Orders (${orders.length}${all.length > 20 ? ` of ${all.length}` : ''})*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
  orders.forEach(o => {
    text += `🆔 \`${o.id}\`\n👤 ${o.username ? '@' + o.username : o.userId}\n📦 ${o.productName} x${o.qty}\n💰 ${fmtPrice(o.amountInr)}\n📅 ${fmtDateTime(o.createdAt)}\n\n`;
  });
  const buttons = orders.map(o => [
    { text: `✅ Deliver ${o.productName}`, callback_data: `a_buy_approve_${o.id}` },
    { text: `❌ Reject & Refund`, callback_data: `a_buy_reject_${o.id}` },
  ]);
  buttons.push([{ text: '🔙 « Back', callback_data: 'a_back_main' }]);
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

function approveBuyOrder(chatId, userId, orderId) {
  const o = db.getOrder(orderId);
  if (!o || o.status !== 'pending_delivery') return bot.sendMessage(chatId, '⚠️ Already processed or not found.');
  db.updateOrder(orderId, { status: 'delivered', deliveredBy: userId, deliveredAt: Date.now() });
  bot.sendMessage(chatId, `✅ Order \`${orderId}\` marked as delivered.`, { parse_mode: 'Markdown' });
  notifyUser(o.userId, `✅ *Order Delivered!*\n\n${o.productName} x${o.qty} has been delivered. Thank you for your purchase!`);
}

function rejectBuyOrder(chatId, userId, orderId) {
  const o = db.getOrder(orderId);
  if (!o || o.status !== 'pending_delivery') return bot.sendMessage(chatId, '⚠️ Already processed or not found.');
  db.updateOrder(orderId, { status: 'rejected', rejectedBy: userId, rejectedAt: Date.now() });
  db.addBalance(o.userId, o.amountInr); // refund
  const p = db.getProductById(o.productId);
  if (p) db.updateProduct(o.productId, { stock: p.stock + o.qty, sold: Math.max(0, (p.sold || 0) - o.qty) });
  bot.sendMessage(chatId, `❌ Order \`${orderId}\` rejected and refunded.`, { parse_mode: 'Markdown' });
  notifyUser(o.userId, `❌ *Order Rejected*\n\nYour order for ${o.productName} x${o.qty} was rejected and ${fmtPrice(o.amountInr)} has been refunded to your balance.`);
}

// ── Ban / Restrict ─────────────────────────────────────────────
function startBan(chatId, userId) {
  setAdminState(userId, 'awaiting_ban_userid', {});
  bot.sendMessage(chatId, '🚫 Send the numeric User ID to ban:');
}
function startUnban(chatId, userId) {
  setAdminState(userId, 'awaiting_unban_userid', {});
  bot.sendMessage(chatId, '✅ Send the numeric User ID to unban:');
}

// ── Manage Admins / Ownership ────────────────────────────────────
function sendManageAdmins(chatId, userId, messageId = null) {
  const admins = db.listHiredAdmins();
  let text = `👮 *Hired Admins (${admins.length})*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
  text += admins.length
    ? admins.map(a => `• ${a.username ? '@' + a.username : a.id} (added ${fmtDateTime(a.addedAt)})`).join('\n')
    : '_No hired admins yet._';

  navigate(chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Hire Admin', callback_data: 'a_hire_admin' }],
        [{ text: '➖ Remove Admin', callback_data: 'a_remove_admin' }],
        [{ text: '🔙 « Back', callback_data: 'a_back_main' }],
      ],
    },
  });
}

function startHireAdmin(chatId, userId) {
  if (!db.isOwner(userId)) return;
  setAdminState(userId, 'awaiting_hire_admin', {});
  bot.sendMessage(chatId, '✏️ Send the numeric User ID (or @username, if they\'ve messaged this bot before) to hire as admin:');
}
function startRemoveAdmin(chatId, userId) {
  if (!db.isOwner(userId)) return;
  setAdminState(userId, 'awaiting_remove_admin', {});
  bot.sendMessage(chatId, '✏️ Send the numeric User ID of the admin to remove:');
}

function startTransferOwnership(chatId, userId) {
  if (!db.isOwner(userId)) return;
  setAdminState(userId, 'awaiting_transfer_target', {});
  bot.sendMessage(chatId,
    '⚠️ *Transfer Ownership*\n\nSend the new Owner as either:\n• `@username` (must have messaged this bot at least once)\n• numeric Telegram user ID\n\n' +
    '🚨 *This is irreversible from your side.*',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a_back_main' }]] } }
  );
}

function notifyNewOwner(newOwnerId) {
  bot.sendMessage(newOwnerId, '👑 *You are now the Owner of this bot.*\n\nSend /start to access the full Admin Panel.', { parse_mode: 'Markdown' }).catch(() => {});
}

// ── Broadcast ──────────────────────────────────────────────────
function startBroadcast(chatId, userId) {
  setAdminState(userId, 'awaiting_broadcast_msg', {});
  bot.sendMessage(chatId, '📢 Send the message you want to broadcast to ALL users:');
}

async function doBroadcast(chatId, userId, text) {
  if (!UserNotifier) return bot.sendMessage(chatId, '❌ BOT_TOKEN not configured — cannot broadcast to users.');
  const users = Object.values(db.getUsers());
  let sent = 0, failed = 0;
  const progress = await bot.sendMessage(chatId, `📤 Broadcasting to ${users.length} users…`);

  for (const u of users) {
    try {
      await UserNotifier.sendMessage(u.id, `📢 *Announcement*\n\n${text}`, { parse_mode: 'Markdown' });
      sent++;
    } catch (e) {
      failed++;
    }
    await new Promise(r => setTimeout(r, 50)); // gentle rate-limit pacing
  }
  bot.editMessageText(`✅ Broadcast complete.\n\nSent: ${sent}\nFailed: ${failed}`, { chat_id: chatId, message_id: progress.message_id });
}

// ── Message a specific user ───────────────────────────────────
function startMsgToUser(chatId, userId, targetUserId) {
  setAdminState(userId, 'awaiting_msg_to_user', { targetUserId });
  bot.sendMessage(chatId, `✏️ Send the message to send to user \`${targetUserId}\`:`, { parse_mode: 'Markdown' });
}

// ── View all users ─────────────────────────────────────────────
function sendAllUsers(chatId) {
  const users = Object.values(db.getUsers()).sort((a, b) => b.joinedAt - a.joinedAt).slice(0, 30);
  if (!users.length) return bot.sendMessage(chatId, '👥 No users yet.');
  let text = `👥 *Recent Users (showing ${users.length})*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
  users.forEach(u => {
    text += `${u.username ? '@' + u.username : u.id} — ${fmtPrice(u.balanceInr)} — ${u.referrals || 0} refs${u.banned ? ' 🚫' : ''}\n`;
  });
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_back_main' }]] } });
}

// ── Callback Query Router ─────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const messageId = query.message.message_id;
  const data = query.data;

  if (!isAuthorized(userId)) {
    return bot.answerCallbackQuery(query.id, { text: '🔐 Please /start and log in first.', show_alert: true });
  }

  try {
    if (data === 'a_back_main') {
      clearAdminState(userId);
      sendMainPanel(chatId, userId, messageId);

    } else if (data === 'a_add_product')        { startAddProduct(chatId, userId);
    } else if (data === 'a_list_products')       { sendProductList(chatId, userId, messageId);
    } else if (data.startsWith('a_prod_'))        { sendProductDetail(chatId, userId, data.replace('a_prod_', ''), messageId);
    } else if (data.startsWith('a_addstock_'))    { startAddStock(chatId, userId, data.replace('a_addstock_', ''));
    } else if (data.startsWith('a_setprice_'))    { startSetPrice(chatId, userId, data.replace('a_setprice_', ''));
    } else if (data.startsWith('a_toggleprod_'))  { toggleProductActive(chatId, userId, data.replace('a_toggleprod_', ''), messageId);
    } else if (data.startsWith('a_delprodyes_'))  { doDeleteProduct(chatId, userId, data.replace('a_delprodyes_', ''), messageId);
    } else if (data.startsWith('a_delprod_'))     { confirmDeleteProduct(chatId, userId, data.replace('a_delprod_', ''), messageId);

    } else if (data === 'a_stats')               { sendStats(chatId, messageId);
    } else if (data === 'a_links')               { sendLinksMenu(chatId, messageId);
    } else if (data === 'a_set_channel_url')     { promptSetting(chatId, userId, 'channelUrl', 'Channel invite link (https://t.me/...)');
    } else if (data === 'a_set_group_url')       { promptSetting(chatId, userId, 'groupUrl', 'Group invite link (https://t.me/...)');
    } else if (data === 'a_set_channel_id')      { promptChatIdSetting(chatId, userId, 'channelChatId', 'Channel');
    } else if (data === 'a_set_group_id')        { promptChatIdSetting(chatId, userId, 'groupChatId', 'Group');
    } else if (data === 'a_set_support_u')       { promptSetting(chatId, userId, 'supportUsername', 'Support username (without @)');
    } else if (data === 'a_set_support_id')      { promptSetting(chatId, userId, 'supportUserId', 'Support User ID (numeric)');
    } else if (data === 'a_change_support') {
      if (!db.isOwner(userId)) { await bot.answerCallbackQuery(query.id, { text: '🚫 Only the Owner can reassign support.', show_alert: true }); }
      else startChangeSupport(chatId, userId);
    } else if (data === 'a_set_botusername')     { promptSetting(chatId, userId, 'botUsername', 'User bot username (without @)');
    } else if (data === 'a_set_rate')            { promptSetting(chatId, userId, 'usdtRate', 'USDT/$ to INR rate (number, e.g. 90)');
    } else if (data === 'a_set_mindeposit')      { promptSetting(chatId, userId, 'minDepositInr', 'Minimum deposit in ₹ (number)');
    } else if (data === 'a_set_ref_reward')      { promptSetting(chatId, userId, 'referralRewardInr', 'Referral reward in ₹ (number)');
    } else if (data === 'a_set_qr_expiry')       { promptSetting(chatId, userId, 'qrValidityMinutes', 'QR code validity in minutes (number)');

    } else if (data === 'a_payments')            { sendPaymentsMenu(chatId, messageId);
    } else if (data.startsWith('a_pm_'))         { sendMethodManage(chatId, data.replace('a_pm_', ''), messageId);
    } else if (data.startsWith('a_uploadqr_'))   { startUploadQr(chatId, userId, data.replace('a_uploadqr_', ''));
    } else if (data.startsWith('a_previewqr_'))  { previewQr(chatId, data.replace('a_previewqr_', ''));
    } else if (data.startsWith('a_setid_'))      { startSetId(chatId, userId, data.replace('a_setid_', ''));
    } else if (data === 'a_setbinancename')      { startSetBinanceName(chatId, userId);
    } else if (data.startsWith('a_clearqr_'))    { clearQr(chatId, userId, data.replace('a_clearqr_', ''), messageId);
    } else if (data.startsWith('a_togglepm_'))   { togglePaymentMethod(chatId, userId, data.replace('a_togglepm_', ''), messageId);

    } else if (data === 'a_toggles')             { sendTogglesMenu(chatId, messageId);
    } else if (data === 'a_toggle_referral') {
      const s = db.getSettings();
      db.updateSettings({ referralEnabled: !s.referralEnabled });
      sendTogglesMenu(chatId, messageId);

    } else if (data === 'a_orders')              { sendPendingOrders(chatId);
    } else if (data === 'a_deposits')             { sendPendingDeposits(chatId);
    } else if (data.startsWith('a_dep_approve_')) { approveDeposit(chatId, userId, data.replace('a_dep_approve_', ''));
    } else if (data.startsWith('a_dep_reject_'))  { rejectDeposit(chatId, userId, data.replace('a_dep_reject_', ''));
    } else if (data.startsWith('a_buy_approve_')) { approveBuyOrder(chatId, userId, data.replace('a_buy_approve_', ''));
    } else if (data.startsWith('a_buy_reject_'))  { rejectBuyOrder(chatId, userId, data.replace('a_buy_reject_', ''));
    } else if (data.startsWith('a_msg_user_'))    { startMsgToUser(chatId, userId, data.replace('a_msg_user_', ''));

    } else if (data === 'a_ban')                  { startBan(chatId, userId);
    } else if (data === 'a_unban')                { startUnban(chatId, userId);

    } else if (data === 'a_manage_admins')        { sendManageAdmins(chatId, userId, messageId);
    } else if (data === 'a_hire_admin')           { startHireAdmin(chatId, userId);
    } else if (data === 'a_remove_admin')         { startRemoveAdmin(chatId, userId);
    } else if (data === 'a_transfer_ownership') {
      if (!db.isOwner(userId)) { await bot.answerCallbackQuery(query.id, { text: '🚫 Only the current Owner can transfer ownership.', show_alert: true }); }
      else startTransferOwnership(chatId, userId);
    } else if (data.startsWith('a_transfer_confirm_')) {
      if (!db.isOwner(userId)) { await bot.answerCallbackQuery(query.id, { text: '🚫 Only the Owner can do this.', show_alert: true }); }
      else {
        const newOwnerId = Number(data.replace('a_transfer_confirm_', ''));
        db.transferOwnership(newOwnerId);
        clearAdminState(userId);
        await bot.editMessageText(`✅ *Ownership transferred.*\n\n\`${newOwnerId}\` is now the Owner.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        notifyNewOwner(newOwnerId);
      }

    } else if (data === 'a_broadcast')            { startBroadcast(chatId, userId);
    } else if (data === 'a_view_users')           { sendAllUsers(chatId);
    } else if (data === 'noop') {
      await bot.answerCallbackQuery(query.id, { text: 'Not available.' });
      return;
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
  } catch (e) {
    console.error('Admin callback error:', e.message);
    await bot.answerCallbackQuery(query.id, { text: '⚠️ Something went wrong.' }).catch(() => {});
  }
});

// ── Text message handler (password login + state machine) ───────
bot.on('message', async (msg) => {
  if (msg.photo) return; // handled separately below
  if (!msg.text || msg.text.startsWith('/start')) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();

  if (!db.isAdminOrOwner(userId)) return;

  // ── Password gate ─────────────────────────────────────────────
  const state = getAdminState(userId);
  if (state && state.state === 'awaiting_password') {
    if (text === ADMIN_PASSWORD) {
      verifiedSessions.add(userId);
      clearAdminState(userId);
      bot.sendMessage(chatId, '✅ Logged in!');
      return sendMainPanel(chatId, userId);
    }
    return bot.sendMessage(chatId, '❌ Wrong password. Try again:');
  }

  if (!isAuthorized(userId)) return;
  if (!state) return; // no active prompt — ignore stray text

  switch (state.state) {
    case 'awaiting_prod_name':
      setAdminState(userId, 'awaiting_prod_emoji', { name: text });
      return bot.sendMessage(chatId, '✏️ Send an emoji for this product (e.g. 🎮):');

    case 'awaiting_prod_emoji':
      setAdminState(userId, 'awaiting_prod_price', { ...state.data, emoji: text });
      return bot.sendMessage(chatId, '✏️ Send the price in ₹ (just the number — $ is calculated automatically):');

    case 'awaiting_prod_price': {
      if (!isValidPositiveNumber(text)) return bot.sendMessage(chatId, '❌ Please send a valid number.');
      setAdminState(userId, 'awaiting_prod_stock', { ...state.data, priceInr: Number(text) });
      return bot.sendMessage(chatId, '✏️ Send the initial stock quantity:');
    }

    case 'awaiting_prod_stock': {
      if (!isValidPositiveInt(text)) return bot.sendMessage(chatId, '❌ Please send a valid whole number.');
      setAdminState(userId, 'awaiting_prod_desc', { ...state.data, stock: Number(text) });
      return bot.sendMessage(chatId, '✏️ Send a short description (or send "skip"):');
    }

    case 'awaiting_prod_desc': {
      const description = text.toLowerCase() === 'skip' ? '' : text;
      const product = db.addProduct({ ...state.data, description });
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ *Product added!*\n\n${product.emoji} ${product.name}\n💰 ${fmtPrice(product.priceInr)}\n📦 Stock: ${product.stock}`,
        { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_addstock_qty': {
      if (!isValidPositiveInt(text)) return bot.sendMessage(chatId, '❌ Please send a valid whole number.');
      const { productId } = state.data;
      const p = db.getProductById(productId);
      if (!p) { clearAdminState(userId); return bot.sendMessage(chatId, '❌ Product not found.'); }
      db.updateProduct(productId, { stock: p.stock + Number(text) });
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ Stock updated. New stock: ${p.stock + Number(text)}`, { reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_setprice': {
      if (!isValidPositiveNumber(text)) return bot.sendMessage(chatId, '❌ Please send a valid number.');
      const { productId } = state.data;
      db.updateProduct(productId, { priceInr: Number(text) });
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ Price updated to ${fmtPrice(Number(text))}`, { reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_pm_id': {
      const { method } = state.data;
      db.updatePaymentMethod(method, { payId: text });
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ ${METHOD_LABELS[method]} ID updated to \`${text}\`.`, { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_binance_name': {
      db.updatePaymentMethod('binance', { accountName: text });
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ Binance account name updated to *${text}*.`, { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_setting_value': {
      const { settingKey, label } = state.data;
      let value = text;
      if (['usdtRate', 'minDepositInr', 'referralRewardInr', 'qrValidityMinutes'].includes(settingKey)) {
        if (!isValidPositiveNumber(text)) return bot.sendMessage(chatId, '❌ Please send a valid number.');
        value = Number(text);
      }
      db.updateSettings({ [settingKey]: value });
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ *${label}* updated to \`${value}\`.`, { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_chatid_value': {
      const { settingKey, label } = state.data;
      if (!isValidChatIdOrUsername(text)) {
        return bot.sendMessage(chatId, '❌ Please send a valid `@username` or numeric chat ID (e.g. `-1001234567890`).', { parse_mode: 'Markdown' });
      }
      db.updateSettings({ [settingKey]: text });
      clearAdminState(userId);
      return bot.sendMessage(chatId,
        `✅ *${label} Chat ID* set to \`${text}\`.\n\n⚠️ The bot must be an *admin* in that ${label.toLowerCase()} or the membership check will keep failing.`,
        { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_new_support': {
      const raw = text.replace(/^@/, '');
      const isNumeric = /^\d+$/.test(raw);
      db.setSupportContact(isNumeric ? '' : raw, isNumeric ? raw : '', userId);
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ Support contact reassigned to \`${raw}\`.`, { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_ban_userid': {
      if (!isValidPositiveInt(text)) return bot.sendMessage(chatId, '❌ Please send a valid numeric User ID.');
      db.banUser(Number(text));
      clearAdminState(userId);
      return bot.sendMessage(chatId, `🚫 User \`${text}\` has been banned.`, { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_unban_userid': {
      if (!isValidPositiveInt(text)) return bot.sendMessage(chatId, '❌ Please send a valid numeric User ID.');
      db.unbanUser(Number(text));
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ User \`${text}\` has been unbanned.`, { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_hire_admin': {
      const raw = text.replace(/^@/, '');
      let targetId = /^\d+$/.test(raw) ? Number(raw) : db.resolveUserIdByUsername(raw);
      if (!targetId) {
        return bot.sendMessage(chatId, `❌ Couldn't find @${raw}. Ask them to /start the bot first, or send their numeric ID instead.`);
      }
      db.addHiredAdmin(targetId, /^\d+$/.test(raw) ? '' : raw, userId);
      clearAdminState(userId);
      bot.sendMessage(chatId, `✅ \`${targetId}\` hired as admin.`, { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
      return bot.sendMessage(targetId, '👮 You have been hired as an Admin for this bot. Send /start to log in.').catch(() => {});
    }

    case 'awaiting_remove_admin': {
      if (!isValidPositiveInt(text)) return bot.sendMessage(chatId, '❌ Please send a valid numeric User ID.');
      db.removeHiredAdmin(Number(text));
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ Admin \`${text}\` removed.`, { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_transfer_target': {
      if (!db.isOwner(userId)) { clearAdminState(userId); return; }
      const raw = text.replace(/^@/, '');
      let targetId = /^\d+$/.test(raw) ? Number(raw) : db.resolveUserIdByUsername(raw);
      if (!targetId) {
        return bot.sendMessage(chatId, `❌ Couldn't find @${raw}. Ask them to /start the bot first, or send their numeric ID instead.`);
      }
      clearAdminState(userId);
      return bot.sendMessage(chatId,
        `🚨 *Confirm Ownership Transfer*\n\nTransfer Owner role to \`${targetId}\`?\n\nThis cannot be undone by you afterward.`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: '✅ Yes, transfer ownership', callback_data: `a_transfer_confirm_${targetId}` }],
            [{ text: '❌ Cancel', callback_data: 'a_back_main' }],
          ] },
        });
    }

    case 'awaiting_broadcast_msg':
      clearAdminState(userId);
      return doBroadcast(chatId, userId, text);

    case 'awaiting_msg_to_user': {
      const { targetUserId } = state.data;
      clearAdminState(userId);
      notifyUser(targetUserId, `💬 *Message from Support:*\n\n${text}`);
      return bot.sendMessage(chatId, `✅ Message sent to \`${targetUserId}\`.`, { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    default:
      return;
  }
});

// ── Photo message handler (QR uploads) ────────────────────────────
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!isAuthorized(userId)) return;

  const state = getAdminState(userId);
  if (!state || state.state !== 'awaiting_qr_upload') return;

  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const { method } = state.data;
  clearAdminState(userId);
  await handleQrUpload(chatId, userId, method, fileId);
});






