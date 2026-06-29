// db.js — shared database (file-based JSON)
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

const FILES = {
  products : path.join(DATA_DIR, 'products.json'),
  users    : path.join(DATA_DIR, 'users.json'),
  deposits : path.join(DATA_DIR, 'deposits.json'),
  orders   : path.join(DATA_DIR, 'orders.json'),
  settings : path.join(DATA_DIR, 'settings.json'),
  admins   : path.join(DATA_DIR, 'admins.json'),
  bans     : path.join(DATA_DIR, 'bans.json'),
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureFile(filePath, defaultData) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
}

function initDB() {
  ensureFile(FILES.products, []);
  ensureFile(FILES.users, {});
  ensureFile(FILES.deposits, {});
  ensureFile(FILES.orders, {});
  ensureFile(FILES.bans, {});
  ensureFile(FILES.admins, { owners: [], hiredAdmins: [] });
  ensureFile(FILES.settings, {
    upiId              : 'yourupi@bank',
    upiQrFileId        : '',
    upiEnabled         : true,
    binancePayId       : '',
    binanceAccountName : '',
    binanceQrFileId    : '',
    binanceEnabled     : true,
    channelUrl         : 'https://t.me/USERADMINX',
    groupUrl           : 'https://t.me/USERADMINXGC',
    botUsername        : 'YourBot_bot',
    supportUsername    : 'YourSupportUsername',
    supportUserId      : '8207010933',
    minDeposit         : 20,
    usdtRate           : 90.0,
    referralRewardUsd  : 0.01,
    referralRewardInr  : 1,
    qrValidityMinutes  : 15,
    displayCurrency    : 'inr',   // 'inr' | 'usd'  — toggle in admin
    referralEnabled    : true,
    qrEnabled          : true,
  });
}

function readJSON(f) {
  ensureDataDir();
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; }
}

function writeJSON(f, data) {
  ensureDataDir();
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
}

// ── Products ──────────────────────────────────────────────────
function getProducts()           { return readJSON(FILES.products) || []; }
function saveProducts(p)         { writeJSON(FILES.products, p); }
function addProduct(product) {
  const products = getProducts();
  const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const np = {
    id, name: product.name, emoji: product.emoji || '📦',
    category: product.category || 'General',
    priceUsd: Number(product.priceUsd) || 0,
    priceInr: Number(product.priceInr) || 0,
    stock: Number(product.stock) || 0,
    description: product.description || '',
    deliveryType: product.deliveryType || 'manual',
    deliveryFileId: product.deliveryFileId || '',
    deliveryText: product.deliveryText || '',
    active: true, createdAt: Date.now(), sold: 0,
  };
  products.push(np); saveProducts(products); return np;
}
function getProductById(id)      { return getProducts().find(p => p.id === id); }
function updateProduct(id, u)    {
  const products = getProducts();
  const i = products.findIndex(p => p.id === id);
  if (i === -1) return null;
  products[i] = { ...products[i], ...u };
  saveProducts(products); return products[i];
}
function deleteProduct(id)       { saveProducts(getProducts().filter(p => p.id !== id)); }
function decrementStock(id, qty=1) {
  const products = getProducts();
  const i = products.findIndex(p => p.id === id);
  if (i === -1) return null;
  products[i].stock = Math.max(0, products[i].stock - qty);
  products[i].sold  = (products[i].sold || 0) + qty;
  saveProducts(products); return products[i];
}

// ── Users ─────────────────────────────────────────────────────
function getUsers()  { return readJSON(FILES.users) || {}; }
function saveUsers(u){ writeJSON(FILES.users, u); }
function getUser(userId) {
  return getUsers()[String(userId)] || null;
}
function createUserIfNotExists(userId, profile={}) {
  const users = getUsers(); const key = String(userId);
  if (!users[key]) {
    users[key] = {
      id: userId, username: profile.username||'', firstName: profile.firstName||'',
      joinedAt: Date.now(), balanceUsd:0, balanceInr:0,
      depositedUsd:0, depositedInr:0, spentUsd:0, spentInr:0, purchases:0,
      referredBy: profile.referredBy||null, referrals:0,
      referralEarnedUsd:0, referralEarnedInr:0,
      referralsToday:0, referralsThisWeek:0,
      lastReferralDay:null, lastReferralWeek:null,
      acceptedTerms:false, joinedChannel:false, joinedGroup:false,
      state:null, stateData:{},
    };
    saveUsers(users);
  }
  return users[key];
}
function updateUser(userId, updates) {
  const users = getUsers(); const key = String(userId);
  if (!users[key]) return null;
  users[key] = { ...users[key], ...updates };
  saveUsers(users); return users[key];
}
function setUserState(userId, state, stateData={}) { return updateUser(userId, { state, stateData }); }
function clearUserState(userId)                     { return updateUser(userId, { state:null, stateData:{} }); }
function addBalance(userId, usd, inr) {
  const user = getUser(userId); if (!user) return null;
  return updateUser(userId, { balanceUsd: round2(user.balanceUsd+usd), balanceInr: Math.round(user.balanceInr+inr) });
}
function deductBalance(userId, usd, inr) {
  const user = getUser(userId); if (!user) return null;
  return updateUser(userId, {
    balanceUsd: round2(Math.max(0, user.balanceUsd-usd)),
    balanceInr: Math.round(Math.max(0, user.balanceInr-inr)),
  });
}

// ── Deposits ──────────────────────────────────────────────────
function getDeposits()      { return readJSON(FILES.deposits) || {}; }
function saveDeposits(d)    { writeJSON(FILES.deposits, d); }
function createDeposit(dep) {
  const deposits = getDeposits();
  const id = 'dep-' + dep.userId + '-' + Date.now();
  deposits[id] = {
    id, userId:dep.userId, username:dep.username||'', method:dep.method,
    amountInr:dep.amountInr||0, amountUsd:dep.amountUsd||0,
    screenshotFileId:'', status:'pending',
    createdAt:Date.now(), decidedAt:null, decidedBy:null,
    prevBalanceUsd:dep.prevBalanceUsd||0, prevBalanceInr:dep.prevBalanceInr||0,
  };
  saveDeposits(deposits); return deposits[id];
}
function getDeposit(id)         { return getDeposits()[id] || null; }
function updateDeposit(id, u)   {
  const deposits = getDeposits();
  if (!deposits[id]) return null;
  deposits[id] = { ...deposits[id], ...u };
  saveDeposits(deposits); return deposits[id];
}
function getPendingDeposits()   { return Object.values(getDeposits()).filter(d => d.status==='pending'); }

// ── Orders ────────────────────────────────────────────────────
function getOrders()       { return readJSON(FILES.orders) || {}; }
function saveOrders(o)     { writeJSON(FILES.orders, o); }
function createOrder(ord)  {
  const orders = getOrders();
  const id = 'ord-' + ord.userId + '-' + Date.now();
  orders[id] = {
    id, userId:ord.userId, username:ord.username||'',
    productId:ord.productId, productName:ord.productName,
    qty:ord.qty||1, amountUsd:ord.amountUsd||0, amountInr:ord.amountInr||0,
    status:ord.status||'completed', createdAt:Date.now(),
  };
  saveOrders(orders); return orders[id];
}
function updateOrder(orderId, u) {
  const orders = getOrders();
  if (orders[orderId]) { orders[orderId] = { ...orders[orderId], ...u }; saveOrders(orders); }
  return orders[orderId];
}

// ── Settings ──────────────────────────────────────────────────
function getSettings()          { return readJSON(FILES.settings) || {}; }
function updateSettings(u)      {
  const s = getSettings(); const merged = { ...s, ...u };
  writeJSON(FILES.settings, merged); return merged;
}

// ── Admins ────────────────────────────────────────────────────
function getAdminData()        { return readJSON(FILES.admins) || { owners:[], hiredAdmins:[] }; }
function saveAdminData(d)      { writeJSON(FILES.admins, d); }
function isOwner(userId)       { return getAdminData().owners.includes(Number(userId)); }
function ensureOwner(userId)   {
  const d = getAdminData();
  if (!d.owners.includes(Number(userId))) { d.owners.push(Number(userId)); saveAdminData(d); }
}
function isHiredAdmin(userId)  { return getAdminData().hiredAdmins.some(a => a.id===Number(userId)); }
function isAdminOrOwner(userId){ return isOwner(userId) || isHiredAdmin(userId); }
function addHiredAdmin(id, username, addedBy) {
  const d = getAdminData();
  if (!d.hiredAdmins.some(a => a.id===Number(id)))
    d.hiredAdmins.push({ id:Number(id), username:username||'', addedBy, addedAt:Date.now() });
  saveAdminData(d); return d;
}
function removeHiredAdmin(id)  {
  const d = getAdminData(); d.hiredAdmins = d.hiredAdmins.filter(a => a.id!==Number(id));
  saveAdminData(d); return d;
}
function listHiredAdmins()     { return getAdminData().hiredAdmins; }

// ── Bans ──────────────────────────────────────────────────────
function getBans()             { return readJSON(FILES.bans) || {}; }
function saveBans(b)           { writeJSON(FILES.bans, b); }
function banUser(userId, reason, by) {
  const bans = getBans();
  bans[String(userId)] = { banned:true, reason:reason||'Violation', by, at:Date.now() };
  saveBans(bans);
}
function unbanUser(userId)     { const bans=getBans(); delete bans[String(userId)]; saveBans(bans); }
function isBanned(userId)      { const bans=getBans(); return !!(bans[String(userId)]?.banned); }

function round2(n) { return Math.round(n*100)/100; }

module.exports = {
  initDB,
  getProducts, saveProducts, addProduct, getProductById, updateProduct, deleteProduct, decrementStock,
  getUsers, saveUsers, getUser, createUserIfNotExists, updateUser, setUserState, clearUserState, addBalance, deductBalance,
  getDeposits, createDeposit, getDeposit, updateDeposit, getPendingDeposits,
  getOrders, createOrder, updateOrder,
  getBans,
  getSettings, updateSettings,
  isOwner, ensureOwner, isHiredAdmin, isAdminOrOwner, addHiredAdmin, removeHiredAdmin, listHiredAdmins,
  banUser, unbanUser, isBanned,
  round2,
};
