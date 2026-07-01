// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// helpers.js — CLOUDE CART 🛒 | Shared Utilities
// Includes: Cross-Bot Photo Relay, formatting, state mgmt
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { getDb, saveDb } = require('./db');

// ── Bot instances (set after bots are created) ─────────
let _userBot  = null;
let _adminBot = null;

function setBots(userBot, adminBot) {
  _userBot  = userBot;
  _adminBot = adminBot;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CROSS-BOT PHOTO RELAY SYSTEM
// Problem: A file_id from BotA cannot be used by BotB.
// Solution: Download bytes via getFileStream → Buffer
//           → re-upload via receiving bot's token
//           → store BOTH file_ids separately in DB.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Relay: User Bot → Admin Bot
 * Used for payment screenshots.
 * Returns the new Admin-Bot-valid file_id, or null on failure.
 */
async function relayPhotoToAdmin(userBotFileId, adminChatId) {
  try {
    // Step 1: Download raw bytes using the bot that received the photo
    const fileStream = _userBot.getFileStream(userBotFileId);
    const chunks = [];
    for await (const chunk of fileStream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // Step 2: Re-upload via Admin Bot → mints a fresh Admin-valid file_id
    const sent = await _adminBot.sendPhoto(adminChatId, buffer);
    return sent.photo[sent.photo.length - 1].file_id;
  } catch (err) {
    console.error('[RELAY User→Admin] Failed:', err.message);
    return null; // caller handles fallback — never crash
  }
}

/**
 * Relay: Admin Bot → User Bot
 * Used for QR code images uploaded by admin.
 * Sends to ADMIN_NOTIFY_CHAT_ID (owner) via User Bot to mint file_id.
 * Returns the new User-Bot-valid file_id, or null on failure.
 */
async function mintUserBotFileId(adminBotFileId) {
  try {
    const ownerChatId = process.env.OWNER_ID;

    // Step 1: Download raw bytes using the bot that received the QR
    const fileStream = _adminBot.getFileStream(adminBotFileId);
    const chunks = [];
    for await (const chunk of fileStream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // Step 2: Re-upload via User Bot → mints a fresh User-valid file_id
    // Owner must have /start'd the User Bot at least once for this to work
    const sent = await _userBot.sendPhoto(ownerChatId, buffer);
    return sent.photo[sent.photo.length - 1].file_id;
  } catch (err) {
    console.error('[RELAY Admin→User] Failed:', err.message);
    return null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STATE MANAGEMENT
// Simple in-memory state machine for multi-step flows
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const _userStates  = {};
const _adminStates = {};

function setUserState(userId, state, data = {}) {
  _userStates[String(userId)] = { state, data, ts: Date.now() };
}
function getUserState(userId) {
  return _userStates[String(userId)] || null;
}
function clearUserState(userId) {
  delete _userStates[String(userId)];
}

function setAdminState(userId, state, data = {}) {
  _adminStates[String(userId)] = { state, data, ts: Date.now() };
}
function getAdminState(userId) {
  return _adminStates[String(userId)] || null;
}
function clearAdminState(userId) {
  delete _adminStates[String(userId)];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FORMATTING HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function inrToUsdt(inrAmount) {
  const db = getDb();
  const rate = db.settings.usdtToInrRate || 90;
  return (inrAmount / rate).toFixed(2);
}

function usdtToInr(usdtAmount) {
  const db = getDb();
  const rate = db.settings.usdtToInrRate || 90;
  return Math.round(usdtAmount * rate);
}

function formatBalance(inrAmount) {
  const usdt = inrToUsdt(inrAmount);
  return `₹${inrAmount.toFixed(2)} ($${usdt})`;
}

function formatProduct(p, rate) {
  const inr = p.price;
  const usd = (inr / rate).toFixed(2);
  const flash = p.flashSale ? ` 🔥` : '';
  return `${p.emoji || '📦'} ${p.name}${flash} | $${usd} • ₹${inr} | ${p.stock} In Stock`;
}

function flashSaleTimeLeft(endsAt) {
  const diff = endsAt - Date.now();
  if (diff <= 0) return null;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function escapeMarkdown(text) {
  if (!text) return '';
  return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// Medal for leaderboard
function medal(rank) {
  return ['🥇','🥈','🥉'][rank] || `${rank + 1}.`;
}

// Short user display: @username or First Name + ID
function userDisplay(user) {
  if (user.username) return `@${user.username}`;
  return `${user.firstName || 'User'} (${user.userId})`;
}

module.exports = {
  setBots,
  relayPhotoToAdmin,
  mintUserBotFileId,
  setUserState, getUserState, clearUserState,
  setAdminState, getAdminState, clearAdminState,
  inrToUsdt, usdtToInr, formatBalance, formatProduct,
  flashSaleTimeLeft, escapeMarkdown, medal, userDisplay,
};
