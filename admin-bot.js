// admin-bot.js — TgApiStore Admin Bot (FIXED)
// Fixes: QR upload working, link change working, toggle system, support ID, screenshot display, $ toggle

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const TelegramBot = require('node-telegram-bot-api');
const db          = require('./db');
const { fmtUsd, fmtInr, fmtMoney, isValidPositiveInt, isValidPositiveNumber, escapeHtml } =
  require('./helpers');

const TOKEN          = process.env.ADMIN_BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hero.96';
const OWNER_ID       = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : 8516417508;

if (!TOKEN) { console.error('❌  Missing ADMIN_BOT_TOKEN'); process.exit(1); }

db.initDB();
db.ensureOwner(OWNER_ID);

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('✅  Admin Bot started...');

// In-memory session
const verifiedSessions = new Set();
const pendingPassword  = new Set();
const adminState       = {};

function isAuthorized(userId) { return db.isAdminOrOwner(userId) && verifiedSessions.has(userId); }
function setAdminState(u, state, data={}) { adminState[u] = { state, data }; }
function getAdminState(u) { return adminState[u] || null; }
function clearAdminState(u) { delete adminState[u]; }

const UserNotifier = process.env.BOT_TOKEN
  ? new TelegramBot(process.env.BOT_TOKEN, { polling: false })
  : null;

function notifyUser(userId, text) {
  if (!UserNotifier) return;
  UserNotifier.sendMessage(userId, text, { parse_mode: 'Markdown' }).catch(() => {});
}
function notifyUserDirect(userId, text) {
  if (!UserNotifier) return Promise.reject(new Error('No UserNotifier'));
  return UserNotifier.sendMessage(userId, text, { parse_mode: 'Markdown' });
}

// ── Currency helper ───────────────────────────────────────────
function fmtDisplay(usd, inr) {
  const s = db.getSettings();
  return s.displayCurrency === 'usd' ? fmtUsd(usd) : `${fmtInr(inr)} (${fmtUsd(usd)})`;
}

// ── Main panel keyboard ───────────────────────────────────────
function mainPanelKeyboard(isOwnerUser) {
  const rows = [
    [{ text: '➕ Add Product', callback_data: 'a_add_product' },    { text: '📦 Products',        callback_data: 'a_list_products' }],
    [{ text: '📊 Statistics',   callback_data: 'a_stats' },         { text: '🔗 Link System',     callback_data: 'a_links' }],
    [{ text: '📁 Sessions',     callback_data: 'a_sessions' },      { text: '🧾 Pending Deposits',callback_data: 'a_deposits' }],
    [{ text: '🖼️ Upload QR',   callback_data: 'a_qr' },            { text: '🚫 Ban / Restrict',  callback_data: 'a_ban' }],
    [{ text: '⚙️ Toggles',     callback_data: 'a_toggles' },       { text: '👮 Manage Admins',   callback_data: 'a_manage_admins' }],
  ];
  if (isOwnerUser) {
    rows.push([
      { text: '📢 Broadcast',  callback_data: 'a_broadcast' },
      { text: '👥 All Users',  callback_data: 'a_view_users' },
    ]);
  }
  return { inline_keyboard: rows };
}

function sendAdminPanel(chatId, userId) {
  const role    = db.isOwner(userId) ? 'Owner' : 'Admin';
  const isOwner = db.isOwner(userId);
  bot.sendMessage(chatId,
    `👋 *Welcome to Admin Panel*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\nLogged in as: *${role}*\n\nSelect an option:`,
    { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(isOwner) }
  );
}

// ── /start ────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!db.isAdminOrOwner(userId))
    return bot.sendMessage(chatId, '🚫 You are not authorized to use this bot.');
  if (verifiedSessions.has(userId)) return sendAdminPanel(chatId, userId);
  pendingPassword.add(userId);
  bot.sendMessage(chatId, '🔐 *Admin Login*\n\nPlease enter the admin password:', { parse_mode: 'Markdown' });
});

// ── /admin <user> ─────────────────────────────────────────────
bot.onText(/\/admin\s+(.+)/, (msg, match) => {
  const chatId = msg.chat.id, userId = msg.from.id;
  if (!db.isOwner(userId)) return bot.sendMessage(chatId, '🚫 Only the Owner can add admins.');
  const target = match[1].trim().replace('@', '');
  if (/^\d+$/.test(target)) {
    db.addHiredAdmin(target, '', userId);
    bot.sendMessage(chatId, `✅ User ID \`${target}\` added as admin.`, { parse_mode: 'Markdown' });
  } else {
    db.addHiredAdmin(0, target, userId);
    bot.sendMessage(chatId, `✅ @${target} added as admin.`, { parse_mode: 'Markdown' });
  }
});

// ── Text router ───────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith('/start') || msg.text.startsWith('/admin')) return;
  const chatId = msg.chat.id, userId = msg.from.id;
  linkHiredAdminId(userId, msg.from.username);
  if (!db.isAdminOrOwner(userId)) return;

  if (pendingPassword.has(userId) && !verifiedSessions.has(userId)) {
    if (msg.text.trim() === ADMIN_PASSWORD) {
      verifiedSessions.add(userId);
      pendingPassword.delete(userId);
      bot.sendMessage(chatId, '✅ Password correct! Access granted.');
      return sendAdminPanel(chatId, userId);
    }
    return bot.sendMessage(chatId, '❌ Incorrect password. Try again:');
  }

  if (!isAuthorized(userId)) {
    pendingPassword.add(userId);
    return bot.sendMessage(chatId, '🔐 Please enter the admin password:');
  }

  const state = getAdminState(userId);
  if (state) return handleAdminStateInput(chatId, userId, msg, state);
});

function linkHiredAdminId(userId, username) {
  if (!username) return;
  const admins = db.listHiredAdmins();
  const match  = admins.find(a => a.id===0 && a.username.toLowerCase()===username.toLowerCase());
  if (match) { db.removeHiredAdmin(0); db.addHiredAdmin(userId, username, match.addedBy); }
}

// ✅ FIX: Photo handler — properly saves QR file_id
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id, userId = msg.from.id;
  if (!isAuthorized(userId)) return;
  const state = getAdminState(userId);
  if (!state) return;

  // ✅ Get the LARGEST photo (best quality)
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  if (state.state === 'awaiting_upi_qr') {
    db.updateSettings({ upiQrFileId: fileId });
    clearAdminState(userId);
    bot.sendMessage(chatId, `✅ *UPI QR code saved!*\n\nFile ID: \`${fileId}\`\n\nUsers will now see this QR when depositing via UPI.`,
      { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    return;
  }
  if (state.state === 'awaiting_binance_qr') {
    db.updateSettings({ binanceQrFileId: fileId });
    clearAdminState(userId);
    bot.sendMessage(chatId, `✅ *Binance QR code saved!*\n\nFile ID: \`${fileId}\`\n\nUsers will now see this QR when depositing via Binance.`,
      { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    return;
  }
  if (state.state === 'awaiting_product_delivery_file') {
    setAdminState(userId, 'awaiting_product_name', { ...state.data, deliveryType: 'auto-file', deliveryFileId: fileId });
    bot.sendMessage(chatId, '✅ File saved. Now send the *product name*:', { parse_mode: 'Markdown' });
    return;
  }
});

bot.on('document', async (msg) => {
  const chatId = msg.chat.id, userId = msg.from.id;
  if (!isAuthorized(userId)) return;
  const state = getAdminState(userId);
  if (!state || state.state !== 'awaiting_product_delivery_file') return;
  setAdminState(userId, 'awaiting_product_name', { ...state.data, deliveryType: 'auto-file', deliveryFileId: msg.document.file_id });
  bot.sendMessage(chatId, '✅ File saved. Now send the *product name*:', { parse_mode: 'Markdown' });
});

// ── Callback query router ─────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId    = query.message.chat.id;
  const userId    = query.from.id;
  const data      = query.data;
  const messageId = query.message.message_id;

  if (!isAuthorized(userId))
    return bot.answerCallbackQuery(query.id, { text: '🔐 Please /start and log in first.', show_alert: true });

  try {
    if (data === 'a_back_main') {
      clearAdminState(userId);
      await bot.editMessageText('👋 *Admin Panel*\n\nSelect an option below:',
        { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });

    } else if (data === 'a_add_product')           { startAddProduct(chatId, userId);
    } else if (data === 'a_list_products')          { sendProductList(chatId, userId);
    } else if (data.startsWith('a_prod_'))          { sendProductDetail(chatId, userId, data.replace('a_prod_',''));
    } else if (data.startsWith('a_addmore_'))       { startAddStock(chatId, userId, data.replace('a_addmore_',''));
    } else if (data.startsWith('a_delprod_'))       { confirmDeleteProduct(chatId, userId, data.replace('a_delprod_',''));
    } else if (data.startsWith('a_delprodyes_'))    { doDeleteProduct(chatId, userId, data.replace('a_delprodyes_',''));
    } else if (data.startsWith('a_toggle_prod_'))   { toggleProductActive(chatId, userId, data.replace('a_toggle_prod_',''));

    } else if (data === 'a_stats')                  { sendStats(chatId);
    } else if (data === 'a_links')                  { sendLinksMenu(chatId);
    } else if (data === 'a_set_channel')            { promptSetting(chatId, userId, 'channelUrl',         'Channel URL (https://t.me/...)');
    } else if (data === 'a_set_group')              { promptSetting(chatId, userId, 'groupUrl',           'Group URL (https://t.me/...)');
    } else if (data === 'a_set_support')            { promptSetting(chatId, userId, 'supportUsername',    'Support username (without @)');
    } else if (data === 'a_set_support_id')         { promptSetting(chatId, userId, 'supportUserId',      'Support User ID (numeric, for direct t.me link)');
    } else if (data === 'a_set_botusername')        { promptSetting(chatId, userId, 'botUsername',        'User bot username (without @)');
    } else if (data === 'a_set_upiid')              { promptSetting(chatId, userId, 'upiId',              'UPI ID');
    } else if (data === 'a_set_binanceid')          { promptSetting(chatId, userId, 'binancePayId',       'Binance Pay ID');
    } else if (data === 'a_set_binancename')        { promptSetting(chatId, userId, 'binanceAccountName', 'Binance Account Name');
    } else if (data === 'a_set_rate')               { promptSetting(chatId, userId, 'usdtRate',           'USDT to INR rate (number, e.g. 90)');
    } else if (data === 'a_set_mindeposit')         { promptSetting(chatId, userId, 'minDeposit',         'Minimum deposit in ₹ (number)');
    } else if (data === 'a_set_ref_reward')         { promptSetting(chatId, userId, 'referralRewardInr',  'Referral reward in ₹ (number)');
    } else if (data === 'a_set_qr_expiry')          { promptSetting(chatId, userId, 'qrValidityMinutes',  'QR code validity in minutes (number)');

    } else if (data === 'a_sessions')               { sendSessionBookings(chatId);
    } else if (data === 'a_deposits')               { sendPendingDeposits(chatId);
    } else if (data.startsWith('a_dep_approve_'))   { approveDeposit(chatId, userId, data.replace('a_dep_approve_',''));
    } else if (data.startsWith('a_dep_reject_'))    { rejectDeposit(chatId, userId, data.replace('a_dep_reject_',''));
    } else if (data.startsWith('a_msg_user_'))      { startMsgToUser(chatId, userId, data.replace('a_msg_user_',''));
    } else if (data.startsWith('a_buy_approve_'))   { approveBuyOrder(chatId, userId, data.replace('a_buy_approve_',''));
    } else if (data.startsWith('a_buy_reject_'))    { rejectBuyOrder(chatId, userId, data.replace('a_buy_reject_',''));

    } else if (data === 'a_qr')                     { sendQrMenu(chatId, userId);
    } else if (data === 'a_upload_upi_qr') {
      setAdminState(userId, 'awaiting_upi_qr');
      await bot.sendMessage(chatId, '🖼️ *Send the UPI QR code image now:*\n\n_Send as a photo (not a file)._', { parse_mode: 'Markdown' });
    } else if (data === 'a_upload_binance_qr') {
      setAdminState(userId, 'awaiting_binance_qr');
      await bot.sendMessage(chatId, '🖼️ *Send the Binance Pay QR code image now:*\n\n_Send as a photo (not a file)._', { parse_mode: 'Markdown' });
    } else if (data === 'a_preview_upi_qr')        { previewQr(chatId, 'upi');
    } else if (data === 'a_preview_binance_qr')     { previewQr(chatId, 'binance');
    } else if (data === 'a_clear_upi_qr') {
      db.updateSettings({ upiQrFileId: '' });
      bot.sendMessage(chatId, '🗑️ UPI QR cleared.', { reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    } else if (data === 'a_clear_binance_qr') {
      db.updateSettings({ binanceQrFileId: '' });
      bot.sendMessage(chatId, '🗑️ Binance QR cleared.', { reply_markup: mainPanelKeyboard(db.isOwner(userId)) });

    } else if (data === 'a_ban') {
      setAdminState(userId, 'awaiting_ban_userid');
      await bot.sendMessage(chatId, '🚫 Send the numeric Telegram User ID to ban:');
    } else if (data === 'a_unban') {
      setAdminState(userId, 'awaiting_unban_userid');
      await bot.sendMessage(chatId, '✅ Send the numeric Telegram User ID to unban:');
    } else if (data === 'a_manage_admins')          { sendManageAdmins(chatId, userId);
    } else if (data.startsWith('a_removeadmin_')) {
      db.removeHiredAdmin(data.replace('a_removeadmin_',''));
      bot.sendMessage(chatId, `✅ Admin removed.`);
      sendManageAdmins(chatId, userId);

    // ── Toggles ──────────────────────────────────────────────
    } else if (data === 'a_toggles')                { sendTogglesMenu(chatId);
    } else if (data === 'a_tog_upi') {
      const s = db.getSettings(); db.updateSettings({ upiEnabled: !s.upiEnabled });
      sendTogglesMenu(chatId);
    } else if (data === 'a_tog_binance') {
      const s = db.getSettings(); db.updateSettings({ binanceEnabled: !s.binanceEnabled });
      sendTogglesMenu(chatId);
    } else if (data === 'a_tog_referral') {
      const s = db.getSettings(); db.updateSettings({ referralEnabled: !s.referralEnabled });
      sendTogglesMenu(chatId);
    } else if (data === 'a_tog_qr') {
      const s = db.getSettings(); db.updateSettings({ qrEnabled: !s.qrEnabled });
      sendTogglesMenu(chatId);
    } else if (data === 'a_tog_currency') {
      const s = db.getSettings();
      db.updateSettings({ displayCurrency: s.displayCurrency === 'usd' ? 'inr' : 'usd' });
      sendTogglesMenu(chatId);

    } else if (data === 'a_broadcast')              { startBroadcast(chatId, userId);
    } else if (data === 'a_view_users')             { sendUserStats(chatId, userId);

    } else if (data === 'a_deliv_file') {
      setAdminState(userId, 'awaiting_product_delivery_file', {});
      bot.sendMessage(chatId, '📎 Send the file (photo or document) to deliver for this product:');
    } else if (data === 'a_deliv_text') {
      setAdminState(userId, 'awaiting_delivery_text', {});
      bot.sendMessage(chatId, '🔑 Send the text/key/code to deliver for this product:');
    } else if (data === 'a_deliv_manual') {
      setAdminState(userId, 'awaiting_product_name', { deliveryType: 'manual' });
      bot.sendMessage(chatId, '✏️ Send the *product name*:', { parse_mode: 'Markdown' });
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
  } catch (err) {
    console.error('callback error:', err.message);
    bot.answerCallbackQuery(query.id, { text: '⚠️ Error, try again.' }).catch(() => {});
  }
});

// ── QR Menu (with preview + clear) ───────────────────────────
function sendQrMenu(chatId, userId) {
  const s = db.getSettings();
  bot.sendMessage(chatId,
    `🖼️ *QR Code Management*\n\n` +
    `UPI QR: ${s.upiQrFileId ? '✅ Uploaded' : '❌ Not set'}\n` +
    `Binance QR: ${s.binanceQrFileId ? '✅ Uploaded' : '❌ Not set'}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 Upload UPI QR',          callback_data: 'a_upload_upi_qr' },    { text: '👁️ Preview UPI QR',      callback_data: 'a_preview_upi_qr' }],
          [{ text: '💳 Upload Binance QR',       callback_data: 'a_upload_binance_qr' },{ text: '👁️ Preview Binance QR',  callback_data: 'a_preview_binance_qr' }],
          [{ text: '🗑️ Clear UPI QR',           callback_data: 'a_clear_upi_qr' },    { text: '🗑️ Clear Binance QR',    callback_data: 'a_clear_binance_qr' }],
          [{ text: '🔙 « Back',                 callback_data: 'a_back_main' }],
        ],
      },
    }
  );
}

function previewQr(chatId, type) {
  const s  = db.getSettings();
  const id = type === 'upi' ? s.upiQrFileId : s.binanceQrFileId;
  if (!id) return bot.sendMessage(chatId, `❌ No ${type.toUpperCase()} QR uploaded yet.`);
  bot.sendPhoto(chatId, id, { caption: `${type.toUpperCase()} QR Code Preview` }).catch(() =>
    bot.sendMessage(chatId, `❌ Failed to load QR. File ID: \`${id}\``, { parse_mode: 'Markdown' })
  );
}

// ── Toggles Menu ──────────────────────────────────────────────
function sendTogglesMenu(chatId) {
  const s = db.getSettings();
  const on  = (v) => v ? '🟢 ON' : '🔴 OFF';

  bot.sendMessage(chatId,
    `⚙️ *Toggles & Settings*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `📱 UPI Payments: ${on(s.upiEnabled)}\n` +
    `💳 Binance Pay: ${on(s.binanceEnabled)}\n` +
    `🎁 Referral System: ${on(s.referralEnabled)}\n` +
    `🖼️ QR System: ${on(s.qrEnabled)}\n` +
    `💱 Display Currency: *${s.displayCurrency === 'usd' ? '$ USD' : '₹ INR'}*\n\n` +
    `Tap any button below to toggle:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `📱 UPI: ${on(s.upiEnabled)}`,           callback_data: 'a_tog_upi' },
           { text: `💳 Binance: ${on(s.binanceEnabled)}`,   callback_data: 'a_tog_binance' }],
          [{ text: `🎁 Referral: ${on(s.referralEnabled)}`, callback_data: 'a_tog_referral' },
           { text: `🖼️ QR: ${on(s.qrEnabled)}`,           callback_data: 'a_tog_qr' }],
          [{ text: `💱 Currency: ${s.displayCurrency === 'usd' ? '$ USD ← switch to ₹ INR' : '₹ INR ← switch to $ USD'}`, callback_data: 'a_tog_currency' }],
          [{ text: '🔙 « Back', callback_data: 'a_back_main' }],
        ],
      },
    }
  );
}

// ── Add Product ───────────────────────────────────────────────
function startAddProduct(chatId, userId) {
  setAdminState(userId, 'awaiting_delivery_choice', {});
  bot.sendMessage(chatId, '➕ *Add New Product*\n\nHow will this product be delivered?', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📄 Auto-send a file',            callback_data: 'a_deliv_file' }],
        [{ text: '🔑 Auto-send a text/key/code',   callback_data: 'a_deliv_text' }],
        [{ text: '✋ Manual delivery (admin later)',callback_data: 'a_deliv_manual' }],
      ],
    },
  });
}

// ── Product list & detail ─────────────────────────────────────
function sendProductList(chatId, userId) {
  const products = db.getProducts();
  if (!products.length) {
    return bot.sendMessage(chatId, '📦 No products yet.', {
      reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_back_main' }]] },
    });
  }
  const buttons = products.map(p => [
    { text: `${p.active ? '🟢' : '🔴'} ${p.emoji} ${p.name} (${p.stock} left)`, callback_data: `a_prod_${p.id}` },
  ]);
  buttons.push([{ text: '🔙 « Back', callback_data: 'a_back_main' }]);
  bot.sendMessage(chatId, '📦 *All Products*\n\nTap to manage:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

function sendProductDetail(chatId, userId, productId) {
  const p = db.getProductById(productId);
  if (!p) return bot.sendMessage(chatId, '⚠️ Product not found.');
  const text =
    `${p.emoji} *${p.name}*\n` +
    `Category: ${p.category}\nPrice: ${fmtDisplay(p.priceUsd, p.priceInr)}\nStock: ${p.stock}\nSold: ${p.sold||0}\nDelivery: ${p.deliveryType}\nStatus: ${p.active ? '🟢 Active' : '🔴 Hidden'}` +
    (p.description ? `\n\nDescription: ${escapeHtml(p.description)}` : '');

  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Add Stock',                               callback_data: `a_addmore_${p.id}` }],
        [{ text: p.active ? '🔴 Hide Product' : '🟢 Show Product', callback_data: `a_toggle_prod_${p.id}` }],
        [{ text: '🗑️ Delete Product',                         callback_data: `a_delprod_${p.id}` }],
        [{ text: '🔙 « Back to List',                         callback_data: 'a_list_products' }],
      ],
    },
  });
}

function startAddStock(chatId, userId, productId) {
  setAdminState(userId, 'awaiting_addstock_qty', { productId });
  bot.sendMessage(chatId, '➕ How many units to add to stock?');
}

function confirmDeleteProduct(chatId, userId, productId) {
  const p = db.getProductById(productId); if (!p) return;
  bot.sendMessage(chatId, `⚠️ Delete *${p.name}* permanently?`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Yes, delete', callback_data: `a_delprodyes_${productId}` },
      { text: '❌ Cancel',      callback_data: `a_prod_${productId}` },
    ]]},
  });
}

function doDeleteProduct(chatId, userId, productId) {
  db.deleteProduct(productId);
  bot.sendMessage(chatId, '🗑️ Product deleted.', { reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_list_products' }]] } });
}

function toggleProductActive(chatId, userId, productId) {
  const p = db.getProductById(productId); if (!p) return;
  db.updateProduct(productId, { active: !p.active });
  sendProductDetail(chatId, userId, productId);
}

// ── Statistics ────────────────────────────────────────────────
function sendStats(chatId) {
  const products = db.getProducts();
  const orders   = Object.values(db.getOrders());
  const users    = Object.values(db.getUsers());
  const deposits = Object.values(db.getDeposits());
  const approved = deposits.filter(d => d.status === 'approved');

  const text =
    `📊 *Store Statistics*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `👥 Total Users: *${users.length}*\n` +
    `🛍️ Total Orders: *${orders.length}*\n` +
    `✅ Units Sold: *${products.reduce((s,p) => s+(p.sold||0), 0)}*\n` +
    `📦 In Stock: *${products.reduce((s,p) => s+p.stock, 0)}*\n\n` +
    `💰 Revenue: *${fmtDisplay(db.round2(orders.reduce((s,o) => s+o.amountUsd,0)), Math.round(orders.reduce((s,o) => s+o.amountInr,0)))}*\n` +
    `📥 Deposited: *${fmtDisplay(db.round2(approved.reduce((s,d) => s+d.amountUsd,0)), Math.round(approved.reduce((s,d) => s+d.amountInr,0)))}*\n` +
    `⏳ Pending Deposits: *${deposits.filter(d => d.status==='pending').length}*\n\n` +
    `📦 *Per-Product:*\n` + products.map(p => `${p.emoji} ${p.name}: ${p.sold||0} sold, ${p.stock} left`).join('\n');

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_back_main' }]] } });
}

// ── Link System ───────────────────────────────────────────────
function sendLinksMenu(chatId) {
  const s = db.getSettings();
  const text =
    `🔗 *Link & Settings System*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `📢 Channel: ${s.channelUrl}\n` +
    `👥 Group: ${s.groupUrl}\n` +
    `📞 Support: @${s.supportUsername}\n` +
    `🆔 Support ID: ${s.supportUserId}\n` +
    `🤖 User Bot: @${s.botUsername}\n` +
    `💳 UPI ID: ${s.upiId}\n` +
    `💳 Binance Pay ID: ${s.binancePayId}\n` +
    `👤 Binance Name: ${s.binanceAccountName}\n` +
    `⚡ USDT Rate: 1 USDT = ₹${s.usdtRate}\n` +
    `📥 Min Deposit: ₹${s.minDeposit}\n` +
    `🎁 Referral Reward: ₹${s.referralRewardInr}\n` +
    `⏱️ QR Expiry: ${s.qrValidityMinutes} min\n\n` +
    `Tap below to change any value:`;

  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📢 Channel',      callback_data: 'a_set_channel' },     { text: '👥 Group',           callback_data: 'a_set_group' }],
        [{ text: '📞 Support @',    callback_data: 'a_set_support' },     { text: '🆔 Support ID',       callback_data: 'a_set_support_id' }],
        [{ text: '🤖 Bot Username', callback_data: 'a_set_botusername' }],
        [{ text: '💳 UPI ID',       callback_data: 'a_set_upiid' }],
        [{ text: '💳 Binance Pay',  callback_data: 'a_set_binanceid' },   { text: '👤 Binance Name',    callback_data: 'a_set_binancename' }],
        [{ text: '⚡ USDT Rate',    callback_data: 'a_set_rate' },         { text: '📥 Min Deposit',     callback_data: 'a_set_mindeposit' }],
        [{ text: '🎁 Ref Reward',   callback_data: 'a_set_ref_reward' },  { text: '⏱️ QR Expiry',      callback_data: 'a_set_qr_expiry' }],
        [{ text: '🔙 « Back',       callback_data: 'a_back_main' }],
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

// ── Session Bookings ──────────────────────────────────────────
function sendSessionBookings(chatId) {
  const orders = Object.values(db.getOrders()).filter(o => o.status==='pending_delivery').sort((a,b) => b.createdAt-a.createdAt).slice(0,20);
  if (!orders.length) {
    return bot.sendMessage(chatId, '📁 No pending manual-delivery orders.', { reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_back_main' }]] } });
  }
  let text = `📁 *Pending Manual Deliveries*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
  orders.forEach(o => {
    const date = new Date(o.createdAt).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
    text += `🆔 \`${o.id}\`\n👤 ${o.username?'@'+o.username:o.userId}\n📦 ${o.productName} x${o.qty}\n💰 ${fmtDisplay(o.amountUsd, o.amountInr)}\n📅 ${date}\n\n`;
  });
  const buttons = orders.map(o => [
    { text: `✅ Approve ${o.productName}`, callback_data: `a_buy_approve_${o.id}` },
    { text: `❌ Reject & Refund`,          callback_data: `a_buy_reject_${o.id}` },
  ]);
  buttons.push([{ text: '🔙 « Back', callback_data: 'a_back_main' }]);
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

// ── Deposit Approvals ─────────────────────────────────────────
function buildDepositCard(d) {
  const user   = db.getUser(d.userId);
  const joined = user ? new Date(user.joinedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'N/A';
  const userLink = d.username ? `@${d.username}` : `[User](tg://user?id=${d.userId})`;

  return (
    `🆕 *New Deposit Request*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `👤 *User:* ${userLink}\n🆔 *ID:* \`${d.userId}\`\n` +
    `📛 *Name:* ${escapeHtml(user ? (user.firstName||user.username||'N/A') : 'N/A')}\n` +
    `📅 *Member Since:* ${joined}\n💼 *Total Purchases:* ${user ? user.purchases : 0}\n` +
    `💰 *Total Spent:* ${user ? fmtDisplay(user.spentUsd, user.spentInr) : 'N/A'}\n\n` +
    `💳 *Method:* ${d.method.toUpperCase()}\n` +
    `💵 *Amount:* ${fmtUsd(d.amountUsd)} (${fmtInr(d.amountInr)})\n` +
    `📊 *Prev Balance:* ${fmtUsd(d.prevBalanceUsd)} (${fmtInr(d.prevBalanceInr)})\n` +
    `🧾 *Ref ID:* \`${d.id}\``
  );
}

function buildDepositButtons(d) {
  return {
    inline_keyboard: [
      [{ text: '✅ Approve', callback_data: `a_dep_approve_${d.id}` }, { text: '❌ Reject', callback_data: `a_dep_reject_${d.id}` }],
      [{ text: '💬 Message User', callback_data: `a_msg_user_${d.userId}` }],
    ],
  };
}

function sendPendingDeposits(chatId) {
  const pending = db.getPendingDeposits().sort((a,b) => b.createdAt-a.createdAt);
  if (!pending.length)
    return bot.sendMessage(chatId, '🧾 No pending deposits right now.', { reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_back_main' }]] } });

  pending.forEach(d => {
    const text   = buildDepositCard(d);
    const markup = buildDepositButtons(d);

    // ✅ FIX: Show screenshot properly
    if (d.screenshotFileId && d.screenshotFileId.trim() !== '') {
      bot.sendPhoto(chatId, d.screenshotFileId, {
        caption: text, parse_mode: 'Markdown', reply_markup: markup,
      }).catch(() => {
        bot.sendMessage(chatId, text + '\n\n_(Screenshot failed to load)_', { parse_mode: 'Markdown', reply_markup: markup });
      });
    } else {
      bot.sendMessage(chatId, text + '\n\n_(No screenshot uploaded yet)_', { parse_mode: 'Markdown', reply_markup: markup });
    }
  });
}

function approveDeposit(chatId, adminUserId, depositId) {
  const deposit = db.getDeposit(depositId);
  if (!deposit || deposit.status !== 'pending')
    return bot.sendMessage(chatId, '⚠️ Deposit already processed or not found.');

  db.updateDeposit(depositId, { status: 'approved', decidedAt: Date.now(), decidedBy: adminUserId });
  db.addBalance(deposit.userId, deposit.amountUsd, deposit.amountInr);
  const user = db.getUser(deposit.userId);
  if (user) db.updateUser(deposit.userId, {
    depositedUsd: db.round2(user.depositedUsd + deposit.amountUsd),
    depositedInr: Math.round(user.depositedInr + deposit.amountInr),
  });

  bot.sendMessage(chatId,
    `✅ *Deposit Approved!*\n\nUser \`${deposit.userId}\` — ${fmtUsd(deposit.amountUsd)} (${fmtInr(deposit.amountInr)}) credited.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 Message User', callback_data: `a_msg_user_${deposit.userId}` }]] } }
  );
  notifyUser(deposit.userId,
    `✅ *Deposit Approved!*\n\nYour deposit of ${fmtUsd(deposit.amountUsd)} (${fmtInr(deposit.amountInr)}) has been credited to your balance! 🎉`
  );
}

function rejectDeposit(chatId, adminUserId, depositId) {
  const deposit = db.getDeposit(depositId);
  if (!deposit || deposit.status !== 'pending')
    return bot.sendMessage(chatId, '⚠️ Deposit already processed or not found.');

  db.updateDeposit(depositId, { status: 'rejected', decidedAt: Date.now(), decidedBy: adminUserId });
  bot.sendMessage(chatId, `❌ *Deposit Rejected.*\n\nRef: \`${depositId}\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 Message User', callback_data: `a_msg_user_${deposit.userId}` }]] } }
  );
  notifyUser(deposit.userId,
    `❌ *Deposit Rejected*\n\nYour deposit (Ref: \`${depositId}\`) was rejected. Contact support if you believe this is a mistake.`
  );
}

// ── Buy order approval ────────────────────────────────────────
function approveBuyOrder(chatId, adminUserId, orderId) {
  const orders = db.getOrders(); const order = orders[orderId];
  if (!order) return bot.sendMessage(chatId, '⚠️ Order not found.');
  if (order.status !== 'pending_delivery') return bot.sendMessage(chatId, '⚠️ Order already processed.');
  db.updateOrder(orderId, { status: 'completed', approvedAt: Date.now(), approvedBy: adminUserId });
  bot.sendMessage(chatId, `✅ *Order Approved!*\n\n\`${orderId}\` marked as completed.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 Message User', callback_data: `a_msg_user_${order.userId}` }]] } }
  );
  notifyUser(order.userId, `✅ *Your order is approved!*\n\n📦 *${order.productName}* x${order.qty}\n\nOur team will deliver shortly. Order ID: \`${orderId}\``);
}

function rejectBuyOrder(chatId, adminUserId, orderId) {
  const orders = db.getOrders(); const order = orders[orderId];
  if (!order) return bot.sendMessage(chatId, '⚠️ Order not found.');
  if (order.status !== 'pending_delivery') return bot.sendMessage(chatId, '⚠️ Order already processed.');
  db.addBalance(order.userId, order.amountUsd, order.amountInr);
  db.updateOrder(orderId, { status: 'rejected', rejectedAt: Date.now(), rejectedBy: adminUserId });
  bot.sendMessage(chatId, `❌ *Order Rejected & Refunded.*\n\n${fmtDisplay(order.amountUsd, order.amountInr)} refunded.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 Message User', callback_data: `a_msg_user_${order.userId}` }]] } }
  );
  notifyUser(order.userId, `❌ *Order Rejected*\n\nYour order for *${order.productName}* was rejected. ${fmtDisplay(order.amountUsd, order.amountInr)} refunded to your balance.`);
}

// ── Message to user ───────────────────────────────────────────
function startMsgToUser(chatId, adminUserId, targetUserId) {
  setAdminState(adminUserId, 'awaiting_msg_to_user', { targetUserId });
  bot.sendMessage(chatId, `💬 *Send Message to User* \`${targetUserId}\`\n\nType your message:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a_back_main' }]] } }
  );
}

// ── Broadcast ─────────────────────────────────────────────────
function startBroadcast(chatId, userId) {
  if (!db.isOwner(userId)) return bot.sendMessage(chatId, '🚫 Only the Owner can broadcast.');
  setAdminState(userId, 'awaiting_broadcast_msg');
  bot.sendMessage(chatId, `📢 *Broadcast to All Users*\n\nSend your message now:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a_back_main' }]] } }
  );
}

async function doBroadcast(chatId, userId, text) {
  if (!db.isOwner(userId)) return;
  const users = Object.values(db.getUsers());
  bot.sendMessage(chatId, `📢 Broadcasting to ${users.length} users...`);
  let sent = 0, failed = 0;
  for (const user of users) {
    try { await notifyUserDirect(user.id, `📢 *Message from Admin:*\n\n${text}`); sent++; }
    catch { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  bot.sendMessage(chatId, `✅ *Broadcast Complete!*\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}`,
    { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(true) }
  );
}

// ── View all users ────────────────────────────────────────────
function sendUserStats(chatId, userId) {
  if (!db.isOwner(userId)) return bot.sendMessage(chatId, '🚫 Only the Owner can view users.');
  const users    = Object.values(db.getUsers());
  const bans     = db.getBans ? Object.values(db.getBans()) : [];
  const newToday = users.filter(u => Date.now() - u.joinedAt < 86400000).length;
  let text =
    `👥 *All Users Overview*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `📊 Total: *${users.length}*\n🆕 Joined Today: *${newToday}*\n🚫 Banned: *${bans.length}*\n\n*Recent (last 10):*\n`;
  users.sort((a,b) => b.joinedAt-a.joinedAt).slice(0,10).forEach((u,i) => {
    const name   = u.username ? '@'+u.username : (u.firstName||u.id);
    const joined = new Date(u.joinedAt).toLocaleDateString('en-IN');
    text += `${i+1}. ${escapeHtml(String(name))} — \`${u.id}\` — ${joined}\n`;
  });
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 « Back', callback_data: 'a_back_main' }]] } });
}

// ── Manage admins ─────────────────────────────────────────────
function sendManageAdmins(chatId, userId) {
  if (!db.isOwner(userId)) return bot.sendMessage(chatId, '🚫 Only the Owner can manage admins.');
  const admins = db.listHiredAdmins();
  let text = `👮 *Manage Admins*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\nUse \`/admin <id_or_username>\` to add.\n\n`;
  text += admins.length ? `*Current Admins:*\n` + admins.map(a => `• ${a.username?'@'+a.username:a.id} (ID: \`${a.id}\`)`).join('\n') : '_No hired admins yet._';
  const buttons = admins.map(a => [{ text: `🗑️ Remove ${a.username?'@'+a.username:a.id}`, callback_data: `a_removeadmin_${a.id}` }]);
  buttons.push([{ text: '🔙 « Back', callback_data: 'a_back_main' }]);
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

// ── Admin state input handler ─────────────────────────────────
function handleAdminStateInput(chatId, userId, msg, state) {
  const text = (msg.text || '').trim();

  switch (state.state) {
    case 'awaiting_broadcast_msg':
      clearAdminState(userId);
      return doBroadcast(chatId, userId, text);

    case 'awaiting_msg_to_user': {
      const { targetUserId } = state.data;
      clearAdminState(userId);
      notifyUser(targetUserId, `💬 *Message from Admin:*\n\n${text}`);
      return bot.sendMessage(chatId, `✅ Message sent to \`${targetUserId}\`.`,
        { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_delivery_text':
      setAdminState(userId, 'awaiting_product_name', { deliveryType: 'auto-text', deliveryText: text });
      return bot.sendMessage(chatId, '✅ Saved. Now send the *product name*:', { parse_mode: 'Markdown' });

    case 'awaiting_product_name':
      setAdminState(userId, 'awaiting_product_emoji', { ...state.data, name: text });
      return bot.sendMessage(chatId, '🎨 Send an emoji for this product (e.g. 🔑, 📦, 💎):');

    case 'awaiting_product_emoji':
      setAdminState(userId, 'awaiting_product_category', { ...state.data, emoji: text });
      return bot.sendMessage(chatId, '🏷️ Send a category (e.g. "General" or "Keys"):');

    case 'awaiting_product_category':
      setAdminState(userId, 'awaiting_product_price_usd', { ...state.data, category: text });
      return bot.sendMessage(chatId, '💵 Send the price in USD (e.g. 0.50):');

    case 'awaiting_product_price_usd':
      if (!isValidPositiveNumber(text)) return bot.sendMessage(chatId, '❌ Valid number please (e.g. 0.50)');
      setAdminState(userId, 'awaiting_product_price_inr', { ...state.data, priceUsd: parseFloat(text) });
      return bot.sendMessage(chatId, '💵 Send the price in ₹ INR (e.g. 45):');

    case 'awaiting_product_price_inr':
      if (!isValidPositiveNumber(text)) return bot.sendMessage(chatId, '❌ Valid number please (e.g. 45)');
      setAdminState(userId, 'awaiting_product_stock', { ...state.data, priceInr: parseFloat(text) });
      return bot.sendMessage(chatId, '📦 How many units in stock?');

    case 'awaiting_product_stock':
      if (!isValidPositiveInt(text)) return bot.sendMessage(chatId, '❌ Valid number please (e.g. 10)');
      setAdminState(userId, 'awaiting_product_description', { ...state.data, stock: parseInt(text,10) });
      return bot.sendMessage(chatId, '📝 Send a short description (or "-" to skip):');

    case 'awaiting_product_description': {
      const product = db.addProduct({ ...state.data, description: text==='-' ? '' : text });
      clearAdminState(userId);
      return bot.sendMessage(chatId,
        `✅ *Product added!*\n\n${product.emoji} ${product.name}\n${fmtDisplay(product.priceUsd, product.priceInr)} | ${product.stock} in stock`,
        { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_addstock_qty': {
      if (!isValidPositiveInt(text)) return bot.sendMessage(chatId, '❌ Valid number please');
      const qty = parseInt(text,10);
      const p   = db.getProductById(state.data.productId);
      if (!p) { clearAdminState(userId); return; }
      db.updateProduct(p.id, { stock: p.stock + qty });
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ Added ${qty} units. New stock: ${p.stock + qty}`,
        { reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_setting_value': {
      const { settingKey, label } = state.data;
      let value = text;
      if (['usdtRate','minDeposit','referralRewardInr','referralRewardUsd','qrValidityMinutes'].includes(settingKey)) {
        if (!isValidPositiveNumber(text)) return bot.sendMessage(chatId, '❌ Please enter a valid number');
        value = parseFloat(text);
      }
      db.updateSettings({ [settingKey]: value });
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ *${label}* updated to: \`${value}\``,
        { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });
    }

    case 'awaiting_ban_userid':
      if (!isValidPositiveInt(text)) return bot.sendMessage(chatId, '❌ Valid numeric user ID please');
      db.banUser(text, 'Manual ban by admin', userId);
      clearAdminState(userId);
      return bot.sendMessage(chatId, `🚫 User \`${text}\` banned.`,
        { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });

    case 'awaiting_unban_userid':
      if (!isValidPositiveInt(text)) return bot.sendMessage(chatId, '❌ Valid numeric user ID please');
      db.unbanUser(text);
      clearAdminState(userId);
      return bot.sendMessage(chatId, `✅ User \`${text}\` unbanned.`,
        { parse_mode: 'Markdown', reply_markup: mainPanelKeyboard(db.isOwner(userId)) });

    default:
      clearAdminState(userId);
  }
}

module.exports = { bot, sendAdminPanel, mainPanelKeyboard };
