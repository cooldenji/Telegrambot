// db.js — simple JSON-file data layer shared by both bots.
// Uses synchronous fs calls on purpose: this bot's traffic is small
// enough that sync I/O is simpler and safer than dealing with partial
// writes from concurrent async access to the same file.

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  products: path.join(DATA_DIR, 'products.json'),
  users:    path.join(DATA_DIR, 'users.json'),
  deposits: path.join(DATA_DIR, 'deposits.json'),
  orders:   path.join(DATA_DIR, 'orders.json'),
  bans:     path.join(DATA_DIR, 'bans.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  admins:   path.join(DATA_DIR, 'admins.json'),
};

function ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJson(filePath, data) {
  // Write to a temp file then rename — avoids a half-written file if the
  // process crashes mid-write.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ── Init ─────────────────────────────────────────────────────────
function initDB() {
  ensureFile(FILES.products, []);
  ensureFile(FILES.users, {});
  ensureFile(FILES.deposits, {});
  ensureFile(FILES.orders, {});
  ensureFile(FILES.bans, {});
  ensureFile(FILES.admins, { owners: [], hiredAdmins: [] });

  const defaultSettings = {
    // ── Payment methods: each has a QR (User-Bot-valid file_id) +
    // an admin-side preview copy + a numeric/text ID. All independently
    // changeable from the admin panel.
    upi: { qrFileId: '', qrFileIdAdmin: '', payId: 'yourupi@bank', enabled: true },
    binance: { qrFileId: '', qrFileIdAdmin: '', payId: '', accountName: '', enabled: true },
    fampay: { qrFileId: '', qrFileIdAdmin: '', payId: '', enabled: true },

    usdtRate: 90,              // 1 USDT/$ = ₹90 — used for ALL ₹↔$ conversion
    minDepositInr: 20,
    qrValidityMinutes: 15,

    // ── Join verification (mandatory) ───────────────────────────
    channelUrl: 'https://t.me/sellingherehsj',
    channelChatId: '@sellingherehsj', // used for the real getChatMember check
    groupUrl: 'https://t.me/maihwhwuw',
    groupChatId: '@maihwhwuw',

    botUsername: 'YourBot_bot',
    supportUsername: '',
    supportUserId: '',
    supportHistory: [],

    // ── Referral system ──────────────────────────────────────────
    referralEnabled: true,
    referralRewardInr: 10,     // admin-fixed ₹ amount credited per successful referral

    createdAt: Date.now(),
  };

  // First run ever — file doesn't exist yet, create it fresh.
  ensureFile(FILES.settings, defaultSettings);

  // ── Self-heal pass ────────────────────────────────────────────
  // If settings.json ALREADY existed (e.g. from an earlier run before
  // CHANNEL_CHAT_ID/GROUP_CHAT_ID were configured), any field that is
  // missing OR an empty string gets backfilled from the default above.
  // This runs on every startup — it's what fixes a stale settings.json
  // without anyone having to manually edit the JSON file.
  const current = readJson(FILES.settings) || {};
  let needsRepair = false;
  const repaired = { ...current };
  for (const key of ['channelUrl', 'channelChatId', 'groupUrl', 'groupChatId']) {
    if (!repaired[key]) {
      repaired[key] = defaultSettings[key];
      needsRepair = true;
    }
  }
  if (needsRepair) {
    writeJson(FILES.settings, repaired);
    console.log('🔧 settings.json had missing join-verification fields — auto-repaired from defaults.');
  }
}

// ── Generic settings ─────────────────────────────────────────────
function getSettings() {
  return readJson(FILES.settings) || {};
}
function updateSettings(patch) {
  const s = getSettings();
  const merged = { ...s, ...patch };
  writeJson(FILES.settings, merged);
  return merged;
}
// Deep-merge for nested objects like settings.upi / settings.binance
function updatePaymentMethod(method, patch) {
  const s = getSettings();
  s[method] = { ...(s[method] || {}), ...patch };
  writeJson(FILES.settings, s);
  return s[method];
}

// ── Products ───────────────────────────────────────────────────
function getProducts() { return readJson(FILES.products) || []; }
function saveProducts(list) { writeJson(FILES.products, list); }

function addProduct(p) {
  const list = getProducts();
  const product = {
    id: 'p' + Date.now(),
    name: p.name,
    emoji: p.emoji || '📦',
    category: p.category || 'General',
    priceInr: Number(p.priceInr) || 0, // ✅ admin always enters ₹ only — $ is derived
    stock: Number(p.stock) || 0,
    sold: 0,
    active: true,
    description: p.description || '',
    createdAt: Date.now(),
  };
  list.push(product);
  saveProducts(list);
  return product;
}

function getProductById(id) { return getProducts().find(p => p.id === id) || null; }

function updateProduct(id, patch) {
  const list = getProducts();
  const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  saveProducts(list);
  return list[idx];
}

function deleteProduct(id) {
  const list = getProducts().filter(p => p.id !== id);
  saveProducts(list);
}

function decrementStock(id, qty = 1) {
  const list = getProducts();
  const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return null;
  list[idx].stock = Math.max(0, list[idx].stock - qty);
  list[idx].sold  = (list[idx].sold || 0) + qty;
  saveProducts(list);
  return list[idx];
}

// ── Users ──────────────────────────────────────────────────────
function getUsers() { return readJson(FILES.users) || {}; }
function saveUsers(obj) { writeJson(FILES.users, obj); }

function getUser(userId) {
  const users = getUsers();
  return users[String(userId)] || null;
}

function createUserIfNotExists(userId, profile = {}) {
  const users = getUsers();
  const key = String(userId);
  if (!users[key]) {
    users[key] = {
      id: Number(userId),
      username: profile.username || '',
      firstName: profile.firstName || '',
      joinedAt: Date.now(),

      balanceInr: 0,

      acceptedTerms: false,
      joinedChannel: false,
      joinedGroup: false,

      referredBy: profile.referredBy || null,
      referralCredited: false,
      referralClicks: 0,
      referrals: 0,            // confirmed (joined + accepted) referrals
      referralEarnedInr: 0,

      purchases: 0,
      banned: false,

      state: null,
      stateData: {},
    };
    saveUsers(users);
  }
  return users[key];
}

function updateUser(userId, patch) {
  const users = getUsers();
  const key = String(userId);
  if (!users[key]) return null;
  users[key] = { ...users[key], ...patch };
  saveUsers(users);
  return users[key];
}

function setUserState(userId, state, stateData = {}) {
  return updateUser(userId, { state, stateData });
}
function clearUserState(userId) {
  return updateUser(userId, { state: null, stateData: {} });
}

function addBalance(userId, amountInr) {
  const user = getUser(userId);
  if (!user) return null;
  return updateUser(userId, { balanceInr: round2(user.balanceInr + amountInr) });
}
function deductBalance(userId, amountInr) {
  const user = getUser(userId);
  if (!user) return null;
  return updateUser(userId, { balanceInr: round2(Math.max(0, user.balanceInr - amountInr)) });
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── Referral helpers ─────────────────────────────────────────────
function incrementReferralClick(referrerId) {
  const user = getUser(referrerId);
  if (!user) return;
  updateUser(referrerId, { referralClicks: (user.referralClicks || 0) + 1 });
}

function creditReferral(referrerId, newUserId, rewardInr) {
  const referrer = getUser(referrerId);
  if (!referrer) return null;
  updateUser(referrerId, {
    referrals: (referrer.referrals || 0) + 1,
    referralEarnedInr: round2((referrer.referralEarnedInr || 0) + rewardInr),
  });
  addBalance(referrerId, rewardInr);
  return getUser(referrerId);
}

function getReferralLeaderboard(limit = 10) {
  const users = Object.values(getUsers());
  return users
    .filter(u => (u.referrals || 0) > 0)
    .sort((a, b) => (b.referrals || 0) - (a.referrals || 0))
    .slice(0, limit);
}

// ── Deposits ───────────────────────────────────────────────────
function getDeposits() { return readJson(FILES.deposits) || {}; }
function saveDeposits(obj) { writeJson(FILES.deposits, obj); }

function createDeposit(data) {
  const deposits = getDeposits();
  const id = 'dep-' + data.userId + '-' + Date.now();
  const deposit = {
    id,
    userId: data.userId,
    username: data.username || '',
    method: data.method,        // 'upi' | 'binance' | 'fampay'
    amountInr: data.amountInr,
    prevBalanceInr: data.prevBalanceInr,
    screenshotFileId: '',       // user-bot-valid file_id (for reference)
    screenshotFileIdAdmin: '',  // admin-bot-valid file_id (auto-set after relay)
    status: 'pending',          // pending | approved | rejected
    createdAt: Date.now(),
  };
  deposits[id] = deposit;
  saveDeposits(deposits);
  return deposit;
}

function getDeposit(id) { return getDeposits()[id] || null; }
function updateDeposit(id, patch) {
  const deposits = getDeposits();
  if (!deposits[id]) return null;
  deposits[id] = { ...deposits[id], ...patch };
  saveDeposits(deposits);
  return deposits[id];
}
function getPendingDeposits() {
  return Object.values(getDeposits()).filter(d => d.status === 'pending');
}

// ── Orders ───────────────────────────────────────────────────────
function getOrders() { return readJson(FILES.orders) || {}; }
function saveOrders(obj) { writeJson(FILES.orders, obj); }

function createOrder(data) {
  const orders = getOrders();
  const id = 'ord-' + data.userId + '-' + Date.now();
  const order = {
    id,
    userId: data.userId,
    username: data.username || '',
    productId: data.productId,
    productName: data.productName,
    qty: data.qty,
    amountInr: data.amountInr,
    status: 'pending_delivery', // pending_delivery | delivered | rejected
    createdAt: Date.now(),
  };
  orders[id] = order;
  saveOrders(orders);
  return order;
}
function getOrder(id) { return getOrders()[id] || null; }
function updateOrder(id, patch) {
  const orders = getOrders();
  if (!orders[id]) return null;
  orders[id] = { ...orders[id], ...patch };
  saveOrders(orders);
  return orders[id];
}

// ── Bans ───────────────────────────────────────────────────────
function getBans() { return readJson(FILES.bans) || {}; }
function banUser(userId, reason = '') {
  const bans = getBans();
  bans[String(userId)] = { reason, bannedAt: Date.now() };
  writeJson(FILES.bans, bans);
  updateUser(userId, { banned: true });
}
function unbanUser(userId) {
  const bans = getBans();
  delete bans[String(userId)];
  writeJson(FILES.bans, bans);
  updateUser(userId, { banned: false });
}
function isBanned(userId) {
  return !!getBans()[String(userId)];
}

// ── Admins / Ownership ───────────────────────────────────────────
function getAdminData() { return readJson(FILES.admins) || { owners: [], hiredAdmins: [] }; }
function saveAdminData(d) { writeJson(FILES.admins, d); }

function isOwner(userId) { return getAdminData().owners.includes(Number(userId)); }
function ensureOwner(userId) {
  const d = getAdminData();
  if (!d.owners.includes(Number(userId))) { d.owners.push(Number(userId)); saveAdminData(d); }
}

function isHiredAdmin(userId) {
  return getAdminData().hiredAdmins.some(a => a.id === Number(userId));
}
function isAdminOrOwner(userId) {
  return isOwner(userId) || isHiredAdmin(userId);
}
function addHiredAdmin(userId, username, addedBy) {
  const d = getAdminData();
  if (!d.hiredAdmins.some(a => a.id === Number(userId))) {
    d.hiredAdmins.push({ id: Number(userId), username: username || '', addedBy, addedAt: Date.now() });
    saveAdminData(d);
  }
  return d.hiredAdmins;
}
function removeHiredAdmin(userId) {
  const d = getAdminData();
  d.hiredAdmins = d.hiredAdmins.filter(a => a.id !== Number(userId));
  saveAdminData(d);
  return d.hiredAdmins;
}
function listHiredAdmins() { return getAdminData().hiredAdmins; }

function transferOwnership(newOwnerId) {
  const d = getAdminData();
  d.owners = [Number(newOwnerId)];
  saveAdminData(d);
  return d;
}

function resolveUserIdByUsername(username) {
  const clean = String(username).replace(/^@/, '').toLowerCase();
  const users = Object.values(getUsers());
  const found = users.find(u => (u.username || '').toLowerCase() === clean);
  if (found) return found.id;
  const admins = getAdminData();
  const adminMatch = admins.hiredAdmins.find(a => (a.username || '').toLowerCase() === clean);
  return adminMatch ? adminMatch.id : null;
}

function setSupportContact(username, userId, changedBy) {
  const s = getSettings();
  const history = Array.isArray(s.supportHistory) ? s.supportHistory : [];
  history.unshift({ username: username || '', userId: userId || '', changedBy, at: Date.now() });
  updateSettings({
    supportUsername: username || s.supportUsername,
    supportUserId: userId || s.supportUserId,
    supportHistory: history.slice(0, 10),
  });
}

module.exports = {
  initDB,
  getSettings, updateSettings, updatePaymentMethod,

  getProducts, saveProducts, addProduct, getProductById, updateProduct, deleteProduct, decrementStock,

  getUsers, saveUsers, getUser, createUserIfNotExists, updateUser,
  setUserState, clearUserState, addBalance, deductBalance,

  incrementReferralClick, creditReferral, getReferralLeaderboard,

  getDeposits, createDeposit, getDeposit, updateDeposit, getPendingDeposits,

  getOrders, createOrder, getOrder, updateOrder,

  getBans, banUser, unbanUser, isBanned,

  isOwner, ensureOwner, isHiredAdmin, isAdminOrOwner,
  addHiredAdmin, removeHiredAdmin, listHiredAdmins,
  transferOwnership, resolveUserIdByUsername, setSupportContact,

  round2,
};
