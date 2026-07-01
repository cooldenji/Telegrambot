// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// db.js — CLOUDE CART 🛒 | JSON Database Layer
// Safe temp-file-then-rename writes (no data corruption)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');
const TMP_PATH = DB_PATH + '.tmp';

// ── Default structure ──────────────────────────────────
const DEFAULT_DB = {
  settings: {
    // Join gate URLs (admin can change)
    joinLinks: [
      { name: '📣 Join Channel',      url: 'https://t.me/yourchannel', enabled: true },
      { name: '📣 Join Stock Update', url: 'https://t.me/yourupdates',  enabled: true },
    ],
    supportUsername: 'yoursupport',   // admin can change
    usdtToInrRate: 90,                // 1 USDT = ₹90 (admin can change)
    minDepositInr: 20,                // minimum deposit

    // Payment methods toggle + QR/ID
    payments: {
      gpay: {
        enabled: true,
        qrFileId: null,       // User Bot valid file_id
        qrFileIdAdmin: null,  // Admin Bot valid file_id
        upiId: null,
        upiName: null,
      },
      fampay: {
        enabled: true,
        qrFileId: null,
        qrFileIdAdmin: null,
        upiId: null,
        upiName: null,
      },
      anyupi: {
        enabled: true,
        qrFileId: null,
        qrFileIdAdmin: null,
        upiId: null,
        upiName: null,
      },
      binance: {
        enabled: true,
        binanceId: null,
        binanceName: null,
        // Binance has no QR — only ID + Name
      },
    },

    // Feature toggles (admin can ON/OFF each)
    features: {
      buyAccount:  true,
      buySession:  true,
      deposit:     true,
      referEarn:   true,
      support:     true,
      leaderboard: true,
    },

    // Flash sale
    flashSale: {
      active: false,
      productId: null,
      discountPercent: 0,
      endsAt: null, // ISO timestamp
    },
  },

  // products[id] = { id, name, price, stock, description, emoji, sessionMode, flashSale }
  products: {},

  // users[userId] = { userId, username, firstName, balance, totalDeposited,
  //                   depositCount, referredBy, referralCount, referralEarned,
  //                   joinedAt, notifyProducts[] }
  users: {},

  // deposits[id] = { id, userId, amount, method, subMethod,
  //                  screenshotFileId, screenshotFileIdAdmin,
  //                  status, createdAt, approvedAt }
  deposits: {},

  // orders[id] = { id, userId, productId, quantity, totalPrice,
  //                status, createdAt }
  orders: {},

  // admins[userId] = { userId, addedAt, addedBy }
  admins: {},

  // referrals[id] = { id, referrerId, referredId, status, rewardAmount, createdAt }
  referrals: {},

  // notifyQueue[productId] = [userId, userId, ...]
  notifyQueue: {},

  // bans[userId] = true
  bans: {},

  _nextId: 1,
};

// ── Load / Save ────────────────────────────────────────
let _db = null;

function loadDb() {
  if (_db) return _db;
  if (fs.existsSync(DB_PATH)) {
    try {
      _db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      // Merge any missing keys from DEFAULT_DB (forward compat)
      _db = deepMerge(DEFAULT_DB, _db);
    } catch (e) {
      console.error('[DB] Corrupt data.json, resetting:', e.message);
      _db = JSON.parse(JSON.stringify(DEFAULT_DB));
    }
  } else {
    _db = JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  return _db;
}

function saveDb() {
  const json = JSON.stringify(_db, null, 2);
  fs.writeFileSync(TMP_PATH, json, 'utf8');
  fs.renameSync(TMP_PATH, DB_PATH);
}

function getDb() {
  if (!_db) loadDb();
  return _db;
}

// Deep merge (target keys win over source)
function deepMerge(source, target) {
  const out = Object.assign({}, source);
  for (const key of Object.keys(target)) {
    if (target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      out[key] = deepMerge(source[key] || {}, target[key]);
    } else {
      out[key] = target[key];
    }
  }
  return out;
}

// ── ID generator ───────────────────────────────────────
function nextId() {
  const db = getDb();
  const id = String(db._nextId++);
  saveDb();
  return id;
}

// ── USER helpers ───────────────────────────────────────
function getUser(userId) {
  const db = getDb();
  const id = String(userId);
  if (!db.users[id]) {
    db.users[id] = {
      userId: id, username: null, firstName: null,
      balance: 0, totalDeposited: 0, depositCount: 0,
      referredBy: null, referralCount: 0, referralEarned: 0,
      joinedAt: Date.now(), notifyProducts: [],
    };
    saveDb();
  }
  return db.users[id];
}

function updateUser(userId, patch) {
  const db = getDb();
  const id = String(userId);
  getUser(id); // ensure exists
  Object.assign(db.users[id], patch);
  saveDb();
}

function isBanned(userId) {
  return !!getDb().bans[String(userId)];
}

// ── PRODUCT helpers ────────────────────────────────────
function addProduct(data) {
  const db = getDb();
  const id = nextId();
  db.products[id] = { id, ...data, createdAt: Date.now() };
  saveDb();
  return db.products[id];
}

function getProduct(id) {
  return getDb().products[String(id)] || null;
}

function updateProduct(id, patch) {
  const db = getDb();
  if (!db.products[String(id)]) return false;
  Object.assign(db.products[String(id)], patch);
  saveDb();
  return true;
}

function deleteProduct(id) {
  const db = getDb();
  delete db.products[String(id)];
  saveDb();
}

function listProducts(sessionMode = false) {
  const db = getDb();
  return Object.values(db.products).filter(p => p.sessionMode === sessionMode);
}

// ── DEPOSIT helpers ────────────────────────────────────
function createDeposit(data) {
  const db = getDb();
  const id = nextId();
  db.deposits[id] = { id, status: 'pending', createdAt: Date.now(), ...data };
  saveDb();
  return db.deposits[id];
}

function getDeposit(id) {
  return getDb().deposits[String(id)] || null;
}

function updateDeposit(id, patch) {
  const db = getDb();
  if (!db.deposits[String(id)]) return false;
  Object.assign(db.deposits[String(id)], patch);
  saveDb();
  return true;
}

function getPendingDeposits() {
  return Object.values(getDb().deposits).filter(d => d.status === 'pending');
}

// ── ORDER helpers ──────────────────────────────────────
function createOrder(data) {
  const db = getDb();
  const id = nextId();
  db.orders[id] = { id, status: 'pending_approval', createdAt: Date.now(), ...data };
  saveDb();
  return db.orders[id];
}

function getOrder(id) {
  return getDb().orders[String(id)] || null;
}

function updateOrder(id, patch) {
  const db = getDb();
  if (!db.orders[String(id)]) return false;
  Object.assign(db.orders[String(id)], patch);
  saveDb();
  return true;
}

function getPendingOrders() {
  return Object.values(getDb().orders).filter(o => o.status === 'pending_approval');
}

// ── REFERRAL helpers ───────────────────────────────────
function createReferral(referrerId, referredId, rewardAmount) {
  const db = getDb();
  const id = nextId();
  db.referrals[id] = {
    id, referrerId: String(referrerId), referredId: String(referredId),
    status: 'pending', rewardAmount, createdAt: Date.now(),
  };
  saveDb();
  return db.referrals[id];
}

function completeReferral(referredId) {
  const db = getDb();
  const ref = Object.values(db.referrals).find(
    r => r.referredId === String(referredId) && r.status === 'pending'
  );
  if (!ref) return null;
  ref.status = 'completed';
  ref.completedAt = Date.now();
  // credit referrer
  const referrer = getUser(ref.referrerId);
  referrer.balance       += ref.rewardAmount;
  referrer.referralCount += 1;
  referrer.referralEarned += ref.rewardAmount;
  saveDb();
  return ref;
}

function hasBeenReferred(referredId) {
  return Object.values(getDb().referrals).some(
    r => r.referredId === String(referredId)
  );
}

// ── LEADERBOARD helpers ────────────────────────────────
function getDepositLeaderboard(limit = 20) {
  return Object.values(getDb().users)
    .sort((a, b) => b.totalDeposited - a.totalDeposited)
    .slice(0, limit);
}

function getReferralLeaderboard(limit = 20) {
  return Object.values(getDb().users)
    .sort((a, b) => b.referralCount - a.referralCount)
    .slice(0, limit);
}

// ── ADMIN helpers ──────────────────────────────────────
function isAdmin(userId) {
  const db = getDb();
  return !!db.admins[String(userId)];
}

function addAdmin(userId, addedBy) {
  const db = getDb();
  db.admins[String(userId)] = { userId: String(userId), addedAt: Date.now(), addedBy: String(addedBy) };
  saveDb();
}

function removeAdmin(userId) {
  const db = getDb();
  delete db.admins[String(userId)];
  saveDb();
}

function listAdmins() {
  return Object.values(getDb().admins);
}

// ── NOTIFY QUEUE helpers ───────────────────────────────
function addNotifyQueue(productId, userId) {
  const db = getDb();
  const id = String(productId);
  if (!db.notifyQueue[id]) db.notifyQueue[id] = [];
  if (!db.notifyQueue[id].includes(String(userId))) {
    db.notifyQueue[id].push(String(userId));
    saveDb();
  }
}

function getNotifyQueue(productId) {
  return getDb().notifyQueue[String(productId)] || [];
}

function clearNotifyQueue(productId) {
  const db = getDb();
  db.notifyQueue[String(productId)] = [];
  saveDb();
}

module.exports = {
  getDb, saveDb, loadDb,
  nextId,
  getUser, updateUser, isBanned,
  addProduct, getProduct, updateProduct, deleteProduct, listProducts,
  createDeposit, getDeposit, updateDeposit, getPendingDeposits,
  createOrder, getOrder, updateOrder, getPendingOrders,
  createReferral, completeReferral, hasBeenReferred,
  getDepositLeaderboard, getReferralLeaderboard,
  isAdmin, addAdmin, removeAdmin, listAdmins,
  addNotifyQueue, getNotifyQueue, clearNotifyQueue,
};
