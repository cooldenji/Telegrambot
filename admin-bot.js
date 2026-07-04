// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// admin-bot.js — CLOUDE CART 🛒 | Admin Bot
// FIX: 409 conflict, join URL delete, ban system
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db  = require('./db');
const h   = require('./helpers');

const bot      = new TelegramBot(process.env.ADMIN_BOT_TOKEN, {
  polling: { interval: 300, autoStart: true, params: { timeout: 10 } },
});
const OWNER_ID = String(process.env.OWNER_ID);
const PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_CHAT = process.env.ADMIN_NOTIFY_CHAT_ID;

// Cross-bot setup — delayed so both files load first
let U = null;
setTimeout(() => {
  U = require('./user-bot');
  h.setBots(U.bot, bot);
}, 800);

// ── Auth ───────────────────────────────────────────────
const _auth = new Set();
function isAuth(id)  { return String(id)===OWNER_ID||db.isAdmin(String(id))||_auth.has(String(id)); }
function isOwner(id) { return String(id)===OWNER_ID; }

// ── Duplicate guard ────────────────────────────────────
const _seen = new Map();
function isDupe(id) {
  if (_seen.has(id)) return true;
  _seen.set(id,1); setTimeout(()=>_seen.delete(id),6000); return false;
}

const send = (c,t,o={}) => bot.sendMessage(c,t,{parse_mode:'HTML',...o});
async function edit(c,m,t,o={}) { try{await bot.editMessageText(t,{chat_id:c,message_id:m,parse_mode:'HTML',...o});}catch(_){} }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// /start
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.onText(/\/start/, async (msg) => {
  const chatId=msg.chat.id; const userId=String(msg.from.id);
  if (!isAuth(userId)) {
    h.setAdminState(userId,'awaiting_password');
    return send(chatId,`🔐 <b>Welcome to CLOUDE CART Admin Panel</b>\n\nEnter admin password:`);
  }
  _auth.add(userId);
  showPanel(chatId,null,userId);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEXT HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('message', async (msg) => {
  if (!msg.text||msg.text.startsWith('/')) return;
  const chatId=msg.chat.id; const userId=String(msg.from.id);
  const state=h.getAdminState(userId);

  if (state?.state==='awaiting_password') {
    if (msg.text.trim()===PASSWORD) { _auth.add(userId); h.clearAdminState(userId); return showPanel(chatId,null,userId); }
    return send(chatId,`❌ Wrong password. Try again:`);
  }
  if (!isAuth(userId)) return;
  if (!state) return;

  const t=msg.text; const d=state.data||{};
  switch(state.state) {
    case 'join_url':      return handleJoinUrl(chatId,userId,t,d);
    case 'join_name':     return handleJoinName(chatId,userId,t,d);
    case 'prod_name':     return handleProd(chatId,userId,'name',t,d);
    case 'prod_price':    return handleProd(chatId,userId,'price',t,d);
    case 'prod_stock':    return handleProd(chatId,userId,'stock',t,d);
    case 'prod_emoji':    return handleProd(chatId,userId,'emoji',t,d);
    case 'prod_desc':     return handleProd(chatId,userId,'desc',t,d);
    case 'upi_id':        return handleUpiId(chatId,userId,t,d);
    case 'upi_name':      return handleUpiName(chatId,userId,t,d);
    case 'bin_id':        return handleBinId(chatId,userId,t,d);
    case 'bin_name':      return handleBinName(chatId,userId,t,d);
    case 'support_user':  return handleSupportUser(chatId,userId,t);
    case 'rate':          return handleRate(chatId,userId,t);
    case 'min_dep':       return handleMinDep(chatId,userId,t);
    case 'hire_admin':    return handleHireAdmin(chatId,userId,t);
    case 'broadcast':     return handleBroadcast(chatId,userId,t);
    case 'flash_prod':    return handleFlashProd(chatId,userId,t,d);
    case 'flash_pct':     return handleFlashPct(chatId,userId,t,d);
    case 'flash_hrs':     return handleFlashHrs(chatId,userId,t,d);
    case 'ban_user':      return handleBanUser(chatId,userId,t);
    case 'unban_user':    return handleUnbanUser(chatId,userId,t);
    case 'msg_user':      return handleMsgUser(chatId,userId,t,d);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN PANEL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showPanel(chatId,msgId,userId) {
  const text=`⚙️ <b>CLOUDE CART — Admin Panel</b>\n\nChoose an option:`;
  const kb=[
    [{text:'🔗 Change Join URL',callback_data:'adm_join'},{text:'📦 Add Product',callback_data:'adm_add_prod'}],
    [{text:'📋 Products',callback_data:'adm_prods'},{text:'💳 Deposit Settings',callback_data:'adm_dep_settings'}],
    [{text:'📥 Pending Deposits',callback_data:'adm_pending_dep'},{text:'🛒 Pending Orders',callback_data:'adm_pending_ord'}],
    [{text:'🔀 Feature Toggles',callback_data:'adm_toggles'},{text:'🔥 Flash Sale',callback_data:'adm_flash'}],
    [{text:'📢 Broadcast',callback_data:'adm_broadcast'},{text:'📞 Change Support',callback_data:'adm_support'}],
    [{text:'⚙️ Rate & Min Dep',callback_data:'adm_settings'},{text:'👥 Admins',callback_data:'adm_admins'}],
    [{text:'🚫 Ban / Unban User',callback_data:'adm_ban'}],
  ];
  if (msgId) return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:kb}});
  return send(chatId,text,{reply_markup:{inline_keyboard:kb}});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JOIN URL — FIX: delete option added
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showJoinMenu(chatId,msgId) {
  const links=db.getDb().settings.joinLinks;
  const text=`🔗 <b>Join URL Management</b>\n\n`+
    (links.length?links.map((l,i)=>`${i+1}. ${l.enabled?'🟢':'🔴'} <b>${l.name}</b>\n   ${l.url}`).join('\n\n'):'No links set yet.');
  const kb=[
    ...links.map((l,i)=>[
      {text:`✏️ Edit #${i+1}`,callback_data:`join_edit_${i}`},
      {text:`${l.enabled?'🔴 Disable':'🟢 Enable'}`,callback_data:`join_toggle_${i}`},
      {text:`🗑️ Delete`,callback_data:`join_del_${i}`},
    ]),
    [{text:'➕ Add New Link',callback_data:'join_add'}],
    [{text:'🔙 Back',callback_data:'adm_panel'}],
  ];
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:kb}});
}
async function handleJoinUrl(chatId,userId,text,data) {
  const db_=db.getDb();
  if (data.index!==undefined) db_.settings.joinLinks[data.index].url=text.trim();
  else db_.settings.joinLinks.push({name:'New Link',url:text.trim(),enabled:true});
  db.saveDb();
  const idx=data.index!==undefined?data.index:db_.settings.joinLinks.length-1;
  h.setAdminState(userId,'join_name',{index:idx});
  return send(chatId,`✅ URL saved! Now send the display name:`);
}
async function handleJoinName(chatId,userId,text,data) {
  const db_=db.getDb(); db_.settings.joinLinks[data.index].name=text.trim(); db.saveDb();
  h.clearAdminState(userId);
  return send(chatId,`✅ Join link updated!`,{reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel'}]]}});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRODUCTS — FIX: add/edit/delete all working
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const _draft={};

async function showProds(chatId,msgId,sessionMode=false) {
  const rate=db.getDb().settings.usdtToInrRate||90;
  const prods=db.listProducts(sessionMode);
  const title=sessionMode?'📂 Sessions':'📦 Accounts';
  const text=prods.length
    ?`${title}\n\n`+prods.map(p=>{const u=(p.price/rate).toFixed(2);return `${p.emoji||'📦'} ${p.name} | $${u} • ₹${p.price} | Stock: ${p.stock}`;}).join('\n')
    :`${title}\n\nNo products yet.`;
  const kb=[
    [{text:'📦 Accounts',callback_data:'prods_acc'},{text:'📂 Sessions',callback_data:'prods_ses'}],
    ...prods.map(p=>[{text:`${p.emoji||'📦'} ${p.name} — ₹${p.price}`,callback_data:`prod_${p.id}`}]),
    [{text:'🔙 Back',callback_data:'adm_panel'}],
  ];
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:kb}});
}

async function showProd(chatId,msgId,pid) {
  const p=db.getProduct(pid); if (!p) return;
  const rate=db.getDb().settings.usdtToInrRate||90; const u=(p.price/rate).toFixed(2);
  const text=`${p.emoji||'📦'} <b>${p.name}</b>\n\n💵 $${u} • ₹${p.price}\n📦 Stock: ${p.stock}\n📝 ${p.description||'No description'}\n🏷️ ${p.sessionMode?'Session':'Account'}`;
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:[
    [{text:'✏️ Edit',callback_data:`prod_edit_${pid}`},{text:'🗑️ Delete',callback_data:`prod_del_${pid}`}],
    [{text:'🔙 Back',callback_data:'adm_prods'}],
  ]}});
}

async function startAddProd(chatId,userId,sessionMode=false) {
  _draft[userId]={sessionMode};
  h.setAdminState(userId,'prod_name',{sessionMode});
  return send(chatId,`📦 <b>Add Product</b>\n\nStep 1/5 — Enter product name:`);
}

async function handleProd(chatId,userId,field,text,data) {
  const d=_draft[userId]||{};
  if (field==='name')  { d.name=text.trim(); _draft[userId]=d; h.setAdminState(userId,'prod_price',data); return send(chatId,`Step 2/5 — Price in ₹:`); }
  if (field==='price') {
    const p=parseFloat(text); if (isNaN(p)||p<=0) return send(chatId,`❌ Invalid price:`);
    d.price=p; _draft[userId]=d; h.setAdminState(userId,'prod_stock',data); return send(chatId,`Step 3/5 — Stock quantity:`);
  }
  if (field==='stock') {
    const s=parseInt(text); if (isNaN(s)||s<0) return send(chatId,`❌ Invalid stock:`);
    d.stock=s; _draft[userId]=d; h.setAdminState(userId,'prod_emoji',data); return send(chatId,`Step 4/5 — Emoji (e.g. 🇮🇳):`);
  }
  if (field==='emoji') { d.emoji=text.trim(); _draft[userId]=d; h.setAdminState(userId,'prod_desc',data); return send(chatId,`Step 5/5 — Description (or /skip):`); }
  if (field==='desc')  {
    d.description=text.startsWith('/skip')?null:text.trim();
    const prod=db.addProduct({...d});
    delete _draft[userId]; h.clearAdminState(userId);
    const rate=db.getDb().settings.usdtToInrRate||90;
    return send(chatId,`✅ Product added!\n\n${prod.emoji} ${prod.name}\n$${(prod.price/rate).toFixed(2)} • ₹${prod.price}\nStock: ${prod.stock}`,
      {reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel'}]]}});
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEPOSIT SETTINGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showDepSettings(chatId,msgId) {
  const pay=db.getDb().settings.payments;
  return edit(chatId,msgId,`💳 <b>Deposit Settings</b>\n\nSelect payment method:`,{reply_markup:{inline_keyboard:[
    [{text:`📱 G Pay ${pay.gpay.enabled?'🟢':'🔴'}`,callback_data:'pay_gpay'},{text:`💳 Fam Pay ${pay.fampay.enabled?'🟢':'🔴'}`,callback_data:'pay_fampay'}],
    [{text:`🗃️ Any UPI ${pay.anyupi.enabled?'🟢':'🔴'}`,callback_data:'pay_anyupi'},{text:`🏦 Binance ${pay.binance.enabled?'🟢':'🔴'}`,callback_data:'pay_binance'}],
    [{text:'🔙 Back',callback_data:'adm_panel'}],
  ]}});
}

async function showPayMethod(chatId,msgId,method) {
  const pay=db.getDb().settings.payments[method];
  const names={gpay:'G Pay',fampay:'Fam Pay',anyupi:'Any UPI',binance:'Binance Pay'};
  const isBin=method==='binance';
  const text=`💳 <b>${names[method]} Settings</b>\n\nStatus: ${pay.enabled?'🟢 Enabled':'🔴 Disabled'}\n`+
    (isBin?`🆔 ID: ${pay.binanceId||'Not set'}\n👤 Name: ${pay.binanceName||'Not set'}`
          :`🆔 UPI ID: ${pay.upiId||'Not set'}\n👤 Name: ${pay.upiName||'Not set'}\n🖼️ QR: ${pay.qrFileId?'✅ Set':'❌ Not set'}`);
  const kb=[];
  if (!isBin) {
    kb.push([{text:'🖼️ Change QR',callback_data:`qr_${method}`},{text:'🆔 Change ID/Name',callback_data:`uid_${method}`}]);
    kb.push([{text:'🗑️ Delete QR/ID',callback_data:`pdel_${method}`}]);
  } else {
    kb.push([{text:'🆔 Change Binance ID/Name',callback_data:`bid_binance`}]);
    kb.push([{text:'🗑️ Delete Binance ID',callback_data:`pdel_binance`}]);
  }
  kb.push([{text:`${pay.enabled?'🔴 Disable':'🟢 Enable'}`,callback_data:`ptog_${method}`}]);
  kb.push([{text:'🔙 Back',callback_data:'adm_dep_settings'}]);
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:kb}});
}

// QR Upload (Admin→User relay + permanent storage)
async function handleQrUpload(chatId,userId,method,adminFileId) {
  await send(chatId,`⏳ Uploading QR permanently, please wait...`);
  const result = await h.mintUserBotFileId(adminFileId);
  const db_    = db.getDb();
  if (result && result.userFileId) {
    // Save BOTH permanently stored file_ids (from STORAGE_CHAT_ID)
    // These never expire because they're anchored to a real message
    db_.settings.payments[method].qrFileId      = result.userFileId;
    db_.settings.payments[method].qrFileIdAdmin = result.adminFileIdStored;
    db.saveDb();
    return send(chatId,
      `✅ QR saved permanently!\n\n🗄️ Stored in your storage chat — will never expire.\n✅ Both bots have valid copies.`,
      {reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:`pay_${method}`}]]}}
    );
  } else {
    db_.settings.payments[method].qrFileIdAdmin=adminFileId; db.saveDb();
    return send(chatId,`⚠️ Admin copy saved, but User Bot relay failed.\nCheck BOT_TOKEN & Owner must /start the User Bot first.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:`pay_${method}`}]]}});
  }
}

async function handleUpiId(chatId,userId,text,data)   { db.getDb().settings.payments[data.method].upiId=text.trim(); db.saveDb(); h.setAdminState(userId,'upi_name',data); return send(chatId,`✅ UPI ID saved! Now enter display name:`); }
async function handleUpiName(chatId,userId,text,data)  { db.getDb().settings.payments[data.method].upiName=text.trim(); db.saveDb(); h.clearAdminState(userId); return send(chatId,`✅ UPI ID & Name updated!`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:`pay_${data.method}`}]]}}); }
async function handleBinId(chatId,userId,text,data)    { db.getDb().settings.payments.binance.binanceId=text.trim(); db.saveDb(); h.setAdminState(userId,'bin_name',data); return send(chatId,`✅ Binance ID saved! Enter display name:`); }
async function handleBinName(chatId,userId,text,data)  { db.getDb().settings.payments.binance.binanceName=text.trim(); db.saveDb(); h.clearAdminState(userId); return send(chatId,`✅ Binance ID & Name updated!`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'pay_binance'}]]}}); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PENDING DEPOSITS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showPendingDep(chatId,msgId) {
  const pend=db.getPendingDeposits();
  if (!pend.length) return edit(chatId,msgId,`📥 <b>No Pending Deposits</b>`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'adm_panel'}]]}});
  const text=`📥 <b>Pending Deposits</b> (${pend.length})`;
  const kb=[...pend.map(d=>{const u=db.getUser(d.userId); return [{text:`#${d.id} — ${u.username?'@'+u.username:d.userId} — ₹${d.amount}`,callback_data:`dep_view_${d.id}`}];}), [{text:'🔙 Back',callback_data:'adm_panel'}]];
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:kb}});
}

async function showDepDetail(chatId,msgId,did) {
  const dep=db.getDeposit(did); if (!dep) return send(chatId,`❌ Not found.`);
  const user=db.getUser(dep.userId); const rate=db.getDb().settings.usdtToInrRate||90; const usd=(dep.amount/rate).toFixed(2);
  const cap=
    `💰 <b>Deposit #${did}</b>\n━━━━━━━━━━━━━━━━━━━━\n`+
    `👤 User: ${user.username?'@'+user.username:user.firstName||'Unknown'}\n`+
    `🆔 ID: <code>${dep.userId}</code>\n`+
    `💵 ₹${dep.amount} ($${usd})\n`+
    `💳 Method: ${dep.method?.toUpperCase()}\n`+
    `💼 Balance: ₹${user.balance.toFixed(2)}\n`+
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n`+
    `🔁 Deposits: ${user.depositCount}\n`+
    `📅 ${new Date(dep.createdAt).toLocaleString('en-IN')}`;
  const kb={inline_keyboard:[
    [{text:'✅ Approve',callback_data:`dep_ok_${did}`},{text:'❌ Reject',callback_data:`dep_no_${did}`}],
    [{text:'✉️ Message User',callback_data:`msg_${dep.userId}`}],
    [{text:'🔙 Back',callback_data:'adm_pending_dep'}],
  ]};
  const fileId=dep.screenshotFileIdAdmin||dep.screenshotFileId;
  if (fileId) {
    try{await bot.deleteMessage(chatId,msgId);}catch(_){}
    await bot.sendPhoto(chatId,fileId,{caption:cap,parse_mode:'HTML',reply_markup:kb});
  } else {
    await edit(chatId,msgId,cap,{reply_markup:kb});
  }
}

async function approveDeposit(chatId,msgId,did) {
  const dep=db.getDeposit(did); if (!dep||dep.status!=='pending') return send(chatId,`❌ Not found or already processed.`);
  db.updateDeposit(did,{status:'approved',approvedAt:Date.now()});
  const user=db.getUser(dep.userId);
  db.updateUser(dep.userId,{balance:user.balance+dep.amount,totalDeposited:user.totalDeposited+dep.amount,depositCount:user.depositCount+1});
  const updatedUser=db.getUser(dep.userId);
  const rate=db.getDb().settings.usdtToInrRate||90;
  const usd=(dep.amount/rate).toFixed(2);

  // Tell admin
  await send(chatId,`✅ Deposit #${did} Approved! ₹${dep.amount} added.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Pending',callback_data:'adm_pending_dep'}]]}});

  // FIX 2: Also send approval log to STORAGE_CHAT_ID channel
  const storageChatId=process.env.STORAGE_CHAT_ID;
  if (storageChatId) {
    try {
      await bot.sendMessage(storageChatId,
        `✅ <b>DEPOSIT APPROVED</b>\n━━━━━━━━━━━━━━━━━━━━\n`+
        `👤 User: ${user.username?'@'+user.username:user.firstName||'Unknown'}\n`+
        `🆔 ID: <code>${dep.userId}</code>\n`+
        `💵 Amount: ₹${dep.amount} ($${usd})\n`+
        `💳 Method: ${dep.method?.toUpperCase()}\n`+
        `💰 New Balance: ₹${updatedUser.balance.toFixed(2)}\n`+
        `📋 Deposit ID: #${did}\n`+
        `📅 ${new Date().toLocaleString('en-IN')}`,
        {parse_mode:'HTML'}
      );
    } catch(_){}
  }

  // FIX 1: Notify user via User Bot (not Telegram DM)
  try{await U.notifyDepositApproved(dep.userId,dep);}catch(_){}
}

async function rejectDeposit(chatId,msgId,did) {
  const dep=db.getDeposit(did); if (!dep||dep.status!=='pending') return send(chatId,`❌ Not found or already processed.`);
  db.updateDeposit(did,{status:'rejected',rejectedAt:Date.now()});
  const user=db.getUser(dep.userId);
  const rate=db.getDb().settings.usdtToInrRate||90;
  const usd=(dep.amount/rate).toFixed(2);

  // Tell admin
  await send(chatId,`❌ Deposit #${did} Rejected.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Pending',callback_data:'adm_pending_dep'}]]}});

  // FIX 2: Also send rejection log to STORAGE_CHAT_ID channel
  const storageChatId=process.env.STORAGE_CHAT_ID;
  if (storageChatId) {
    try {
      await bot.sendMessage(storageChatId,
        `❌ <b>DEPOSIT REJECTED</b>\n━━━━━━━━━━━━━━━━━━━━\n`+
        `👤 User: ${user.username?'@'+user.username:user.firstName||'Unknown'}\n`+
        `🆔 ID: <code>${dep.userId}</code>\n`+
        `💵 Amount: ₹${dep.amount} ($${usd})\n`+
        `💳 Method: ${dep.method?.toUpperCase()}\n`+
        `📋 Deposit ID: #${did}\n`+
        `📅 ${new Date().toLocaleString('en-IN')}`,
        {parse_mode:'HTML'}
      );
    } catch(_){}
  }

  // FIX 1: Notify user via User Bot (not Telegram DM)
  try{await U.notifyDepositRejected(dep.userId,dep);}catch(_){}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PENDING ORDERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showPendingOrd(chatId,msgId) {
  const ords=db.getPendingOrders();
  if (!ords.length) return edit(chatId,msgId,`🛒 <b>No Pending Orders</b>`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'adm_panel'}]]}});
  const kb=[...ords.map(o=>{const u=db.getUser(o.userId);const p=db.getProduct(o.productId);return [{text:`#${o.id} — ${u.username?'@'+u.username:o.userId} — ${p?.name||'?'}`,callback_data:`ord_${o.id}`}];}),
    [{text:'🔙 Back',callback_data:'adm_panel'}]];
  return edit(chatId,msgId,`🛒 <b>Pending Orders</b> (${ords.length})`,{reply_markup:{inline_keyboard:kb}});
}

async function showOrdDetail(chatId,msgId,oid) {
  const ord=db.getOrder(oid); if (!ord) return;
  const user=db.getUser(ord.userId); const p=db.getProduct(ord.productId); const rate=db.getDb().settings.usdtToInrRate||90;
  const text=
    `🛒 <b>Order #${oid}</b>\n━━━━━━━━━━━━━━━━━━━━\n`+
    `👤 User: ${user.username?'@'+user.username:user.firstName||'Unknown'}\n`+
    `🆔 ID: <code>${ord.userId}</code>\n`+
    `📦 Product: ${p?.emoji||''} ${p?.name||'Unknown'}\n`+
    `💰 Price: ₹${ord.totalPrice} ($${(ord.totalPrice/rate).toFixed(2)})\n`+
    `💼 Balance: ${h.formatBalance(user.balance)}\n`+
    `📅 ${new Date(ord.createdAt).toLocaleString('en-IN')}`;
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:[
    [{text:'✅ Mark Delivered',callback_data:`deliver_${oid}`},{text:'✉️ Message User',callback_data:`msg_${ord.userId}`}],
    [{text:'🔙 Back',callback_data:'adm_pending_ord'}],
  ]}});
}

async function deliverOrder(chatId,msgId,oid) {
  const ord=db.getOrder(oid); if (!ord) return;
  db.updateOrder(oid,{status:'delivered',deliveredAt:Date.now()});
  await send(chatId,`✅ Order #${oid} marked as delivered!`,{reply_markup:{inline_keyboard:[[{text:'🔙 Orders',callback_data:'adm_pending_ord'}]]}});
  try{await U.notifyOrderDelivered(ord.userId,ord);}catch(_){}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FEATURE TOGGLES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showToggles(chatId,msgId) {
  const f=db.getDb().settings.features;
  const btn=(lbl,key)=>({text:`${f[key]?'🟢':'🔴'} ${lbl}`,callback_data:`tog_${key}`});
  return edit(chatId,msgId,`🔀 <b>Feature Toggles</b>`,{reply_markup:{inline_keyboard:[
    [btn('Buy Account','buyAccount'),btn('Buy Sessions','buySession')],
    [btn('Deposit','deposit'),btn('Refer & Earn','referEarn')],
    [btn('Support','support'),btn('Leaderboard','leaderboard')],
    [{text:'🔙 Back',callback_data:'adm_panel'}],
  ]}});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FLASH SALE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showFlash(chatId,msgId) {
  const fs=db.getDb().settings.flashSale;
  const text=fs.active?`🔥 <b>Flash Sale ACTIVE</b>\n\nProduct: ${fs.productId}\nDiscount: ${fs.discountPercent}%\nEnds: ${new Date(fs.endsAt).toLocaleString('en-IN')}`:`🔥 <b>Flash Sale</b>\n\nNo active flash sale.`;
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:[
    [{text:fs.active?'🛑 Stop':'🔥 Start Flash Sale',callback_data:fs.active?'flash_stop':'flash_start'}],
    [{text:'🔙 Back',callback_data:'adm_panel'}],
  ]}});
}
async function handleFlashProd(chatId,userId,text,data) { const p=db.getProduct(text.trim()); if (!p) return send(chatId,`❌ Product ID not found:`); _draft[userId]={productId:text.trim()}; h.setAdminState(userId,'flash_pct',data); return send(chatId,`Enter discount % (e.g. 20):`); }
async function handleFlashPct(chatId,userId,text,data)  { const pct=parseInt(text); if (isNaN(pct)||pct<1||pct>99) return send(chatId,`❌ Enter 1-99:`); _draft[userId]={..._draft[userId],discountPercent:pct}; h.setAdminState(userId,'flash_hrs',data); return send(chatId,`For how many hours?`); }
async function handleFlashHrs(chatId,userId,text,data)  {
  const hrs=parseFloat(text); if (isNaN(hrs)||hrs<=0) return send(chatId,`❌ Invalid hours:`);
  const d=_draft[userId]||{}; const db_=db.getDb();
  db_.settings.flashSale={active:true,productId:d.productId,discountPercent:d.discountPercent,endsAt:Date.now()+hrs*3600000};
  db.updateProduct(d.productId,{flashSale:true}); db.saveDb();
  delete _draft[userId]; h.clearAdminState(userId);
  return send(chatId,`🔥 Flash Sale started! ${d.discountPercent}% off for ${hrs}h.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel'}]]}});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BROADCAST
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleBroadcast(chatId,userId,text) {
  h.clearAdminState(userId);
  const users=Object.values(db.getDb().users); let sent=0,failed=0;
  await send(chatId,`📢 Sending to ${users.length} users...`);
  for (const u of users) {
    try { await U.bot.sendMessage(u.userId,`📢 <b>Announcement</b>\n\n${text}`,{parse_mode:'HTML'}); sent++; }
    catch(_){failed++;}
    await new Promise(r=>setTimeout(r,50));
  }
  return send(chatId,`✅ Done! Sent: ${sent} | Failed: ${failed}`,{reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel'}]]}});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SETTINGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showSettings(chatId,msgId) {
  const db_=db.getDb();
  return edit(chatId,msgId,`⚙️ <b>Settings</b>\n\n💱 Rate: 1 USDT = ₹${db_.settings.usdtToInrRate}\n💵 Min Deposit: ₹${db_.settings.minDepositInr}`,
    {reply_markup:{inline_keyboard:[[{text:'💱 Change Rate',callback_data:'set_rate'},{text:'💵 Change Min',callback_data:'set_min'}],[{text:'🔙 Back',callback_data:'adm_panel'}]]}});
}
async function handleSupportUser(chatId,userId,text) { db.getDb().settings.supportUsername=text.trim().replace('@',''); db.saveDb(); h.clearAdminState(userId); return send(chatId,`✅ Support updated to @${text.trim().replace('@','')}`,{reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel'}]]}}); }
async function handleRate(chatId,userId,text) { const r=parseFloat(text); if (isNaN(r)||r<=0) return send(chatId,`❌ Invalid:`); db.getDb().settings.usdtToInrRate=r; db.saveDb(); h.clearAdminState(userId); return send(chatId,`✅ Rate: 1 USDT = ₹${r}`,{reply_markup:{inline_keyboard:[[{text:'🔙 Settings',callback_data:'adm_settings'}]]}}); }
async function handleMinDep(chatId,userId,text) { const m=parseFloat(text); if (isNaN(m)||m<=0) return send(chatId,`❌ Invalid:`); db.getDb().settings.minDepositInr=m; db.saveDb(); h.clearAdminState(userId); return send(chatId,`✅ Min deposit: ₹${m}`,{reply_markup:{inline_keyboard:[[{text:'🔙 Settings',callback_data:'adm_settings'}]]}}); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMINS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showAdmins(chatId,msgId) {
  const admins=db.listAdmins();
  return edit(chatId,msgId,`👥 <b>Hired Admins</b>\n\n`+(admins.length?admins.map(a=>`• <code>${a.userId}</code>`).join('\n'):'None'),
    {reply_markup:{inline_keyboard:[
      [{text:'➕ Hire Admin',callback_data:'hire_admin'}],
      ...admins.map(a=>[{text:`🗑️ Remove ${a.userId}`,callback_data:`fire_${a.userId}`}]),
      [{text:'🔙 Back',callback_data:'adm_panel'}],
    ]}});
}
async function handleHireAdmin(chatId,userId,text) { const tid=text.trim(); if (tid===OWNER_ID) return send(chatId,`❌ Owner already authorized.`); db.addAdmin(tid,userId); h.clearAdminState(userId); return send(chatId,`✅ Admin <code>${tid}</code> hired!`,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🔙 Admins',callback_data:'adm_admins'}]]}}); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMIN → USER MESSAGING SYSTEM
// Admin message likhta hai → User Bot se user ko deliver
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleMsgUser(chatId, userId, text, data) {
  const targetId = data.targetUserId;
  const user     = db.getUser(targetId);

  h.clearAdminState(userId);

  try {
    // Deliver via User Bot so it appears from the store bot
    await U.bot.sendMessage(targetId,
      `📩 <b>Message from Admin</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${text}`,
      { parse_mode: 'HTML' }
    );
    return send(chatId,
      `✅ Message delivered to ${user.username ? '@'+user.username : targetId} via User Bot!`,
      { reply_markup: { inline_keyboard: [
        [{ text: '✉️ Send Another', callback_data: `msg_${targetId}` }],
        [{ text: '🔙 Panel', callback_data: 'adm_panel' }],
      ]}}
    );
  } catch (err) {
    return send(chatId,
      `❌ Failed to deliver message.\nUser may have blocked the bot.\n\nError: ${err.message}`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Panel', callback_data: 'adm_panel' }]] }}
    );
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BAN / UNBAN SYSTEM — NEW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showBanMenu(chatId,msgId) {
  return edit(chatId,msgId,`🚫 <b>Ban / Unban System</b>\n\nEnter user ID to ban or unban:`,
    {reply_markup:{inline_keyboard:[
      [{text:'🚫 Ban User',callback_data:'do_ban'},{text:'✅ Unban User',callback_data:'do_unban'}],
      [{text:'🔙 Back',callback_data:'adm_panel'}],
    ]}});
}
async function handleBanUser(chatId,userId,text) { const tid=text.trim(); db.banUser(tid); h.clearAdminState(userId); return send(chatId,`🚫 User <code>${tid}</code> banned.`,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel'}]]}}); }
async function handleUnbanUser(chatId,userId,text) { const tid=text.trim(); db.unbanUser(tid); h.clearAdminState(userId); return send(chatId,`✅ User <code>${tid}</code> unbanned.`,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel'}]]}}); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHOTO HANDLER — QR uploads
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('photo', async (msg) => {
  const chatId=msg.chat.id; const userId=String(msg.from.id);
  if (!isAuth(userId)) return;
  const state=h.getAdminState(userId);
  if (!state||state.state!=='awaiting_qr') return;
  const fileId=msg.photo[msg.photo.length-1].file_id;
  h.clearAdminState(userId);
  await handleQrUpload(chatId,userId,state.data.method,fileId);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CALLBACK ROUTER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('callback_query', async (q) => {
  if (isDupe(q.id)) return;
  const chatId=q.message.chat.id; const msgId=q.message.message_id;
  const userId=String(q.from.id); const data=q.data;
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  if (!isAuth(userId)) return;

  if (data==='adm_panel')        return showPanel(chatId,msgId,userId);
  if (data==='adm_join')         return showJoinMenu(chatId,msgId);
  if (data==='join_add')         { h.setAdminState(userId,'join_url',{}); return edit(chatId,msgId,`Enter the join URL:`); }
  if (data.startsWith('join_edit_'))   { const i=parseInt(data.replace('join_edit_','')); h.setAdminState(userId,'join_url',{index:i}); return edit(chatId,msgId,`Enter new URL for link #${i+1}:`); }
  if (data.startsWith('join_toggle_')) { const i=parseInt(data.replace('join_toggle_','')); const db_=db.getDb(); db_.settings.joinLinks[i].enabled=!db_.settings.joinLinks[i].enabled; db.saveDb(); return showJoinMenu(chatId,msgId); }
  if (data.startsWith('join_del_'))    { const i=parseInt(data.replace('join_del_','')); db.getDb().settings.joinLinks.splice(i,1); db.saveDb(); return showJoinMenu(chatId,msgId); }

  if (data==='adm_prods')        return showProds(chatId,msgId,false);
  if (data==='prods_acc')        return showProds(chatId,msgId,false);
  if (data==='prods_ses')        return showProds(chatId,msgId,true);
  if (data==='adm_add_prod')     return startAddProd(chatId,userId,false);
  if (data==='adm_add_ses')      return startAddProd(chatId,userId,true);
  if (data.startsWith('prod_edit_')) { const pid=data.replace('prod_edit_',''); _draft[userId]={...(db.getProduct(pid)||{})}; h.setAdminState(userId,'prod_name',{editId:pid}); return send(chatId,`Editing product.\nStep 1/5 — New name:`); }
  if (data.startsWith('prod_del_'))  { db.deleteProduct(data.replace('prod_del_','')); return edit(chatId,msgId,`🗑️ Deleted.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'adm_prods'}]]}}); }
  if (data.startsWith('prod_'))      return showProd(chatId,msgId,data.replace('prod_',''));

  if (data==='adm_dep_settings') return showDepSettings(chatId,msgId);
  if (data==='pay_gpay')         return showPayMethod(chatId,msgId,'gpay');
  if (data==='pay_fampay')       return showPayMethod(chatId,msgId,'fampay');
  if (data==='pay_anyupi')       return showPayMethod(chatId,msgId,'anyupi');
  if (data==='pay_binance')      return showPayMethod(chatId,msgId,'binance');
  if (data.startsWith('qr_'))    { const m=data.replace('qr_',''); h.setAdminState(userId,'awaiting_qr',{method:m}); return edit(chatId,msgId,`🖼️ Upload your new QR image now:`); }
  if (data.startsWith('uid_'))   { const m=data.replace('uid_',''); h.setAdminState(userId,'upi_id',{method:m}); return edit(chatId,msgId,`Enter new UPI ID:`); }
  if (data==='bid_binance')      { h.setAdminState(userId,'bin_id',{}); return edit(chatId,msgId,`Enter new Binance ID:`); }
  if (data.startsWith('pdel_'))  { const m=data.replace('pdel_',''); const db_=db.getDb(); Object.assign(db_.settings.payments[m],{qrFileId:null,qrFileIdAdmin:null,upiId:null,upiName:null,binanceId:null,binanceName:null}); db.saveDb(); return send(chatId,`🗑️ Cleared.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:`pay_${m}`}]]}}); }
  if (data.startsWith('ptog_'))  { const m=data.replace('ptog_',''); const db_=db.getDb(); db_.settings.payments[m].enabled=!db_.settings.payments[m].enabled; db.saveDb(); return showPayMethod(chatId,msgId,m); }

  if (data==='adm_pending_dep')  return showPendingDep(chatId,msgId);
  if (data.startsWith('dep_view_')) return showDepDetail(chatId,msgId,data.replace('dep_view_',''));
  if (data.startsWith('dep_ok_'))  return approveDeposit(chatId,msgId,data.replace('dep_ok_',''));
  if (data.startsWith('dep_no_'))  return rejectDeposit(chatId,msgId,data.replace('dep_no_',''));

  if (data==='adm_pending_ord')  return showPendingOrd(chatId,msgId);
  if (data.startsWith('ord_'))   return showOrdDetail(chatId,msgId,data.replace('ord_',''));
  if (data.startsWith('deliver_')) return deliverOrder(chatId,msgId,data.replace('deliver_',''));

  if (data==='adm_toggles')      return showToggles(chatId,msgId);
  if (data.startsWith('tog_'))   { const k=data.replace('tog_',''); const db_=db.getDb(); db_.settings.features[k]=!db_.settings.features[k]; db.saveDb(); return showToggles(chatId,msgId); }

  if (data==='adm_flash')        return showFlash(chatId,msgId);
  if (data==='flash_start')      { h.setAdminState(userId,'flash_prod',{}); return edit(chatId,msgId,`Enter the Product ID for flash sale:`); }
  if (data==='flash_stop')       { const db_=db.getDb(); if (db_.settings.flashSale.productId) db.updateProduct(db_.settings.flashSale.productId,{flashSale:false}); db_.settings.flashSale={active:false,productId:null,discountPercent:0,endsAt:null}; db.saveDb(); return edit(chatId,msgId,`🛑 Flash Sale stopped.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'adm_panel'}]]}}); }

  if (data==='adm_broadcast')    { h.setAdminState(userId,'broadcast',{}); return edit(chatId,msgId,`📢 Type your broadcast message:`,{reply_markup:{inline_keyboard:[[{text:'❌ Cancel',callback_data:'adm_panel'}]]}}); }
  if (data==='adm_support')      { h.setAdminState(userId,'support_user',{}); return edit(chatId,msgId,`Enter new support username (without @):`); }
  if (data==='adm_settings')     return showSettings(chatId,msgId);
  if (data==='set_rate')         { h.setAdminState(userId,'rate',{}); return edit(chatId,msgId,`Enter new USDT→₹ rate:`); }
  if (data==='set_min')          { h.setAdminState(userId,'min_dep',{}); return edit(chatId,msgId,`Enter new minimum deposit in ₹:`); }

  if (data==='adm_admins')       return showAdmins(chatId,msgId);
  if (data==='hire_admin')       { h.setAdminState(userId,'hire_admin',{}); return edit(chatId,msgId,`Send the Telegram user ID to hire:`); }
  if (data.startsWith('fire_'))  { db.removeAdmin(data.replace('fire_','')); return showAdmins(chatId,msgId); }

  // Admin → User message flow
  if (data.startsWith('msg_')) {
    const targetId = data.replace('msg_','');
    const user     = db.getUser(targetId);
    const name     = user.username ? '@'+user.username : (user.firstName || targetId);
    h.setAdminState(userId, 'msg_user', { targetUserId: targetId });
    return send(chatId,
      `✉️ <b>Message to ${name}</b>\n━━━━━━━━━━━━━━━━━━━━\nType your message below — it will be delivered via User Bot:`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_panel' }]] }}
    );
  }

  if (data==='adm_ban')          return showBanMenu(chatId,msgId);
  if (data==='do_ban')           { h.setAdminState(userId,'ban_user',{}); return edit(chatId,msgId,`Enter user ID to ban:`); }
  if (data==='do_unban')         { h.setAdminState(userId,'unban_user',{}); return edit(chatId,msgId,`Enter user ID to unban:`); }
});

console.log('⚙️ CLOUDE CART Admin Bot started...');
