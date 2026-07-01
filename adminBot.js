const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./db');
const { relayPhoto } = require('./utils/relay');

// Per-admin-chat session for multi-step flows
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

// Track which admin chats have unlocked the panel this runtime
const unlockedChats = new Set();

function createAdminBot(userBotRef) {
  const bot = new TelegramBot(config.adminBotToken, { polling: true });
  bot.on('polling_error', (err) => console.error('[adminBot polling_error]', err.message));

  function requireAdmin(userId) {
    return db.isAdmin(userId);
  }

  function mainPanelKeyboard() {
    return {
      inline_keyboard: [
        [{ text: '🔗 Change Join URL', callback_data: 'admin:joinurl' }],
        [{ text: '➕ Add New Product', callback_data: 'admin:addproduct' }],
        [{ text: '📦 Manage Products', callback_data: 'admin:products' }],
        [{ text: '💳 Change Deposit Setting', callback_data: 'admin:depositsettings' }],
        [{ text: '📞 Change Support', callback_data: 'admin:support' }],
        [{ text: '👑 Hire Admin', callback_data: 'admin:hireadmin' }],
        [{ text: '🏆 Leaderboard', callback_data: 'admin:leaderboard' }],
        [{ text: '🎚️ Toggle System', callback_data: 'admin:toggles' }],
      ],
    };
  }

  function backKeyboard(target = 'admin:home') {
    return { inline_keyboard: [[{ text: '⬅️ Back', callback_data: target }]] };
  }

  // ---------- /start with password gate ----------
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!requireAdmin(userId)) {
      return bot.sendMessage(chatId, '⛔ You are not authorized to use this bot.');
    }

    if (unlockedChats.has(chatId)) {
      return bot.sendMessage(chatId, '🔐 *Admin Panel*', {
        parse_mode: 'Markdown',
        reply_markup: mainPanelKeyboard(),
      });
    }

    setSession(chatId, 'awaiting_password');
    await bot.sendMessage(chatId, 'Welcome to Admin Panel. Please enter the password:');
  });

  // ---------- callback query router ----------
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (!requireAdmin(userId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Not authorized.', show_alert: true });
    }
    if (!unlockedChats.has(chatId) && data !== 'admin:home') {
      return bot.answerCallbackQuery(query.id, { text: 'Please /start and enter the password first.', show_alert: true });
    }

    try {
      if (data === 'admin:home') return showHome(chatId);
      if (data === 'admin:joinurl') return startJoinUrlFlow(chatId);
      if (data === 'admin:addproduct') return startAddProductFlow(chatId);
      if (data === 'admin:products') return showProductList(chatId);
      if (data.startsWith('admin:product:')) return showProductDetail(chatId, data);
      if (data.startsWith('admin:editproduct:')) return startEditProductFlow(chatId, data);
      if (data.startsWith('admin:deleteproduct:')) return handleDeleteProduct(chatId, data);
      if (data === 'admin:depositsettings') return showDepositSettingsMenu(chatId);
      if (data.startsWith('admin:depmethod:')) return showDepositMethodOptions(chatId, data);
      if (data.startsWith('admin:depapp:')) return showDepositAppActions(chatId, data);
      if (data.startsWith('admin:changeqr:')) return startChangeQrFlow(chatId, data);
      if (data.startsWith('admin:changeid:')) return startChangeIdFlow(chatId, data);
      if (data.startsWith('admin:deleteqr:')) return handleDeleteQr(chatId, data);
      if (data === 'admin:support') return startChangeSupportFlow(chatId);
      if (data === 'admin:hireadmin') return startHireAdminFlow(chatId);
      if (data === 'admin:leaderboard') return showLeaderboard(chatId);
      if (data === 'admin:toggles') return showToggles(chatId);
      if (data.startsWith('admin:toggle:')) return handleToggleFlip(chatId, data);
      if (data.startsWith('deposit:approve:')) return handleDepositDecision(chatId, data, 'approved', query.from);
      if (data.startsWith('deposit:reject:')) return handleDepositDecision(chatId, data, 'rejected', query.from);
      if (data.startsWith('order:approve:')) return handleOrderDecision(chatId, data, 'approved', query.from);
      if (data.startsWith('order:reject:')) return handleOrderDecision(chatId, data, 'rejected', query.from);
      if (data.startsWith('dm:')) return startDirectMessageFlow(chatId, data);

      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.error('[adminBot callback_query] error:', err.message);
      try {
        await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' });
      } catch (_) {}
    }
  });

  async function showHome(chatId) {
    await bot.sendMessage(chatId, '🔐 *Admin Panel*', {
      parse_mode: 'Markdown',
      reply_markup: mainPanelKeyboard(),
    });
  }

  // ---------- Join URL ----------
  async function startJoinUrlFlow(chatId) {
    setSession(chatId, 'awaiting_join_url');
    await bot.sendMessage(chatId, 'Give me the URL link:');
  }

  // ---------- Product management ----------
  async function startAddProductFlow(chatId) {
    setSession(chatId, 'add_product_name', {});
    await bot.sendMessage(chatId, 'Product name?');
  }

  async function showProductList(chatId) {
    const products = db.listAllProducts();
    if (products.length === 0) {
      return bot.sendMessage(chatId, 'No products yet.', { reply_markup: backKeyboard() });
    }
    const buttons = products.map((p) => [
      {
        text: `${p.emoji} ${p.name} ${p.is_active ? '' : '(hidden)'}`,
        callback_data: `admin:product:${p.id}`,
      },
    ]);
    buttons.push([{ text: '⬅️ Back', callback_data: 'admin:home' }]);
    await bot.sendMessage(chatId, '📦 *Products*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
  }

  async function showProductDetail(chatId, data) {
    const id = parseInt(data.split(':')[2], 10);
    const p = db.getProduct(id);
    if (!p) return bot.sendMessage(chatId, 'Product not found.', { reply_markup: backKeyboard('admin:products') });
    const usdt = (p.price_inr / config.usdtToInrRate).toFixed(2);
    const text =
      `${p.emoji} *${p.name}*\n💵 ₹${p.price_inr} (~$${usdt})\n📦 Stock: ${p.stock}\n📝 ${p.description || '-'}\n` +
      `Status: ${p.is_active ? 'Active' : 'Hidden'}`;
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ Change Product', callback_data: `admin:editproduct:${p.id}` }],
          [{ text: '🗑️ Delete Product', callback_data: `admin:deleteproduct:${p.id}` }],
          [{ text: '⬅️ Back', callback_data: 'admin:products' }],
        ],
      },
    });
  }

  async function startEditProductFlow(chatId, data) {
    const id = parseInt(data.split(':')[2], 10);
    setSession(chatId, 'edit_product_name', { productId: id });
    await bot.sendMessage(chatId, 'New product name? (send "-" to keep unchanged)');
  }

  async function handleDeleteProduct(chatId, data) {
    const id = parseInt(data.split(':')[2], 10);
    db.deleteProduct(id);
    await bot.sendMessage(chatId, '🗑️ Product deleted.', { reply_markup: backKeyboard('admin:products') });
  }

  // ---------- Deposit settings ----------
  async function showDepositSettingsMenu(chatId) {
    await bot.sendMessage(chatId, 'Change settings — select Payment method:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 UPI QR CODE / ID', callback_data: 'admin:depmethod:upi' }],
          [{ text: '💳 Binance Pay (USDT)', callback_data: 'admin:depmethod:binance' }],
          [{ text: '⬅️ Back', callback_data: 'admin:home' }],
        ],
      },
    });
  }

  async function showDepositMethodOptions(chatId, data) {
    const method = data.split(':')[2];
    if (method === 'binance') {
      await bot.sendMessage(chatId, 'Binance settings:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✏️ Change ID / Name', callback_data: 'admin:changeid:binance' }],
            [{ text: '⬅️ Back', callback_data: 'admin:depositsettings' }],
          ],
        },
      });
      return;
    }
    await bot.sendMessage(chatId, 'Choose your changing QR or ID app:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 GPay', callback_data: 'admin:depapp:gpay' }],
          [{ text: '💳 Fam Pay', callback_data: 'admin:depapp:fampay' }],
          [{ text: '🗃️ Any UPI', callback_data: 'admin:depapp:anyupi' }],
          [{ text: '⬅️ Back', callback_data: 'admin:depositsettings' }],
        ],
      },
    });
  }

  async function showDepositAppActions(chatId, data) {
    const app = data.split(':')[2];
    await bot.sendMessage(chatId, `Settings for ${app}:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🖼️ Change QR', callback_data: `admin:changeqr:${app}` }],
          [{ text: '✏️ Change ID/Name', callback_data: `admin:changeid:${app}` }],
          [{ text: '🗑️ Delete QR/ID', callback_data: `admin:deleteqr:${app}` }],
          [{ text: '⬅️ Back', callback_data: 'admin:depositsettings' }],
        ],
      },
    });
  }

  async function startChangeQrFlow(chatId, data) {
    const app = data.split(':')[2];
    setSession(chatId, 'awaiting_qr_upload', { app });
    await bot.sendMessage(chatId, 'Upload your QR pic:');
  }

  async function startChangeIdFlow(chatId, data) {
    const app = data.split(':')[2];
    if (app === 'binance') {
      setSession(chatId, 'awaiting_binance_id', {});
      await bot.sendMessage(chatId, 'Upload your new Binance ID in text:');
    } else {
      setSession(chatId, 'awaiting_upi_id', { app });
      await bot.sendMessage(chatId, 'Give your new ID in text:');
    }
  }

  async function handleDeleteQr(chatId, data) {
    const app = data.split(':')[2];
    db.setSetting(`upi_${app}_qr_file_id`, '');
    db.setSetting(`upi_${app}_qr_file_id_admin`, '');
    db.setSetting(`upi_${app}_id`, '');
    await bot.sendMessage(chatId, `🗑️ QR/ID for ${app} deleted.`, {
      reply_markup: backKeyboard('admin:depositsettings'),
    });
  }

  // ---------- Support ----------
  async function startChangeSupportFlow(chatId) {
    setSession(chatId, 'awaiting_support_username');
    await bot.sendMessage(chatId, 'New support username (without @):');
  }

  // ---------- Hire admin ----------
  async function startHireAdminFlow(chatId) {
    setSession(chatId, 'awaiting_new_admin_id');
    await bot.sendMessage(chatId, "New admin's Telegram numeric user ID:");
  }

  // ---------- Leaderboard ----------
  async function showLeaderboard(chatId) {
    const depositors = db.topDepositors(10);
    const referrers = db.topReferrers(10);
    let text = '🏆 *Leaderboard*\n\n💰 Top Depositors\n';
    depositors.forEach((d, i) => (text += `${i + 1}. ${d.username || d.user_id} — ₹${d.total_deposited_inr.toFixed(2)}\n`));
    text += '\n🎁 Top Referrers\n';
    referrers.forEach((r, i) => (text += `${i + 1}. ${r.user_id} — ${r.referral_count}\n`));
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: backKeyboard() });
  }

  // ---------- Toggle system ----------
  const TOGGLE_KEYS = [
    { key: 'buy', label: '🛒 Buy Product' },
    { key: 'deposit', label: '💰 Deposit' },
    { key: 'refer', label: '🎁 Refer & Earn' },
    { key: 'leaderboard', label: '🏆 Leaderboard' },
    { key: 'support', label: '📞 Support' },
  ];

  async function showToggles(chatId) {
    const buttons = TOGGLE_KEYS.map((t) => {
      const enabled = db.isFeatureEnabled(t.key);
      return [{ text: `${enabled ? '🟢' : '🔴'} ${t.label}`, callback_data: `admin:toggle:${t.key}` }];
    });
    buttons.push([{ text: '⬅️ Back', callback_data: 'admin:home' }]);
    await bot.sendMessage(chatId, '🎚️ *Toggle System*\nTap to turn a feature on/off.', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
  }

  async function handleToggleFlip(chatId, data) {
    const key = data.split(':')[2];
    const current = db.isFeatureEnabled(key);
    db.setFeatureEnabled(key, !current);
    await showToggles(chatId);
  }

  // ---------- Deposit approval (called from message handler too) ----------
  async function handleDepositDecision(chatId, data, decision, adminFrom) {
    const depositId = parseInt(data.split(':')[2], 10);
    const deposit = db.getDeposit(depositId);
    if (!deposit || deposit.status !== 'pending') {
      return bot.sendMessage(chatId, 'Already decided or not found.');
    }
    db.decideDeposit(depositId, decision);
    if (decision === 'approved') {
      db.recordDepositOnUser(deposit.user_id, deposit.amount_inr);
    }
    await bot.sendMessage(chatId, `Deposit #${depositId} ${decision}.`);
    if (userBotRef && userBotRef.bot) {
      try {
        await userBotRef.bot.sendMessage(
          deposit.user_id,
          decision === 'approved'
            ? `✅ Your deposit of ₹${deposit.amount_inr} has been approved and added to your balance!`
            : `❌ Your deposit of ₹${deposit.amount_inr} was rejected. Contact support if you think this is a mistake.`
        );
      } catch (_) {}
    }
  }

  // ---------- Order approval ----------
  async function handleOrderDecision(chatId, data, decision, adminFrom) {
    const orderId = parseInt(data.split(':')[2], 10);
    const order = db.getOrder(orderId);
    if (!order || order.status !== 'pending') {
      return bot.sendMessage(chatId, 'Already decided or not found.');
    }
    db.decideOrder(orderId, decision);
    if (decision === 'rejected') {
      // refund
      db.addUserBalance(order.user_id, order.price_inr);
    }
    await bot.sendMessage(chatId, `Order #${orderId} ${decision}.`);
    if (userBotRef && userBotRef.bot) {
      try {
        await userBotRef.bot.sendMessage(
          order.user_id,
          decision === 'approved'
            ? `✅ Your order has been approved! Admin will send your product shortly.`
            : `❌ Your order was rejected and the amount was refunded to your balance.`
        );
      } catch (_) {}
    }
  }

  // ---------- Direct message to user ----------
  async function startDirectMessageFlow(chatId, data) {
    const targetUserId = data.split(':')[1];
    setSession(chatId, 'awaiting_direct_message', { targetUserId });
    await bot.sendMessage(chatId, `Type the message to send to user ${targetUserId}:`);
  }

  // ---------- message handler: password entry + all multi-step flows ----------
  bot.on('message', async (msg) => {
    if (!msg.text && !msg.photo) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!requireAdmin(userId)) return;

    const session = getSession(chatId);
    if (!session) return;

    // ----- password gate -----
    if (session.step === 'awaiting_password' && msg.text) {
      if (msg.text.trim() === config.adminPassword) {
        unlockedChats.add(chatId);
        clearSession(chatId);
        await bot.sendMessage(chatId, '✅ Access granted.', { reply_markup: mainPanelKeyboard() });
      } else {
        await bot.sendMessage(chatId, '❌ Wrong password. Try again:');
      }
      return;
    }

    // ----- join URL -----
    if (session.step === 'awaiting_join_url' && msg.text) {
      setSession(chatId, 'awaiting_join_url_name', { url: msg.text.trim() });
      await bot.sendMessage(chatId, 'Give me the name of the URL:');
      return;
    }
    if (session.step === 'awaiting_join_url_name' && msg.text) {
      db.setSetting('join_url', session.data.url);
      db.setSetting('join_url_name', msg.text.trim());
      clearSession(chatId);
      await bot.sendMessage(chatId, '✅ Join URL updated.', { reply_markup: backKeyboard() });
      return;
    }

    // ----- add product -----
    if (session.step === 'add_product_name' && msg.text) {
      setSession(chatId, 'add_product_price', { name: msg.text.trim() });
      await bot.sendMessage(chatId, 'Product price? (in ₹ rupees, e.g. 150)');
      return;
    }
    if (session.step === 'add_product_price' && msg.text) {
      const price = parseFloat(msg.text.trim());
      if (isNaN(price) || price <= 0) {
        await bot.sendMessage(chatId, '❌ Enter a valid number.');
        return;
      }
      setSession(chatId, 'add_product_stock', { ...session.data, price });
      await bot.sendMessage(chatId, 'Product stock? (how many available)');
      return;
    }
    if (session.step === 'add_product_stock' && msg.text) {
      const stock = parseInt(msg.text.trim(), 10);
      if (isNaN(stock) || stock < 0) {
        await bot.sendMessage(chatId, '❌ Enter a valid whole number.');
        return;
      }
      setSession(chatId, 'add_product_description', { ...session.data, stock });
      await bot.sendMessage(chatId, 'Give a little description (optional, send "-" to skip):');
      return;
    }
    if (session.step === 'add_product_description' && msg.text) {
      const description = msg.text.trim() === '-' ? '' : msg.text.trim();
      const { name, price, stock } = session.data;
      const id = db.addProduct({ name, emoji: '📦', priceInr: price, stock, description });
      clearSession(chatId);
      await bot.sendMessage(chatId, `✅ Product "${name}" saved (ID ${id}).`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💾 Add Another', callback_data: 'admin:addproduct' }],
            [{ text: '⬅️ Back', callback_data: 'admin:home' }],
          ],
        },
      });
      return;
    }

    // ----- edit product (name -> price -> stock -> description, "-" keeps unchanged) -----
    if (session.step === 'edit_product_name' && msg.text) {
      const patch = {};
      if (msg.text.trim() !== '-') patch.name = msg.text.trim();
      setSession(chatId, 'edit_product_price', { ...session.data, patch });
      await bot.sendMessage(chatId, 'New price? (send "-" to keep unchanged)');
      return;
    }
    if (session.step === 'edit_product_price' && msg.text) {
      const patch = { ...session.data.patch };
      if (msg.text.trim() !== '-') {
        const price = parseFloat(msg.text.trim());
        if (!isNaN(price)) patch.price_inr = price;
      }
      setSession(chatId, 'edit_product_stock', { ...session.data, patch });
      await bot.sendMessage(chatId, 'New stock? (send "-" to keep unchanged)');
      return;
    }
    if (session.step === 'edit_product_stock' && msg.text) {
      const patch = { ...session.data.patch };
      if (msg.text.trim() !== '-') {
        const stock = parseInt(msg.text.trim(), 10);
        if (!isNaN(stock)) patch.stock = stock;
      }
      setSession(chatId, 'edit_product_description', { ...session.data, patch });
      await bot.sendMessage(chatId, 'New description? (send "-" to keep unchanged)');
      return;
    }
    if (session.step === 'edit_product_description' && msg.text) {
      const patch = { ...session.data.patch };
      if (msg.text.trim() !== '-') patch.description = msg.text.trim();
      db.updateProduct(session.data.productId, patch);
      clearSession(chatId);
      await bot.sendMessage(chatId, '✅ Product updated.', { reply_markup: backKeyboard('admin:products') });
      return;
    }

    // ----- deposit settings: QR upload -----
    if (session.step === 'awaiting_qr_upload' && msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const { app } = session.data;
      db.setSetting(`upi_${app}_qr_file_id_admin`, fileId);

      // Relay to the user bot so users see a file_id valid for that bot
      if (userBotRef && userBotRef.bot) {
        const newFileId = await relayPhoto(bot, userBotRef.bot, fileId, config.ownerId);
        if (newFileId) {
          db.setSetting(`upi_${app}_qr_file_id`, newFileId);
        } else {
          await bot.sendMessage(chatId, '⚠️ Relay to user bot failed, but admin copy saved. Try again if users report a missing QR.');
        }
      }
      clearSession(chatId);
      await bot.sendMessage(chatId, '✅ New QR uploaded.', { reply_markup: backKeyboard('admin:depositsettings') });
      return;
    }

    // ----- deposit settings: change UPI ID -----
    if (session.step === 'awaiting_upi_id' && msg.text) {
      const { app } = session.data;
      db.setSetting(`upi_${app}_id`, msg.text.trim());
      clearSession(chatId);
      await bot.sendMessage(chatId, '✅ ID updated.', { reply_markup: backKeyboard('admin:depositsettings') });
      return;
    }

    // ----- deposit settings: change Binance ID/name -----
    if (session.step === 'awaiting_binance_id' && msg.text) {
      setSession(chatId, 'awaiting_binance_name', { id: msg.text.trim() });
      await bot.sendMessage(chatId, 'Provide your new name:');
      return;
    }
    if (session.step === 'awaiting_binance_name' && msg.text) {
      db.setSetting('binance_id', session.data.id);
      db.setSetting('binance_name', msg.text.trim());
      clearSession(chatId);
      await bot.sendMessage(chatId, '✅ Binance details updated.', { reply_markup: backKeyboard('admin:depositsettings') });
      return;
    }

    // ----- support username -----
    if (session.step === 'awaiting_support_username' && msg.text) {
      db.setSetting('support_username', msg.text.trim().replace(/^@/, ''));
      clearSession(chatId);
      await bot.sendMessage(chatId, '✅ Support username updated.', { reply_markup: backKeyboard() });
      return;
    }

    // ----- hire admin -----
    if (session.step === 'awaiting_new_admin_id' && msg.text) {
      const newId = msg.text.trim();
      if (!/^\d+$/.test(newId)) {
        await bot.sendMessage(chatId, '❌ Please send a valid numeric Telegram user ID.');
        return;
      }
      db.addAdmin(newId, userId);
      clearSession(chatId);
      await bot.sendMessage(chatId, `✅ User ${newId} is now an admin.`, { reply_markup: backKeyboard() });
      return;
    }

    // ----- direct message to user -----
    if (session.step === 'awaiting_direct_message' && msg.text) {
      const { targetUserId } = session.data;
      clearSession(chatId);
      if (userBotRef && userBotRef.bot) {
        try {
          await userBotRef.bot.sendMessage(targetUserId, `📩 Message from support:\n\n${msg.text}`);
          await bot.sendMessage(chatId, '✅ Message sent.');
        } catch (err) {
          await bot.sendMessage(chatId, '⚠️ Could not deliver message to that user.');
        }
      }
      return;
    }
  });

  return {
    bot,
    sessions,
    unlockedChats,
    relayPhoto,
    // event hooks called by index.js when the user bot creates orders/deposits
    async notifyNewDeposit({ depositId, userId, username, amount, method, userBotFileId }) {
      let adminFileId = null;
      if (userBotFileId) {
        adminFileId = await relayPhoto(userBotRef.bot, bot, userBotFileId, config.ownerId, {
          caption:
            `💰 *New Deposit*\n` +
            `User: @${username || userId} (${userId})\n` +
            `Amount: ₹${amount}\n` +
            `Method: ${method}`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `deposit:approve:${depositId}` },
                { text: '❌ Reject', callback_data: `deposit:reject:${depositId}` },
              ],
              [{ text: '💬 Message User', callback_data: `dm:${userId}` }],
            ],
          },
        });
        if (adminFileId) {
          db.setDepositAdminFileId(depositId, adminFileId);
        } else {
          // graceful fallback: text-only notification, no crash
          await bot.sendMessage(
            config.ownerId,
            `💰 New Deposit #${depositId} from @${username || userId} (${userId}) — ₹${amount} via ${method}\n(screenshot relay failed, ask user to resend if needed)`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Approve', callback_data: `deposit:approve:${depositId}` },
                    { text: '❌ Reject', callback_data: `deposit:reject:${depositId}` },
                  ],
                  [{ text: '💬 Message User', callback_data: `dm:${userId}` }],
                ],
              },
            }
          );
        }
      }
    },
    async notifyNewOrder({ orderId, userId, username, product }) {
      const user = db.getUser(userId);
      await bot.sendMessage(
        config.ownerId,
        `🛍️ *New Order* #${orderId}\n` +
          `User: @${username || userId} (${userId})\n` +
          `Product: ${product.emoji} ${product.name} — ₹${product.price_inr}\n` +
          `User balance: ₹${user.balance_inr.toFixed(2)}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve & Sent', callback_data: `order:approve:${orderId}` },
                { text: '❌ Reject & Refund', callback_data: `order:reject:${orderId}` },
              ],
              [{ text: '💬 Message User', callback_data: `dm:${userId}` }],
            ],
          },
        }
      );
    },
  };
}

module.exports = { createAdminBot };
