// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// helpers.js — CLOUDE CART 🛒 | Shared Utilities
// Cross-Bot Photo Relay + State + Formatting
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const { getDb, saveDb } = require('./db');

// Bot references — set by init() after both bots created
let _userBot  = null;
let _adminBot = null;
function setBots(u, a) { _userBot = u; _adminBot = a; }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CROSS-BOT PHOTO RELAY SYSTEM
// Problem: file_id is bot-specific. BotA file_id ≠ BotB.
// Fix: Download bytes via getFileStream → Buffer →
//      re-upload via OTHER bot's token → fresh file_id.
// Both file_ids stored separately in DB.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// User Bot → Admin Bot (payment screenshots)
async function relayPhotoToAdmin(userFileId, adminChatId) {
  try {
    const stream = _userBot.getFileStream(userFileId);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const sent = await _adminBot.sendPhoto(adminChatId, buf);
    return sent.photo[sent.photo.length - 1].file_id;
  } catch (e) {
    console.error('[RELAY U→A]', e.message);
    return null;
  }
}

// Admin Bot → User Bot (QR codes)
async function mintUserBotFileId(adminFileId) {
  try {
    const ownerChatId = process.env.OWNER_ID;
    const stream = _adminBot.getFileStream(adminFileId);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const sent = await _userBot.sendPhoto(ownerChatId, buf);
    return sent.photo[sent.photo.length - 1].file_id;
  } catch (e) {
    console.error('[RELAY A→U]', e.message);
    return null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STATE MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const _us = {}, _as = {};
function setUserState(id, state, data={})  { _us[String(id)] = { state, data }; }
function getUserState(id)                  { return _us[String(id)] || null; }
function clearUserState(id)               { delete _us[String(id)]; }
function setAdminState(id, state, data={}) { _as[String(id)] = { state, data }; }
function getAdminState(id)                 { return _as[String(id)] || null; }
function clearAdminState(id)              { delete _as[String(id)]; }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FORMATTING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function inrToUsdt(inr) {
  const rate = getDb().settings.usdtToInrRate || 90;
  return (inr / rate).toFixed(2);
}
function formatBalance(inr) { return `₹${inr.toFixed(2)} ($${inrToUsdt(inr)})`; }
function flashSaleTimeLeft(endsAt) {
  const d = endsAt - Date.now(); if (d <= 0) return null;
  const h = Math.floor(d/3600000), m = Math.floor((d%3600000)/60000), s = Math.floor((d%60000)/1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function medal(i) { return ['🥇','🥈','🥉'][i] || `${i+1}.`; }

// Expose bot refs for user-bot.js to use adminBot
Object.defineProperty(module.exports, '_adminBot', { get: () => _adminBot, set: v => { _adminBot = v; } });
Object.defineProperty(module.exports, '_userBot',  { get: () => _userBot,  set: v => { _userBot  = v; } });

module.exports = Object.assign(module.exports, {
  setBots, relayPhotoToAdmin, mintUserBotFileId,
  setUserState, getUserState, clearUserState,
  setAdminState, getAdminState, clearAdminState,
  inrToUsdt, formatBalance, flashSaleTimeLeft, medal,
});
