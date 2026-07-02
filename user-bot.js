// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// user-bot.js — CLOUDE CART 🛒 | Customer-Facing Bot
// FIXES: 409 conflict, join gate, products, duplicate msgs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const h  = require('./helpers');

// FIX 409: webHook:false + no duplicate polling instance
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: { interval: 300, autoStart: true, params: { timeout: 10 } },
});
module.exports = { bot };

const ADMIN_CHAT   = process.env.ADMIN_NOTIFY_CHAT_ID;
const REF_REWARD   = Number(process.env.REFERRAL_REWARD_INR) || 10;

// ── Duplicate callback guard ───────────────────────────
const _seen = new Map();
function isDupe(id) {
  if (_seen.has(id)) return true;
  _seen.set(id, 1); setTimeout(() => _seen.delete(id), 6000); return false;
}

// ── Send / Edit helpers ────────────────────────────────
const send = (c, t, o={}) => bot.sendMessage(c, t, { parse_mode:'HTML', ...o });
async function edit(c, m, t, o={}) {
  try { await bot.editMessageText(t, { chat_id:c, message_id:m, parse_mode:'HTML', ...o }); }
  catch(_){}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JOIN GATE
// FIX: always check on /start, support URL delete too
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function checkJoined(userId) {
  const links = db.getDb().settings.joinLinks.filter(l => l.enabled);
  if (!links.length) return true;
  for (const l of links) {
    const m = l.url.match(/t\.me\/(?:\+)?([^/?]+)/);
    if (!m) continue;
    try {
      const mem = await bot.getChatMember('@' + m[1], userId);
      if (['left','kicked'].includes(mem.status)) return false;
    } catch(_) {}
  }
  return true;
}

async function showJoinGate(chatId, msgId=null) {
  const links = db.getDb().settings.joinLinks.filter(l => l.enabled);
  const text =
    `👋 <b>Welcome to CLOUDE CART BOT 🛒!</b>\n\n` +
    `🔒 Please join to use the bot:\n\n` +
    links.map(l=>`📣 ${l.name}`).join('\n') +
    `\n\nTap the buttons below then press ✅`;
  const kb = [...links.map(l=>[{text:l.name, url:l.url}]), [{text:'✅ I Joined', callback_data:'check_join'}]];
  const opts = { reply_markup:{inline_keyboard:kb} };
  if (msgId) return edit(chatId, msgId, text, opts);
  return send(chatId, text, opts);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN MENU
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showMenu(chatId, msgId=null, isNew=false) {
  const f = db.getDb().settings.features;
  const text = isNew
    ? `🛒 <b>Choose the items you need:</b>\n\n❗️ If you have not used our products before, please make a small test purchase first to avoid unnecessary disputes! Thank you for your cooperation`
    : `🛒 <b>CLOUDE CART</b> — Choose an option:`;
  const r1=[], r2=[], r3=[];
  if (f.buyAccount) r1.push({text:'🛒 Buy Account',  callback_data:'buy_account'});
  if (f.buySession) r1.push({text:'📂 Buy Sessions', callback_data:'buy_session'});
  if (f.deposit)    r2.push({text:'👤 Profile',      callback_data:'profile'});
  if (f.deposit)    r2.push({text:'💰 Deposit',      callback_data:'deposit'});
  if (f.referEarn)  r3.push({text:'🎁 Refer & Earn', callback_data:'refer_earn'});
  if (f.support)    r3.push({text:'📞 Support',      callback_data:'support'});
  const kb = [r1,r2,r3].filter(r=>r.length);
  const opts = { reply_markup:{inline_keyboard:kb} };
  if (msgId) return edit(chatId, msgId, text, opts);
  return send(chatId, text, opts);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// /start
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const userId  = String(msg.from.id);
  const payload = (match[1]||'').trim();

  if (db.isBanned(userId)) return send(chatId, '🚫 You have been banned.');

  const user = db.getUser(userId);
  db.updateUser(userId, {
    username:  msg.from.username  || user.username,
    firstName: msg.from.first_name || user.firstName,
  });

  // Referral
  if (payload.startsWith('ref_') && !db.hasBeenReferred(userId)) {
    const rid = payload.replace('ref_','');
    if (rid !== userId) db.createReferral(rid, userId, REF_REWARD);
  }

  // FIX: always show join gate if not joined
  const joined = await checkJoined(userId);
  if (!joined) return showJoinGate(chatId);

  // Complete referral
  const ref = db.completeReferral(userId);
  if (ref) {
    try {
      const referrer = db.getUser(ref.referrerId);
      send(ref.referrerId, `🎁 <b>Referral Reward!</b>\nSomeone you referred joined!\n+₹${ref.rewardAmount} added.\n💰 Balance: ${h.formatBalance(referrer.balance)}`);
    } catch(_){}
  }

  const isNew = !user.depositCount && !user.totalDeposited;
  showMenu(chatId, null, isNew);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUY ACCOUNT — FIX: shows all products regardless of stock
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showBuyAccount(chatId, msgId) {
  const db_  = db.getDb();
  const rate = db_.settings.usdtToInrRate || 90;
  const prods = db.listProducts(false);

  if (!prods.length) return edit(chatId, msgId,
    `📦 <b>No accounts listed yet.</b>`,
    { reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'main_menu'}]]} }
  );

  // Flash sale
  const fs = db_.settings.flashSale;
  let flashLine = '';
  if (fs?.active && fs.endsAt) {
    const tl = h.flashSaleTimeLeft(fs.endsAt);
    if (tl) flashLine = `\n🔥 <b>Flash Sale!</b> Ends in <code>${tl}</code>`;
    else { db_.settings.flashSale.active=false; db.saveDb(); }
  }

  const lines = prods.map(p => {
    const usd   = (p.price/rate).toFixed(2);
    const stock = p.stock>0 ? `${p.stock} In Stock` : '❌ Out of Stock';
    return `${p.emoji||'📦'} ${p.name} | $${usd} • ₹${p.price} | ${stock}`;
  });

  const text =
    `✨ <b>Select Account</b>\n⚡ Rate: 1 USDT = ₹${rate}${flashLine}\n\n` +
    `🟢 Good Quality 2FA\n✅ Age Of The Accounts Are Valued Using (Personal Message)\n\n` +
    lines.join('\n');

  const kb = [
    ...prods.map(p=>[{
      text: `${p.emoji||'📦'} ₹${p.price}`,
      callback_data: p.stock>0 ? `product_${p.id}` : `oos_${p.id}`,
    }]),
    [{text:'🔙 Back', callback_data:'main_menu'}],
  ];
  return edit(chatId, msgId, text, { reply_markup:{inline_keyboard:kb} });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUY SESSION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showBuySession(chatId, msgId) {
  const rate  = db.getDb().settings.usdtToInrRate || 90;
  const prods = db.listProducts(true);

  if (!prods.length) return edit(chatId, msgId,
    `📂 <b>No sessions listed yet.</b>`,
    { reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'main_menu'}]]} }
  );

  const lines = prods.map(p => {
    const usd   = (p.price/rate).toFixed(2);
    const stock = p.stock>0 ? `${p.stock} In Stock` : '❌ Out of Stock';
    return `${p.emoji||'📂'} ${p.name} | $${usd} • ₹${p.price} | ${stock}`;
  });

  const text = `📂 <b>Buy Sessions</b>\n⚡ Rate: 1 USDT = ₹${rate}\n\nBuy in bulk — up to available stock\n\n` + lines.join('\n');
  const kb = [
    ...prods.map(p=>[{ text:`${p.emoji||'📂'} ${p.name} — ₹${p.price}`, callback_data: p.stock>0?`product_${p.id}`:`oos_${p.id}` }]),
    [{text:'🔙 Back', callback_data:'main_menu'}],
  ];
  return edit(chatId, msgId, text, { reply_markup:{inline_keyboard:kb} });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRODUCT DETAIL + PURCHASE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showProduct(chatId, msgId, pid) {
  const p    = db.getProduct(pid);
  const rate = db.getDb().settings.usdtToInrRate || 90;
  const back = p?.sessionMode ? 'buy_session' : 'buy_account';
  if (!p) return edit(chatId, msgId, `❌ Product not found.`, { reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:back}]]} });
  const usd  = (p.price/rate).toFixed(2);
  const text =
    `${p.emoji||'📦'} <b>${p.name}</b>\n\n💵 $${usd} • ₹${p.price}\n📦 Stock: ${p.stock}` +
    (p.description ? `\n📝 ${p.description}` : '') + `\n\n⚠️ Confirm purchase?`;
  return edit(chatId, msgId, text, { reply_markup:{inline_keyboard:[
    [{text:'✅ Buy Now',callback_data:`buy_${pid}`},{text:'❌ Cancel',callback_data:back}],
    [{text:'🔙 Back',callback_data:back}],
  ]}});
}

async function doPurchase(chatId, msgId, userId, pid) {
  const p    = db.getProduct(pid);
  const user = db.getUser(userId);
  const rate = db.getDb().settings.usdtToInrRate || 90;
  const back = p?.sessionMode ? 'buy_session' : 'buy_account';

  if (!p || p.stock < 1) return edit(chatId, msgId, `❌ Out of stock.`, { reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:back}]]} });
  if (user.balance < p.price) {
    const short = (p.price - user.balance).toFixed(2);
    return edit(chatId, msgId,
      `💰 <b>Insufficient Balance</b>\n\nNeed ₹${short} more.\nCurrent: ${h.formatBalance(user.balance)}`,
      { reply_markup:{inline_keyboard:[[{text:'💳 Deposit Now',callback_data:'deposit'}],[{text:'🔙 Back',callback_data:back}]]} }
    );
  }

  db.updateUser(userId, { balance: user.balance - p.price });
  db.updateProduct(pid, { stock: p.stock - 1 });
  const order = db.createOrder({ userId, productId: pid, quantity: 1, totalPrice: p.price });
  const usd   = (p.price/rate).toFixed(2);
  const newBal = user.balance - p.price;

  // Tell user
  await edit(chatId, msgId,
    `✅ <b>Order Placed!</b>\n\n📦 ${p.emoji||''} ${p.name}\n💸 ₹${p.price} ($${usd}) deducted\n💰 Remaining: ${h.formatBalance(newBal)}\n\n⏳ <b>Waiting for admin to deliver your product.</b>`,
    { reply_markup:{inline_keyboard:[[{text:'🔙 Main Menu',callback_data:'main_menu'}]]} }
  );

  // Admin notification — direct message + auto-pin
  const adminText =
    `🛒 <b>NEW ORDER — Customer Waiting</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 User: ${user.username?'@'+user.username:user.firstName||'Unknown'}\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `📦 Product: ${p.emoji||''} ${p.name}\n` +
    `💰 Price: ₹${p.price} ($${usd})\n` +
    `💼 Balance After: ₹${newBal.toFixed(2)} ($${(newBal/rate).toFixed(2)})\n` +
    `📋 Order ID: #${order.id}\n` +
    `📅 ${new Date().toLocaleString('en-IN')}`;

  try {
    const aMsg = await h._adminBot.sendMessage(ADMIN_CHAT, adminText, {
      parse_mode:'HTML',
      reply_markup:{inline_keyboard:[
        [{text:'✅ Mark Delivered',callback_data:`deliver_${order.id}`},{text:'✉️ Message User',url:`tg://user?id=${userId}`}],
      ]},
    });
    try { await h._adminBot.pinChatMessage(ADMIN_CHAT, aMsg.message_id); } catch(_){}
  } catch(e) { console.error('[ORDER NOTIFY]', e.message); }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROFILE + LEADERBOARD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showProfile(chatId, msgId, userId) {
  const user = db.getUser(userId);
  const rate = db.getDb().settings.usdtToInrRate || 90;
  return edit(chatId, msgId,
    `👤 <b>Your Profile</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `💰 Balance: ${h.formatBalance(user.balance)}\n` +
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n` +
    `🔁 Deposit Count: ${user.depositCount}\n` +
    `🎁 Referrals: ${user.referralCount} (₹${user.referralEarned.toFixed(2)} earned)\n` +
    `📅 Joined: ${new Date(user.joinedAt).toLocaleDateString('en-IN')}`,
    { reply_markup:{inline_keyboard:[
      [{text:'🏆 Deposit Board',callback_data:'lb_dep'},{text:'🎁 Refer Board',callback_data:'lb_ref'}],
      [{text:'🔙 Back',callback_data:'main_menu'}],
    ]}}
  );
}

async function showLeaderboard(chatId, msgId, type) {
  const list  = type==='dep' ? db.getDepositLeaderboard(10) : db.getReferralLeaderboard(10);
  const title = type==='dep' ? '💰 Top Depositors' : '🎁 Top Referrers';
  const lines = list.map((u,i) => {
    const name = u.username?`@${u.username}`:(u.firstName||`User ${u.userId}`);
    const val  = type==='dep'?`₹${u.totalDeposited.toFixed(2)}`:`${u.referralCount} refs`;
    return `${h.medal(i)} ${name} — ${val}`;
  });
  return edit(chatId, msgId,
    `🏆 <b>${title}</b>\n\n${lines.join('\n')||'No data yet.'}`,
    { reply_markup:{inline_keyboard:[
      [{text:'💰 Deposit Board',callback_data:'lb_dep'},{text:'🎁 Refer Board',callback_data:'lb_ref'}],
      [{text:'🔙 Back',callback_data:'profile'}],
    ]}}
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REFER & EARN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showRefer(chatId, msgId, userId) {
  const info = await bot.getMe();
  const link = `https://t.me/${info.username}?start=ref_${userId}`;
  const user = db.getUser(userId);
  return edit(chatId, msgId,
    `🎁 <b>Refer & Earn</b>\n\nShare your link — earn <b>₹${REF_REWARD}</b> per new user!\n\n🔗 Your Link:\n<code>${link}</code>\n\n👥 Referrals: ${user.referralCount}\n💵 Earned: ₹${user.referralEarned.toFixed(2)}`,
    { reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'main_menu'}]]} }
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SUPPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showSupport(chatId, msgId) {
  const sup = db.getDb().settings.supportUsername;
  return edit(chatId, msgId, `📞 <b>Support</b>\n\nContact our support team:`,
    { reply_markup:{inline_keyboard:[
      [{text:'💬 Contact Support',url:`https://t.me/${sup}`}],
      [{text:'🔙 Back',callback_data:'main_menu'}],
    ]}}
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEPOSIT FLOW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showDeposit(chatId, msgId) {
  const db_  = db.getDb(); const pay = db_.settings.payments;
  if (!db_.settings.features.deposit) return edit(chatId,msgId,`🚫 Deposits currently disabled.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'main_menu'}]]}});
  const kb=[];
  if (pay.gpay.enabled||pay.fampay.enabled||pay.anyupi.enabled) kb.push([{text:'📱 UPI Payment',callback_data:'dep_upi'}]);
  if (pay.binance.enabled) kb.push([{text:'💳 Binance Pay (USDT)',callback_data:'dep_binance'}]);
  kb.push([{text:'🔙 Back',callback_data:'main_menu'}]);
  return edit(chatId,msgId,`💰 <b>Deposit</b>\n\n✅ Minimum: ₹${db_.settings.minDepositInr||20}\n⚠️ Manual verification after screenshot\n\nChoose payment method:`,{reply_markup:{inline_keyboard:kb}});
}

async function showUpiOptions(chatId, msgId) {
  const pay = db.getDb().settings.payments;
  const min = db.getDb().settings.minDepositInr||20;
  const kb=[];
  if (pay.gpay.enabled)   kb.push([{text:'📱 G Pay',   callback_data:'upi_gpay'}]);
  if (pay.fampay.enabled) kb.push([{text:'💳 Fam Pay', callback_data:'upi_fampay'}]);
  if (pay.anyupi.enabled) kb.push([{text:'🗃️ Any UPI',callback_data:'upi_anyupi'}]);
  kb.push([{text:'🔙 Back',callback_data:'deposit'}]);
  return edit(chatId,msgId,`📱 <b>UPI Payment</b>\n━━━━━━━━━━━━━━━━━━━━\n✅ Minimum: ₹${min}\n⚠️ Manual verification after screenshot\n\nChoose your UPI app:`,{reply_markup:{inline_keyboard:kb}});
}

async function showUpiMethod(chatId, msgId, userId, method) {
  const db_ = db.getDb(); const pay = db_.settings.payments[method]; const min=db_.settings.minDepositInr||20;
  const names={gpay:'G Pay',fampay:'Fam Pay',anyupi:'Any UPI'};
  if (!pay?.enabled) return edit(chatId,msgId,`🚫 Disabled.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'dep_upi'}]]}});
  h.setUserState(userId, 'awaiting_amount', {method});
  const cap =
    `📱 <b>${names[method]}</b>\n━━━━━━━━━━━━━━━━━━━━\n✅ Minimum: ₹${min}\n` +
    (pay.upiId?`🆔 UPI ID: <code>${pay.upiId}</code>\n`:'')+
    (pay.upiName?`👤 Name: ${pay.upiName}\n`:'')+
    `\nEnter amount in ₹ (minimum ₹${min}):`;
  if (pay.qrFileId) {
    try { await bot.deleteMessage(chatId,msgId); } catch(_){}
    return bot.sendPhoto(chatId, pay.qrFileId, {caption:cap, parse_mode:'HTML', reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'dep_upi'}]]}});
  }
  return edit(chatId,msgId,cap,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'dep_upi'}]]}});
}

async function showBinance(chatId, msgId, userId) {
  const db_=db.getDb(); const pay=db_.settings.payments.binance; const min=db_.settings.minDepositInr||20; const rate=db_.settings.usdtToInrRate||90;
  if (!pay.enabled) return edit(chatId,msgId,`🚫 Binance Pay disabled.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'deposit'}]]}});
  h.setUserState(userId,'awaiting_amount',{method:'binance'});
  return edit(chatId,msgId,
    `💳 <b>Binance Pay (USDT)</b>\n━━━━━━━━━━━━━━━━━━━━\n`+
    (pay.binanceId?`🆔 ID: <code>${pay.binanceId}</code>\n`:'')+
    (pay.binanceName?`👤 Name: ${pay.binanceName}\n`:'')+
    `\nEnter amount in ₹ (min ₹${min} = $${(min/rate).toFixed(2)} USDT):`,
    {reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'deposit'}]]}}
  );
}

async function handleAmount(msg, state) {
  const chatId=msg.chat.id; const userId=String(msg.from.id);
  const amount=parseFloat(msg.text); const min=db.getDb().settings.minDepositInr||20;
  if (isNaN(amount)||amount<min) return send(chatId,`⚠️ Minimum ₹${min}. Try again:`);
  h.setUserState(userId,'awaiting_screenshot',{method:state.data.method,amount});
  const rate=db.getDb().settings.usdtToInrRate||90;
  return send(chatId,
    `💰 Amount: ₹${amount} ($${(amount/rate).toFixed(2)} USDT)\n\n📸 Please send your payment screenshot now:`,
    {reply_markup:{inline_keyboard:[[{text:'❌ Cancel',callback_data:'deposit'}]]}}
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHOTO — Cross-Bot Photo Relay (payment screenshot)
// FIX: admin pe direct message + auto-pin + screenshot
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('photo', async (msg) => {
  const chatId=msg.chat.id; const userId=String(msg.from.id);
  const state=h.getUserState(userId);
  if (!state||state.state!=='awaiting_screenshot') return;
  h.clearUserState(userId);

  const fileId=msg.photo[msg.photo.length-1].file_id;
  const {method,amount}=state.data;
  const rate=db.getDb().settings.usdtToInrRate||90;
  const usd=(amount/rate).toFixed(2);
  const user=db.getUser(userId);

  const deposit=db.createDeposit({userId,amount,method,screenshotFileId:fileId,screenshotFileIdAdmin:null});

  await send(chatId,
    `✅ <b>Screenshot Received!</b>\n\n💰 ₹${amount} ($${usd})\n📋 Deposit ID: #${deposit.id}\n\n⏳ Please wait a few minutes for admin approval.`,
    {reply_markup:{inline_keyboard:[[{text:'🔙 Main Menu',callback_data:'main_menu'}]]}}
  );

  // Cross-Bot Photo Relay: User Bot → Admin Bot
  const adminFileId = await h.relayPhotoToAdmin(fileId, ADMIN_CHAT);
  if (adminFileId) db.updateDeposit(deposit.id,{screenshotFileIdAdmin:adminFileId});

  const cap =
    `💰 <b>NEW DEPOSIT REQUEST</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 User: ${user.username?'@'+user.username:user.firstName||'Unknown'}\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `💵 Amount: ₹${amount} ($${usd} USDT)\n` +
    `💳 Method: ${method.toUpperCase()}\n` +
    `💼 Current Balance: ₹${user.balance.toFixed(2)}\n` +
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n` +
    `🔁 Deposit Count: ${user.depositCount+1}\n` +
    `📋 Deposit ID: #${deposit.id}\n` +
    `📅 ${new Date().toLocaleString('en-IN')}`;

  const akb={inline_keyboard:[
    [{text:'✅ Approve',callback_data:`dep_ok_${deposit.id}`},{text:'❌ Reject',callback_data:`dep_no_${deposit.id}`}],
    [{text:'✉️ Message User',url:`tg://user?id=${userId}`}],
  ]};

  try {
    const sendId=adminFileId||fileId;
    const aMsg=await h._adminBot.sendPhoto(ADMIN_CHAT,sendId,{caption:cap,parse_mode:'HTML',reply_markup:akb});
    try{await h._adminBot.pinChatMessage(ADMIN_CHAT,aMsg.message_id);}catch(_){}
  } catch(_) {
    try {
      const aMsg=await h._adminBot.sendMessage(ADMIN_CHAT,cap+'\n\n⚠️ Screenshot relay failed — ask user to resend.',{parse_mode:'HTML',reply_markup:akb});
      try{await h._adminBot.pinChatMessage(ADMIN_CHAT,aMsg.message_id);}catch(_){}
    } catch(e){console.error('[DEP NOTIFY]',e.message);}
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEXT HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('message', async (msg) => {
  if (!msg.text||msg.text.startsWith('/')) return;
  const userId=String(msg.from.id);
  const state=h.getUserState(userId);
  if (!state) return;
  if (state.state==='awaiting_amount') return handleAmount(msg,state);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CALLBACK ROUTER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('callback_query', async (q) => {
  if (isDupe(q.id)) return;
  const chatId=q.message.chat.id; const msgId=q.message.message_id;
  const userId=String(q.from.id); const data=q.data;
  await bot.answerCallbackQuery(q.id).catch(()=>{});

  if (db.isBanned(userId)) return send(chatId,'🚫 You are banned.');

  if (data!=='check_join') {
    const joined=await checkJoined(userId);
    if (!joined) return showJoinGate(chatId,msgId);
  }

  if (data==='check_join') {
    const joined=await checkJoined(userId);
    if (!joined) {
      const links=db.getDb().settings.joinLinks.filter(l=>l.enabled);
      return edit(chatId,msgId,`❌ <b>Not joined yet!</b>\n\nPlease join all links then press ✅`,
        {reply_markup:{inline_keyboard:[...links.map(l=>[{text:l.name,url:l.url}]),
          [{text:'✅ I Joined',callback_data:'check_join'}]]}});
    }
    db.completeReferral(userId);
    const user=db.getUser(userId); const isNew=!user.depositCount&&!user.totalDeposited;
    return edit(chatId,msgId,`✅ <b>All Verified!</b>\n\nWelcome! Tap below or send /start.`,
      {reply_markup:{inline_keyboard:[[{text:'🚀 Start Now',callback_data:isNew?'menu_new':'main_menu'}]]}});
  }

  if (data==='main_menu')    return showMenu(chatId,msgId,false);
  if (data==='menu_new')     return showMenu(chatId,msgId,true);
  if (data==='buy_account')  return showBuyAccount(chatId,msgId);
  if (data==='buy_session')  return showBuySession(chatId,msgId);
  if (data==='profile')      return showProfile(chatId,msgId,userId);
  if (data==='deposit')      return showDeposit(chatId,msgId);
  if (data==='dep_upi')      return showUpiOptions(chatId,msgId);
  if (data==='upi_gpay')     return showUpiMethod(chatId,msgId,userId,'gpay');
  if (data==='upi_fampay')   return showUpiMethod(chatId,msgId,userId,'fampay');
  if (data==='upi_anyupi')   return showUpiMethod(chatId,msgId,userId,'anyupi');
  if (data==='dep_binance')  return showBinance(chatId,msgId,userId);
  if (data==='refer_earn')   return showRefer(chatId,msgId,userId);
  if (data==='support')      return showSupport(chatId,msgId);
  if (data==='lb_dep')       return showLeaderboard(chatId,msgId,'dep');
  if (data==='lb_ref')       return showLeaderboard(chatId,msgId,'ref');
  if (data.startsWith('oos_'))      return bot.answerCallbackQuery(q.id,{text:'❌ Out of stock!',show_alert:true});
  if (data.startsWith('product_'))  return showProduct(chatId,msgId,data.replace('product_',''));
  if (data.startsWith('buy_'))      return doPurchase(chatId,msgId,userId,data.replace('buy_',''));
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PUBLIC — called by admin-bot
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function notifyDepositApproved(userId, deposit) {
  const user=db.getUser(userId); const rate=db.getDb().settings.usdtToInrRate||90;
  send(userId,
    `✅ <b>Deposit Approved!</b>\n\n💵 ₹${deposit.amount} ($${(deposit.amount/rate).toFixed(2)})\n💰 New Balance: ${h.formatBalance(user.balance)}\n📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n🔁 Deposits: ${user.depositCount}\n\nThank you! 🙏`
  );
}
async function notifyDepositRejected(userId, deposit) {
  const rate=db.getDb().settings.usdtToInrRate||90;
  send(userId,
    `❌ <b>Deposit Rejected</b>\n\n💵 ₹${deposit.amount} ($${(deposit.amount/rate).toFixed(2)})\n\nContact support if this is an error.`,
    {reply_markup:{inline_keyboard:[[{text:'📞 Support',callback_data:'support'}]]}}
  );
}
async function notifyOrderDelivered(userId, order) {
  const p=db.getProduct(order.productId);
  send(userId,`📦 <b>Order Delivered!</b>\n\n${p?(p.emoji||'📦')+' '+p.name:'Your order'} has been delivered.\n\nThank you! 🙏`);
}

module.exports.notifyDepositApproved=notifyDepositApproved;
module.exports.notifyDepositRejected=notifyDepositRejected;
module.exports.notifyOrderDelivered=notifyOrderDelivered;

console.log('🛒 CLOUDE CART User Bot started...');
