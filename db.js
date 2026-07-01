const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

// Make sure the folder for the database file exists
const dbDir = path.dirname(config.databasePath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  balance_inr REAL NOT NULL DEFAULT 0,
  deposit_count INTEGER NOT NULL DEFAULT 0,
  total_deposited_inr REAL NOT NULL DEFAULT 0,
  referred_by TEXT,
  is_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT DEFAULT '📦',
  price_inr REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  description TEXT DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount_inr REAL NOT NULL,
  method TEXT NOT NULL,
  screenshot_file_id TEXT,
  screenshot_file_id_admin TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  price_inr REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id TEXT NOT NULL,
  referred_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  user_id TEXT PRIMARY KEY,
  added_by TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feature_toggles (
  feature_key TEXT PRIMARY KEY,
  is_enabled INTEGER NOT NULL DEFAULT 1
);
`);

// ---------- settings helpers ----------
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

// ---------- user helpers ----------
function upsertUser(userId, username) {
  db.prepare(
    `INSERT INTO users (user_id, username) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET username = excluded.username`
  ).run(String(userId), username || null);
  return getUser(userId);
}

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(String(userId));
}

function setUserVerified(userId) {
  db.prepare('UPDATE users SET is_verified = 1 WHERE user_id = ?').run(String(userId));
}

function addUserBalance(userId, amountInr) {
  db.prepare('UPDATE users SET balance_inr = balance_inr + ? WHERE user_id = ?').run(
    amountInr,
    String(userId)
  );
}

function deductUserBalance(userId, amountInr) {
  db.prepare('UPDATE users SET balance_inr = balance_inr - ? WHERE user_id = ?').run(
    amountInr,
    String(userId)
  );
}

function recordDepositOnUser(userId, amountInr) {
  db.prepare(
    `UPDATE users
     SET balance_inr = balance_inr + ?,
         deposit_count = deposit_count + 1,
         total_deposited_inr = total_deposited_inr + ?
     WHERE user_id = ?`
  ).run(amountInr, amountInr, String(userId));
}

// ---------- product helpers ----------
function addProduct({ name, emoji, priceInr, stock, description }) {
  const info = db
    .prepare(
      `INSERT INTO products (name, emoji, price_inr, stock, description)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(name, emoji || '📦', priceInr, stock, description || '');
  return info.lastInsertRowid;
}

function listActiveProducts() {
  return db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY id ASC').all();
}

function listAllProducts() {
  return db.prepare('SELECT * FROM products ORDER BY id ASC').all();
}

function getProduct(id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

function updateProduct(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  db.prepare(`UPDATE products SET ${setClause} WHERE id = ?`).run(...values, id);
}

function deleteProduct(id) {
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
}

function decrementStock(id, qty = 1) {
  db.prepare('UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ?').run(qty, id);
}

// ---------- deposit helpers ----------
function createDeposit({ userId, amountInr, method, screenshotFileId }) {
  const info = db
    .prepare(
      `INSERT INTO deposits (user_id, amount_inr, method, screenshot_file_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(String(userId), amountInr, method, screenshotFileId || null);
  return info.lastInsertRowid;
}

function getDeposit(id) {
  return db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
}

function setDepositAdminFileId(id, adminFileId) {
  db.prepare('UPDATE deposits SET screenshot_file_id_admin = ? WHERE id = ?').run(
    adminFileId,
    id
  );
}

function decideDeposit(id, status) {
  db.prepare(
    `UPDATE deposits SET status = ?, decided_at = datetime('now') WHERE id = ?`
  ).run(status, id);
}

// ---------- order helpers ----------
function createOrder({ userId, productId, priceInr }) {
  const info = db
    .prepare(
      `INSERT INTO orders (user_id, product_id, price_inr) VALUES (?, ?, ?)`
    )
    .run(String(userId), productId, priceInr);
  return info.lastInsertRowid;
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

function decideOrder(id, status) {
  db.prepare(
    `UPDATE orders SET status = ?, decided_at = datetime('now') WHERE id = ?`
  ).run(status, id);
}

// ---------- referral helpers ----------
function createPendingReferral(referrerId, referredId) {
  try {
    db.prepare(
      `INSERT INTO referrals (referrer_id, referred_id, status) VALUES (?, ?, 'pending')`
    ).run(String(referrerId), String(referredId));
    return true;
  } catch (err) {
    // UNIQUE constraint = already referred before
    return false;
  }
}

function getPendingReferralByReferredId(referredId) {
  return db
    .prepare(
      `SELECT * FROM referrals WHERE referred_id = ? AND status = 'pending'`
    )
    .get(String(referredId));
}

function completeReferral(referredId) {
  db.prepare(
    `UPDATE referrals SET status = 'completed' WHERE referred_id = ?`
  ).run(String(referredId));
}

function countCompletedReferrals(referrerId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM referrals WHERE referrer_id = ? AND status = 'completed'`
    )
    .get(String(referrerId));
  return row.cnt;
}

// ---------- leaderboard helpers ----------
function topDepositors(limit = 10) {
  return db
    .prepare(
      `SELECT user_id, username, total_deposited_inr
       FROM users ORDER BY total_deposited_inr DESC LIMIT ?`
    )
    .all(limit);
}

function topReferrers(limit = 10) {
  return db
    .prepare(
      `SELECT referrer_id AS user_id, COUNT(*) AS referral_count
       FROM referrals WHERE status = 'completed'
       GROUP BY referrer_id ORDER BY referral_count DESC LIMIT ?`
    )
    .all(limit);
}

// ---------- admin helpers ----------
function addAdmin(userId, addedBy) {
  db.prepare(
    `INSERT INTO admins (user_id, added_by) VALUES (?, ?)
     ON CONFLICT(user_id) DO NOTHING`
  ).run(String(userId), String(addedBy));
}

function isAdmin(userId) {
  if (String(userId) === String(config.ownerId)) return true;
  if (config.adminIds.includes(String(userId))) return true;
  const row = db.prepare('SELECT 1 FROM admins WHERE user_id = ?').get(String(userId));
  return !!row;
}

// ---------- feature toggle helpers ----------
function isFeatureEnabled(key) {
  const row = db
    .prepare('SELECT is_enabled FROM feature_toggles WHERE feature_key = ?')
    .get(key);
  return row ? !!row.is_enabled : true; // default ON if never set
}

function setFeatureEnabled(key, enabled) {
  db.prepare(
    `INSERT INTO feature_toggles (feature_key, is_enabled) VALUES (?, ?)
     ON CONFLICT(feature_key) DO UPDATE SET is_enabled = excluded.is_enabled`
  ).run(key, enabled ? 1 : 0);
}

module.exports = {
  db,
  getSetting,
  setSetting,
  upsertUser,
  getUser,
  setUserVerified,
  addUserBalance,
  deductUserBalance,
  recordDepositOnUser,
  addProduct,
  listActiveProducts,
  listAllProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  decrementStock,
  createDeposit,
  getDeposit,
  setDepositAdminFileId,
  decideDeposit,
  createOrder,
  getOrder,
  decideOrder,
  createPendingReferral,
  getPendingReferralByReferredId,
  completeReferral,
  countCompletedReferrals,
  topDepositors,
  topReferrers,
  addAdmin,
  isAdmin,
  isFeatureEnabled,
  setFeatureEnabled,
};
