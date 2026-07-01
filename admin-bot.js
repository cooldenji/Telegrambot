// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// admin-bot.js — CLOUDE CART 🛒 | Admin/Owner Bot
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const h  = require('./helpers');

const bot        = new TelegramBot(process.env.ADMIN_BOT_TOKEN, { polling: true });
const OWNER_ID   = String(process.env.OWNER_ID);
const PASSWORD   = process.env.ADMIN_PASSWORD;
const ADMIN_NOTIFY_CHAT_ID = process.env.ADMIN_NOTIFY_CHAT_ID;

// ── Cross-bot setup ────────────────────────────────────
// userBot is required after both bots are created
let userBotModule = null;
setTimeout(() => {
  userBotModule = require('./user-bot');
  h.setBots(userBotModule.bot, bot);
}, 500);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTH HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const _authenticated = new Set(); // in-memory session

function isAuthorized(userId) {
  const id = String(userId);
  return id === OWNER_ID || db.isAdmin(id);
}

function isOwner(userId) {
  return String(userId) === OWNER_ID;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS — edit-in-place
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
// /start — login flow
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (!isAuthorized(userId)) {
    if (_authenticated.has(userId)) return showAdminPanel(chatId, null, userId);
    h.setAdminState(userId, 'awaiting_password');
    return send(chatId, `🔐 <b>Welcome to CLOUDE CART Admin Panel</b>\n\nPlease enter the admin password:`);
  }

  _authenticated.add(userId);
  return showAdminPanel(chatId, null, userId);
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const state  = h.getAdminState(userId);

  // Password check
  if (state?.state === 'awaiting_password') {
    if (msg.text.trim() === PASSWORD) {
      _authenticated.add(userId);
      h.clearAdminState(userId);
      return showAdminPanel(chatId, null, userId);
    } else {
      return send(chatId, `❌ Wrong password. Try again:`);
    }
  }

  if (!isAuthorized(userId) && !_authenticated.has(userId)) return;

  // Multi-step text inputs
  if (!state) return;

  switch (state.state) {
    case 'awaiting_join_url':   return handleJoinUrlInput(chatId, userId, msg.text, state.data);
    case 'awaiting_join_name':  return handleJoinNameInput(chatId, userId, msg.text, state.data);
    case 'awaiting_product_name':  return handleProductInput(chatId, userId, msg.text, 'name', state.data);
    case 'awaiting_product_price': return handleProductInput(chatId, userId, msg.text, 'price', state.data);
    case 'awaiting_product_stock': return handleProductInput(chatId, userId, msg.text, 'stock', state.data);
    case 'awaiting_product_emoji': return handleProductInput(chatId, userId, msg.text, 'emoji', state.data);
    case 'awaiting_product_desc':  return handleProductInput(chatId, userId, msg.text, 'desc', state.data);
    case 'awaiting_upi_id':        return handleUpiIdInput(chatId, userId, msg.text, state.data);
    case 'awaiting_upi_name':      return handleUpiNameInput(chatId, userId, msg.text, state.data);
    case 'awaiting_binance_id':    return handleBinanceIdInput(chatId, userId, msg.text, state.data);
    case 'awaiting_binance_name':  return handleBinanceNameInput(chatId, userId, msg.text, state.data);
    case 'awaiting_support_username': return handleSupportUsernameInput(chatId, userId, msg.text);
    case 'awaiting_rate':          return handleRateInput(chatId, userId, msg.text);
    case 'awaiting_min_deposit':   return handleMinDepositInput(chatId, userId, msg.text);
    case 'awaiting_hire_admin_id': return handleHireAdminInput(chatId, userId, msg.text);
    case 'awaiting_flash_product': return handleFlashProductInput(chatId, userId, msg.text, state.data);
    case 'awaiting_flash_discount':return handleFlashDiscountInput(chatId, userId, msg.text, state.data);
    case 'awaiting_flash_hours':   return handleFlashHoursInput(chatId, userId, msg.text, state.data);
    case 'awaiting_broadcast':     return handleBroadcastInput(chatId, userId, msg.text);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMIN PANEL MAIN MENU
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showAdminPanel(chatId, msgId, userId) {
  const text = `⚙️ <b>CLOUDE CART — Admin Panel</b>\n\nChoose an option:`;
  const keyboard = [
    [
      { text: '🔗 Change Join URL',    callback_data: 'adm_join_url' },
      { text: '📦 Add Product',        callback_data: 'adm_add_product' },
    ],
    [
      { text: '📋 Manage Products',    callback_data: 'adm_products' },
      { text: '💰 Deposit Settings',   callback_data: 'adm_deposit_settings' },
    ],
    [
      { text: '📥 Pending Deposits',   callback_data: 'adm_pending_deposits' },
      { text: '🛒 Pending Orders',     callback_data: 'adm_pending_orders' },
    ],
    [
      { text: '🔀 Feature Toggles',    callback_data: 'adm_toggles' },
      { text: '🔥 Flash Sale',         callback_data: 'adm_flash_sale' },
    ],
    [
      { text: '📢 Broadcast',          callback_data: 'adm_broadcast' },
      { text: '📞 Change Support',     callback_data: 'adm_support' },
    ],
    [
      { text: '⚙️ Rate & Min Deposit', callback_data: 'adm_settings' },
      { text: '👥 Manage Admins',      callback_data: 'adm_admins' },
    ],
  ];

  if (msgId) return edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
  return send(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JOIN URL MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showJoinUrlMenu(chatId, msgId) {
  const links = db.getDb().settings.joinLinks;
  const text = `🔗 <b>Join URL Management</b>\n\n` +
    links.map((l, i) => `${i + 1}. ${l.enabled ? '🟢' : '🔴'} ${l.name}\n   ${l.url}`).join('\n\n');

  const keyboard = [
    ...links.map((l, i) => [{
      text: `✏️ Edit #${i + 1}: ${l.name}`,
      callback_data: `adm_join_edit_${i}`,
    }]),
    [
      { text: '➕ Add New Link', callback_data: 'adm_join_add' },
    ],
    [{ text: '🔙 Back', callback_data: 'adm_panel' }],
  ];

  return edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function handleJoinUrlInput(chatId, userId, text, data) {
  const db_ = db.getDb();
  if (data.index !== undefined) {
    db_.settings.joinLinks[data.index].url = text.trim();
  } else {
    db_.settings.joinLinks.push({ name: 'New Link', url: text.trim(), enabled: true });
  }
  db.saveDb();
  h.setAdminState(userId, 'awaiting_join_name', { index: data.index !== undefined ? data.index : db_.settings.joinLinks.length - 1 });
  return send(chatId, `✅ URL saved! Now send the display name for this link:`);
}

async function handleJoinNameInput(chatId, userId, text, data) {
  const db_ = db.getDb();
  db_.settings.joinLinks[data.index].name = text.trim();
  db.saveDb();
  h.clearAdminState(userId);
  return send(chatId, `✅ Join link updated successfully!`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Panel', callback_data: 'adm_panel' }]] }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRODUCT MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showProducts(chatId, msgId, sessionMode = false) {
  const products = db.listProducts(sessionMode);
  const title = sessionMode ? '📂 Session Products' : '📦 Account Products';

  if (!products.length) {
    return edit(chatId, msgId, `${title}\n\nNo products yet.`, {
      reply_markup: { inline_keyboard: [
        [{ text: '📦 Accounts', callback_data: 'adm_products_acc' }, { text: '📂 Sessions', callback_data: 'adm_products_ses' }],
        [{ text: '🔙 Back', callback_data: 'adm_panel' }],
      ]}
    });
  }

  const keyboard = [
    [{ text: '📦 Accounts', callback_data: 'adm_products_acc' }, { text: '📂 Sessions', callback_data: 'adm_products_ses' }],
    ...products.map(p => [{
      text: `${p.emoji || '📦'} ${p.name} | ₹${p.price} | Stock: ${p.stock}`,
      callback_data: `adm_product_${p.id}`,
    }]),
    [{ text: '🔙 Back', callback_data: 'adm_panel' }],
  ];

  const rate = db.getDb().settings.usdtToInrRate;
  const text = `${title}\n\n` +
    products.map(p => h.formatProduct(p, rate)).join('\n');

  return edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showProductAdmin(chatId, msgId, productId) {
  const p = db.getProduct(productId);
  if (!p) return edit(chatId, msgId, `❌ Product not found.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'adm_products' }]] } });

  const rate = db.getDb().settings.usdtToInrRate;
  const usd  = (p.price / rate).toFixed(2);
  const text =
    `${p.emoji || '📦'} <b>${p.name}</b>\n\n` +
    `💵 Price: $${usd} • ₹${p.price}\n` +
    `📦 Stock: ${p.stock}\n` +
    `📝 Desc: ${p.description || 'None'}\n` +
    `🏷️ Mode: ${p.sessionMode ? 'Session' : 'Account'}`;

  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [
      [
        { text: '✏️ Edit Product',   callback_data: `adm_prod_edit_${productId}` },
        { text: '🗑️ Delete Product', callback_data: `adm_prod_del_${productId}` },
      ],
      [{ text: '🔙 Back', callback_data: 'adm_products' }],
    ]}
  });
}

// Add product — step by step
const _productDraft = {};

async function startAddProduct(chatId, userId, sessionMode = false) {
  _productDraft[userId] = { sessionMode };
  h.setAdminState(userId, 'awaiting_product_name', { sessionMode });
  return send(chatId, `📦 <b>Add Product</b>\n\nStep 1/5 — Enter product name:`);
}

async function handleProductInput(chatId, userId, text, field, data) {
  const draft = _productDraft[userId] || {};

  if (field === 'name') {
    draft.name = text.trim();
    _productDraft[userId] = draft;
    h.setAdminState(userId, 'awaiting_product_price', data);
    return send(chatId, `Step 2/5 — Enter price in ₹ (numbers only):`);
  }
  if (field === 'price') {
    const price = parseFloat(text);
    if (isNaN(price) || price <= 0) return send(chatId, `❌ Invalid price. Enter a positive number:`);
    draft.price = price;
    _productDraft[userId] = draft;
    h.setAdminState(userId, 'awaiting_product_stock', data);
    return send(chatId, `Step 3/5 — Enter stock quantity:`);
  }
  if (field === 'stock') {
    const stock = parseInt(text);
    if (isNaN(stock) || stock < 0) return send(chatId, `❌ Invalid stock. Enter a number:`);
    draft.stock = stock;
    _productDraft[userId] = draft;
    h.setAdminState(userId, 'awaiting_product_emoji', data);
    return send(chatId, `Step 4/5 — Enter an emoji for this product (e.g. 🇮🇳):`);
  }
  if (field === 'emoji') {
    draft.emoji = text.trim();
    _productDraft[userId] = draft;
    h.setAdminState(userId, 'awaiting_product_desc', data);
    return send(chatId, `Step 5/5 — Enter a short description (or send /skip):`);
  }
  if (field === 'desc') {
    draft.description = text.startsWith('/skip') ? null : text.trim();
    const product = db.addProduct({ ...draft });
    delete _productDraft[userId];
    h.clearAdminState(userId);

    const rate = db.getDb().settings.usdtToInrRate;
    const usd  = (product.price / rate).toFixed(2);
    return send(chatId,
      `✅ <b>Product Added!</b>\n\n${product.emoji} ${product.name}\n💵 $${usd} • ₹${product.price}\n📦 Stock: ${product.stock}`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Panel', callback_data: 'adm_panel' }]] } }
    );
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEPOSIT SETTINGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showDepositSettings(chatId, msgId) {
  const pay = db.getDb().settings.payments;
  const text = `💳 <b>Deposit Settings</b>\n\nSelect payment method to configure:`;
  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [
      [
        { text: `📱 G Pay ${pay.gpay.enabled ? '🟢' : '🔴'}`,     callback_data: 'adm_pay_gpay' },
        { text: `💳 Fam Pay ${pay.fampay.enabled ? '🟢' : '🔴'}`, callback_data: 'adm_pay_fampay' },
      ],
      [
        { text: `🗃️ Any UPI ${pay.anyupi.enabled ? '🟢' : '🔴'}`,     callback_data: 'adm_pay_anyupi' },
        { text: `🏦 Binance ${pay.binance.enabled ? '🟢' : '🔴'}`,    callback_data: 'adm_pay_binance' },
      ],
      [{ text: '🔙 Back', callback_data: 'adm_panel' }],
    ]}
  });
}

async function showPayMethodSettings(chatId, msgId, method) {
  const pay = db.getDb().settings.payments[method];
  const methodNames = { gpay: 'G Pay', fampay: 'Fam Pay', anyupi: 'Any UPI', binance: 'Binance Pay' };
  const isBinance = method === 'binance';

  const text =
    `💳 <b>${methodNames[method]} Settings</b>\n\n` +
    `Status: ${pay.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n` +
    (isBinance
      ? `🆔 ID: ${pay.binanceId || 'Not set'}\n👤 Name: ${pay.binanceName || 'Not set'}`
      : `🆔 UPI ID: ${pay.upiId || 'Not set'}\n👤 Name: ${pay.upiName || 'Not set'}\n🖼️ QR: ${pay.qrFileId ? '✅ Set' : '❌ Not set'}`
    );

  const keyboard = [];
  if (!isBinance) {
    keyboard.push([
      { text: '🖼️ Change QR',     callback_data: `adm_pay_qr_${method}` },
      { text: '🆔 Change ID/Name', callback_data: `adm_pay_id_${method}` },
    ]);
    keyboard.push([{ text: '🗑️ Delete QR/ID', callback_data: `adm_pay_del_${method}` }]);
  } else {
    keyboard.push([{ text: '🆔 Change Binance ID/Name', callback_data: `adm_pay_bid_${method}` }]);
    keyboard.push([{ text: '🗑️ Delete Binance ID', callback_data: `adm_pay_del_${method}` }]);
  }
  keyboard.push([{ text: `${pay.enabled ? '🔴 Disable' : '🟢 Enable'} Method`, callback_data: `adm_pay_toggle_${method}` }]);
  keyboard.push([{ text: '🔙 Back', callback_data: 'adm_deposit_settings' }]);

  return edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ── QR Upload (Admin Bot → User Bot relay) ─────────────
async function handleQrUpload(chatId, userId, method, adminFileId) {
  await send(chatId, `⏳ Uploading QR code, please wait...`);

  // Relay Admin Bot file_id → User Bot file_id
  const userFileId = await h.mintUserBotFileId(adminFileId);
  const db_ = db.getDb();

  if (userFileId) {
    db_.settings.payments[method].qrFileId      = userFileId;
    db_.settings.payments[method].qrFileIdAdmin = adminFileId;
    db.saveDb();
    return send(chatId,
      `✅ QR uploaded successfully!\nBoth bots now have valid copies.`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `adm_pay_${method}` }]] } }
    );
  } else {
    // Save admin copy at least
    db_.settings.payments[method].qrFileIdAdmin = adminFileId;
    db.saveDb();
    return send(chatId,
      `⚠️ QR saved for Admin Bot, but User Bot relay failed.\nPlease check:\n• BOT_TOKEN is correct in .env\n• Owner has /start'd the User Bot at least once`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `adm_pay_${method}` }]] } }
    );
  }
}

async function handleUpiIdInput(chatId, userId, text, data) {
  const db_ = db.getDb();
  db_.settings.payments[data.method].upiId = text.trim();
  db.saveDb();
  h.setAdminState(userId, 'awaiting_upi_name', data);
  return send(chatId, `✅ UPI ID saved! Now enter the display name (e.g. "John Doe"):`);
}

async function handleUpiNameInput(chatId, userId, text, data) {
  const db_ = db.getDb();
  db_.settings.payments[data.method].upiName = text.trim();
  db.saveDb();
  h.clearAdminState(userId);
  return send(chatId, `✅ UPI ID & Name updated!`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `adm_pay_${data.method}` }]] }
  });
}

async function handleBinanceIdInput(chatId, userId, text, data) {
  const db_ = db.getDb();
  db_.settings.payments.binance.binanceId = text.trim();
  db.saveDb();
  h.setAdminState(userId, 'awaiting_binance_name', data);
  return send(chatId, `✅ Binance ID saved! Now enter display name:`);
}

async function handleBinanceNameInput(chatId, userId, text, data) {
  const db_ = db.getDb();
  db_.settings.payments.binance.binanceName = text.trim();
  db.saveDb();
  h.clearAdminState(userId);
  return send(chatId, `✅ Binance ID & Name updated!`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'adm_pay_binance' }]] }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PENDING DEPOSITS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showPendingDeposits(chatId, msgId) {
  const pending = db.getPendingDeposits();

  if (!pending.length) {
    return edit(chatId, msgId, `📥 <b>No Pending Deposits</b>`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'adm_panel' }]] }
    });
  }

  const text = `📥 <b>Pending Deposits</b> (${pending.length})\n\nTap to review:`;
  const keyboard = [
    ...pending.map(d => {
      const user = db.getUser(d.userId);
      return [{ text: `#${d.id} — ${user.username ? '@' + user.username : d.userId} — ₹${d.amount}`, callback_data: `adm_dep_${d.id}` }];
    }),
    [{ text: '🔙 Back', callback_data: 'adm_panel' }],
  ];

  return edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showDepositDetail(chatId, msgId, depositId) {
  const deposit = db.getDeposit(depositId);
  if (!deposit) return edit(chatId, msgId, `❌ Deposit not found.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'adm_pending_deposits' }]] } });

  const user = db.getUser(deposit.userId);
  const rate = db.getDb().settings.usdtToInrRate;
  const usd  = (deposit.amount / rate).toFixed(2);

  const text =
    `💰 <b>Deposit #${depositId}</b>\n\n` +
    `👤 User: ${user.username ? '@' + user.username : user.firstName || 'Unknown'} (<code>${deposit.userId}</code>)\n` +
    `💵 Amount: ₹${deposit.amount} ($${usd})\n` +
    `💳 Method: ${deposit.method?.toUpperCase()}\n` +
    `💼 Balance: ${h.formatBalance(user.balance)}\n` +
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n` +
    `🔁 Deposit Count: ${user.depositCount}\n` +
    `📅 Time: ${new Date(deposit.createdAt).toLocaleString()}`;

  const keyboard = [
    [
      { text: '✅ Approve', callback_data: `adm_dep_approve_${depositId}` },
      { text: '❌ Reject',  callback_data: `adm_dep_reject_${depositId}` },
    ],
    [{ text: '✉️ Message User', url: `tg://user?id=${deposit.userId}` }],
    [{ text: '🔙 Back', callback_data: 'adm_pending_deposits' }],
  ];

  // Show screenshot if available
  const fileId = deposit.screenshotFileIdAdmin || deposit.screenshotFileId;
  if (fileId) {
    try { await bot.deleteMessage(chatId, msgId); } catch (_) {}
    await bot.sendPhoto(chatId, fileId, { caption: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  } else {
    await edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

async function approveDeposit(chatId, msgId, depositId) {
  const deposit = db.getDeposit(depositId);
  if (!deposit || deposit.status !== 'pending') {
    return send(chatId, `❌ Deposit #${depositId} not found or already processed.`);
  }

  db.updateDeposit(depositId, { status: 'approved', approvedAt: Date.now() });
  const user = db.getUser(deposit.userId);
  db.updateUser(deposit.userId, {
    balance:        user.balance + deposit.amount,
    totalDeposited: user.totalDeposited + deposit.amount,
    depositCount:   user.depositCount + 1,
  });

  await send(chatId, `✅ <b>Deposit #${depositId} Approved!</b>\n₹${deposit.amount} added to user's balance.`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Pending Deposits', callback_data: 'adm_pending_deposits' }]] }
  });

  // Notify user
  try {
    const updatedUser = db.getUser(deposit.userId);
    await userBotModule.notifyDepositApproved(deposit.userId, deposit);
  } catch (err) {
    console.error('[APPROVE] User notify failed:', err.message);
  }
}

async function rejectDeposit(chatId, msgId, depositId) {
  const deposit = db.getDeposit(depositId);
  if (!deposit || deposit.status !== 'pending') {
    return send(chatId, `❌ Deposit #${depositId} not found or already processed.`);
  }

  db.updateDeposit(depositId, { status: 'rejected', rejectedAt: Date.now() });
  await send(chatId, `❌ <b>Deposit #${depositId} Rejected.</b>`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Pending Deposits', callback_data: 'adm_pending_deposits' }]] }
  });

  try {
    await userBotModule.notifyDepositRejected(deposit.userId, deposit);
  } catch (err) {
    console.error('[REJECT] User notify failed:', err.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PENDING ORDERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showPendingOrders(chatId, msgId) {
  const orders = db.getPendingOrders();
  if (!orders.length) {
    return edit(chatId, msgId, `🛒 <b>No Pending Orders</b>`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'adm_panel' }]] }
    });
  }

  const text = `🛒 <b>Pending Orders</b> (${orders.length})\n\nTap to deliver:`;
  const keyboard = [
    ...orders.map(o => {
      const user = db.getUser(o.userId);
      const p    = db.getProduct(o.productId);
      return [{
        text: `#${o.id} — ${user.username ? '@' + user.username : o.userId} — ${p?.name || 'Unknown'}`,
        callback_data: `adm_order_${o.id}`,
      }];
    }),
    [{ text: '🔙 Back', callback_data: 'adm_panel' }],
  ];

  return edit(chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showOrderDetail(chatId, msgId, orderId) {
  const order = db.getOrder(orderId);
  if (!order) return send(chatId, `❌ Order not found.`);

  const user = db.getUser(order.userId);
  const p    = db.getProduct(order.productId);
  const rate = db.getDb().settings.usdtToInrRate;
  const usd  = (order.totalPrice / rate).toFixed(2);

  const text =
    `🛒 <b>Order #${orderId}</b>\n\n` +
    `👤 User: ${user.username ? '@' + user.username : user.firstName || 'Unknown'} (<code>${order.userId}</code>)\n` +
    `📦 Product: ${p?.emoji || ''} ${p?.name || 'Unknown'}\n` +
    `💵 Price: ₹${order.totalPrice} ($${usd})\n` +
    `💼 User Balance: ${h.formatBalance(user.balance)}\n` +
    `📅 Placed: ${new Date(order.createdAt).toLocaleString()}`;

  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [
      [
        { text: '✅ Mark Delivered',  callback_data: `adm_deliver_${orderId}` },
        { text: '✉️ Message User',    url: `tg://user?id=${order.userId}` },
      ],
      [{ text: '🔙 Back', callback_data: 'adm_pending_orders' }],
    ]}
  });
}

async function markOrderDelivered(chatId, msgId, orderId) {
  const order = db.getOrder(orderId);
  if (!order) return send(chatId, `❌ Order not found.`);
  db.updateOrder(orderId, { status: 'delivered', deliveredAt: Date.now() });
  await send(chatId, `✅ Order #${orderId} marked as delivered!`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Pending Orders', callback_data: 'adm_pending_orders' }]] }
  });
  try {
    await userBotModule.notifyOrderDelivered(order.userId, order);
  } catch (err) {
    console.error('[DELIVER] User notify failed:', err.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FEATURE TOGGLES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showToggles(chatId, msgId) {
  const f = db.getDb().settings.features;
  const btn = (label, key) => ({
    text: `${f[key] ? '🟢' : '🔴'} ${label}`,
    callback_data: `adm_toggle_${key}`,
  });

  return edit(chatId, msgId, `🔀 <b>Feature Toggles</b>\n\nToggle any feature ON/OFF:`, {
    reply_markup: { inline_keyboard: [
      [btn('Buy Account', 'buyAccount'),  btn('Buy Sessions', 'buySession')],
      [btn('Deposit',     'deposit'),     btn('Refer & Earn', 'referEarn')],
      [btn('Support',     'support'),     btn('Leaderboard',  'leaderboard')],
      [{ text: '🔙 Back', callback_data: 'adm_panel' }],
    ]}
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FLASH SALE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showFlashSaleMenu(chatId, msgId) {
  const fs = db.getDb().settings.flashSale;
  const text = fs.active
    ? `🔥 <b>Flash Sale ACTIVE</b>\n\nProduct ID: ${fs.productId}\nDiscount: ${fs.discountPercent}%\nEnds: ${new Date(fs.endsAt).toLocaleString()}`
    : `🔥 <b>Flash Sale</b>\n\nNo active flash sale.`;

  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [
      [{ text: fs.active ? '🛑 Stop Flash Sale' : '🔥 Start Flash Sale', callback_data: fs.active ? 'adm_flash_stop' : 'adm_flash_start' }],
      [{ text: '🔙 Back', callback_data: 'adm_panel' }],
    ]}
  });
}

async function handleFlashProductInput(chatId, userId, text, data) {
  const p = db.getProduct(text.trim());
  if (!p) return send(chatId, `❌ Product ID not found. Try again:`);
  _productDraft[userId] = { productId: text.trim() };
  h.setAdminState(userId, 'awaiting_flash_discount', data);
  return send(chatId, `Enter discount percentage (e.g. 20 for 20% off):`);
}

async function handleFlashDiscountInput(chatId, userId, text, data) {
  const pct = parseInt(text);
  if (isNaN(pct) || pct < 1 || pct > 99) return send(chatId, `❌ Enter a valid percentage (1-99):`);
  const draft = _productDraft[userId] || {};
  draft.discountPercent = pct;
  _productDraft[userId] = draft;
  h.setAdminState(userId, 'awaiting_flash_hours', data);
  return send(chatId, `For how many hours should the flash sale run?`);
}

async function handleFlashHoursInput(chatId, userId, text, data) {
  const hours = parseFloat(text);
  if (isNaN(hours) || hours <= 0) return send(chatId, `❌ Enter valid hours:`);
  const draft = _productDraft[userId] || {};
  const db_   = db.getDb();
  db_.settings.flashSale = {
    active: true,
    productId: draft.productId,
    discountPercent: draft.discountPercent,
    endsAt: Date.now() + hours * 3600000,
  };
  // Also update product's flashSale flag
  db.updateProduct(draft.productId, { flashSale: true });
  db.saveDb();
  delete _productDraft[userId];
  h.clearAdminState(userId);
  return send(chatId, `🔥 <b>Flash Sale Started!</b>\n\n${draft.discountPercent}% off for ${hours} hours.`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Panel', callback_data: 'adm_panel' }]] }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BROADCAST
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleBroadcastInput(chatId, userId, text) {
  h.clearAdminState(userId);
  const users = Object.values(db.getDb().users);
  let sent = 0, failed = 0;

  await send(chatId, `📢 Sending broadcast to ${users.length} users...`);

  for (const u of users) {
    try {
      await userBotModule.bot.sendMessage(u.userId, `📢 <b>Announcement</b>\n\n${text}`, { parse_mode: 'HTML' });
      sent++;
    } catch (_) { failed++; }
    await new Promise(r => setTimeout(r, 50)); // rate limit friendly
  }

  return send(chatId, `✅ Broadcast complete!\n✅ Sent: ${sent}\n❌ Failed: ${failed}`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Panel', callback_data: 'adm_panel' }]] }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SETTINGS (rate, min deposit, support)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showSettings(chatId, msgId) {
  const db_  = db.getDb();
  const text =
    `⚙️ <b>Settings</b>\n\n` +
    `💱 USDT Rate: 1 USDT = ₹${db_.settings.usdtToInrRate}\n` +
    `💵 Min Deposit: ₹${db_.settings.minDepositInr}`;

  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [
      [
        { text: '💱 Change Rate',        callback_data: 'adm_set_rate' },
        { text: '💵 Change Min Deposit', callback_data: 'adm_set_min' },
      ],
      [{ text: '🔙 Back', callback_data: 'adm_panel' }],
    ]}
  });
}

async function handleSupportUsernameInput(chatId, userId, text) {
  const db_  = db.getDb();
  const user = text.trim().replace('@', '');
  db_.settings.supportUsername = user;
  db.saveDb();
  h.clearAdminState(userId);
  return send(chatId, `✅ Support username updated to @${user}`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Panel', callback_data: 'adm_panel' }]] }
  });
}

async function handleRateInput(chatId, userId, text) {
  const rate = parseFloat(text);
  if (isNaN(rate) || rate <= 0) return send(chatId, `❌ Invalid rate:`);
  const db_  = db.getDb();
  db_.settings.usdtToInrRate = rate;
  db.saveDb();
  h.clearAdminState(userId);
  return send(chatId, `✅ Rate updated: 1 USDT = ₹${rate}`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_settings' }]] }
  });
}

async function handleMinDepositInput(chatId, userId, text) {
  const min = parseFloat(text);
  if (isNaN(min) || min <= 0) return send(chatId, `❌ Invalid amount:`);
  const db_ = db.getDb();
  db_.settings.minDepositInr = min;
  db.saveDb();
  h.clearAdminState(userId);
  return send(chatId, `✅ Minimum deposit updated: ₹${min}`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_settings' }]] }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMIN MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showAdmins(chatId, msgId) {
  const admins = db.listAdmins();
  const text = `👥 <b>Hired Admins</b>\n\n` +
    (admins.length ? admins.map(a => `• <code>${a.userId}</code>`).join('\n') : 'No hired admins.');

  return edit(chatId, msgId, text, {
    reply_markup: { inline_keyboard: [
      [{ text: '➕ Hire Admin', callback_data: 'adm_hire_admin' }],
      ...admins.map(a => [{ text: `🗑️ Remove ${a.userId}`, callback_data: `adm_fire_${a.userId}` }]),
      [{ text: '🔙 Back', callback_data: 'adm_panel' }],
    ]}
  });
}

async function handleHireAdminInput(chatId, userId, text) {
  const targetId = text.trim();
  if (targetId === OWNER_ID) return send(chatId, `❌ Owner is already authorized.`);
  db.addAdmin(targetId, userId);
  h.clearAdminState(userId);
  return send(chatId, `✅ Admin <code>${targetId}</code> hired!`, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 Admins', callback_data: 'adm_admins' }]] }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHOTO HANDLER — QR code uploads
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (!isAuthorized(userId) && !_authenticated.has(userId)) return;

  const state = h.getAdminState(userId);
  if (!state || state.state !== 'awaiting_qr_upload') return;

  const fileId = msg.photo[msg.photo.length - 1].file_id;
  h.clearAdminState(userId);
  await handleQrUpload(chatId, userId, state.data.method, fileId);
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

  if (!isAuthorized(userId) && !_authenticated.has(userId)) return;

  if (data === 'adm_panel') return showAdminPanel(chatId, msgId, userId);

  // Join URL
  if (data === 'adm_join_url')    return showJoinUrlMenu(chatId, msgId);
  if (data === 'adm_join_add') {
    h.setAdminState(userId, 'awaiting_join_url', {});
    return edit(chatId, msgId, `Enter the new join URL:`);
  }
  if (data.startsWith('adm_join_edit_')) {
    const idx = parseInt(data.replace('adm_join_edit_', ''));
    h.setAdminState(userId, 'awaiting_join_url', { index: idx });
    return edit(chatId, msgId, `Enter new URL for link #${idx + 1}:`);
  }
  if (data.startsWith('adm_join_toggle_')) {
    const idx = parseInt(data.replace('adm_join_toggle_', ''));
    const db_ = db.getDb();
    db_.settings.joinLinks[idx].enabled = !db_.settings.joinLinks[idx].enabled;
    db.saveDb();
    return showJoinUrlMenu(chatId, msgId);
  }

  // Products
  if (data === 'adm_products')      return showProducts(chatId, msgId, false);
  if (data === 'adm_products_acc')  return showProducts(chatId, msgId, false);
  if (data === 'adm_products_ses')  return showProducts(chatId, msgId, true);
  if (data === 'adm_add_product')   return startAddProduct(chatId, userId, false);
  if (data === 'adm_add_session')   return startAddProduct(chatId, userId, true);
  if (data.startsWith('adm_product_')) return showProductAdmin(chatId, msgId, data.replace('adm_product_', ''));
  if (data.startsWith('adm_prod_del_')) {
    const pid = data.replace('adm_prod_del_', '');
    db.deleteProduct(pid);
    return edit(chatId, msgId, `🗑️ Product deleted.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'adm_products' }]] } });
  }

  // Deposit settings
  if (data === 'adm_deposit_settings')  return showDepositSettings(chatId, msgId);
  if (data === 'adm_pay_gpay')          return showPayMethodSettings(chatId, msgId, 'gpay');
  if (data === 'adm_pay_fampay')        return showPayMethodSettings(chatId, msgId, 'fampay');
  if (data === 'adm_pay_anyupi')        return showPayMethodSettings(chatId, msgId, 'anyupi');
  if (data === 'adm_pay_binance')       return showPayMethodSettings(chatId, msgId, 'binance');

  if (data.startsWith('adm_pay_qr_')) {
    const method = data.replace('adm_pay_qr_', '');
    h.setAdminState(userId, 'awaiting_qr_upload', { method });
    return edit(chatId, msgId, `🖼️ Upload your new QR code image now:`);
  }
  if (data.startsWith('adm_pay_id_')) {
    const method = data.replace('adm_pay_id_', '');
    h.setAdminState(userId, 'awaiting_upi_id', { method });
    return edit(chatId, msgId, `Enter new UPI ID:`);
  }
  if (data.startsWith('adm_pay_bid_')) {
    const method = data.replace('adm_pay_bid_', '');
    h.setAdminState(userId, 'awaiting_binance_id', { method });
    return edit(chatId, msgId, `Enter new Binance ID:`);
  }
  if (data.startsWith('adm_pay_del_')) {
    const method = data.replace('adm_pay_del_', '');
    const db_    = db.getDb();
    Object.assign(db_.settings.payments[method], {
      qrFileId: null, qrFileIdAdmin: null, upiId: null, upiName: null,
      binanceId: null, binanceName: null,
    });
    db.saveDb();
    return send(chatId, `🗑️ ${method} QR/ID cleared.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `adm_pay_${method}` }]] } });
  }
  if (data.startsWith('adm_pay_toggle_')) {
    const method = data.replace('adm_pay_toggle_', '');
    const db_    = db.getDb();
    db_.settings.payments[method].enabled = !db_.settings.payments[method].enabled;
    db.saveDb();
    return showPayMethodSettings(chatId, msgId, method);
  }

  // Deposits
  if (data === 'adm_pending_deposits') return showPendingDeposits(chatId, msgId);
  if (data.startsWith('adm_dep_approve_')) return approveDeposit(chatId, msgId, data.replace('adm_dep_approve_', ''));
  if (data.startsWith('adm_dep_reject_'))  return rejectDeposit(chatId, msgId, data.replace('adm_dep_reject_', ''));
  if (data.startsWith('adm_dep_'))         return showDepositDetail(chatId, msgId, data.replace('adm_dep_', ''));
  if (data.startsWith('dep_approve_'))     return approveDeposit(chatId, msgId, data.replace('dep_approve_', ''));
  if (data.startsWith('dep_reject_'))      return rejectDeposit(chatId, msgId, data.replace('dep_reject_', ''));

  // Orders
  if (data === 'adm_pending_orders')       return showPendingOrders(chatId, msgId);
  if (data.startsWith('adm_order_'))       return showOrderDetail(chatId, msgId, data.replace('adm_order_', ''));
  if (data.startsWith('adm_deliver_'))     return markOrderDelivered(chatId, msgId, data.replace('adm_deliver_', ''));
  if (data.startsWith('deliver_'))         return markOrderDelivered(chatId, msgId, data.replace('deliver_', ''));

  // Feature toggles
  if (data === 'adm_toggles') return showToggles(chatId, msgId);
  if (data.startsWith('adm_toggle_')) {
    const key = data.replace('adm_toggle_', '');
    const db_ = db.getDb();
    db_.settings.features[key] = !db_.settings.features[key];
    db.saveDb();
    return showToggles(chatId, msgId);
  }

  // Flash sale
  if (data === 'adm_flash_sale')  return showFlashSaleMenu(chatId, msgId);
  if (data === 'adm_flash_start') {
    h.setAdminState(userId, 'awaiting_flash_product', {});
    return edit(chatId, msgId, `Enter the Product ID for flash sale:`);
  }
  if (data === 'adm_flash_stop') {
    const db_ = db.getDb();
    if (db_.settings.flashSale.productId) {
      db.updateProduct(db_.settings.flashSale.productId, { flashSale: false });
    }
    db_.settings.flashSale = { active: false, productId: null, discountPercent: 0, endsAt: null };
    db.saveDb();
    return edit(chatId, msgId, `🛑 Flash Sale stopped.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'adm_panel' }]] } });
  }

  // Broadcast
  if (data === 'adm_broadcast') {
    h.setAdminState(userId, 'awaiting_broadcast', {});
    return edit(chatId, msgId, `📢 Type your broadcast message:`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'adm_panel' }]] }
    });
  }

  // Support
  if (data === 'adm_support') {
    h.setAdminState(userId, 'awaiting_support_username', {});
    return edit(chatId, msgId, `Enter new support username (without @):`);
  }

  // Settings
  if (data === 'adm_settings') return showSettings(chatId, msgId);
  if (data === 'adm_set_rate') {
    h.setAdminState(userId, 'awaiting_rate', {});
    return edit(chatId, msgId, `Enter new USDT to INR rate (e.g. 90):`);
  }
  if (data === 'adm_set_min') {
    h.setAdminState(userId, 'awaiting_min_deposit', {});
    return edit(chatId, msgId, `Enter new minimum deposit in ₹:`);
  }

  // Admins
  if (data === 'adm_admins') return showAdmins(chatId, msgId);
  if (data === 'adm_hire_admin') {
    h.setAdminState(userId, 'awaiting_hire_admin_id', {});
    return edit(chatId, msgId, `Send the Telegram user ID to hire as admin:`);
  }
  if (data.startsWith('adm_fire_')) {
    const targetId = data.replace('adm_fire_', '');
    db.removeAdmin(targetId);
    return showAdmins(chatId, msgId);
  }
});

console.log('⚙️ CLOUDE CART Admin Bot started...');
