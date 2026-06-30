// shared/helpers.js
// Small formatting + validation helpers shared by both bots.

function fmtUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

function fmtInr(n) {
  return `₹${Math.round(Number(n))}`;
}

function fmtMoney(usd, inr) {
  return `${fmtUsd(usd)} • ${fmtInr(inr)}`;
}

// Converts a ₹ amount to its $ equivalent using the admin-set USDT rate
// (e.g. rate=90 means ₹90 = $1). Used everywhere a ₹ amount needs a $ figure.
function inrToUsd(amountInr, usdtRate) {
  const rate = Number(usdtRate) || 1;
  return Number(amountInr) / rate;
}

// The bot always stores money in ₹ but displays both currencies together.
// This is the single function every "fmtPrice(amountInr)" wrapper in both
// bots calls — it takes a ₹ amount + the current rate and returns
// "$X.XX • ₹Y" ready to drop into a message.
function fmtBoth(amountInr, usdtRate) {
  const usd = inrToUsd(amountInr, usdtRate);
  return fmtMoney(usd, amountInr);
}

// Validates that a string is a positive integer (used for "qty" prompts)
function isValidPositiveInt(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const n = parseInt(trimmed, 10);
  return n > 0;
}

// Validates a positive number (allows decimals) - used for deposit amounts
function isValidPositiveNumber(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return false;
  const n = parseFloat(trimmed);
  return n > 0;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function weekKey() {
  const d = new Date();
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

// Milliseconds until next week reset (Sunday 00:00), formatted as "1d 13h"
function timeUntilWeekReset() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
  const daysLeft = (7 - day) % 7;
  const next = new Date(now);
  next.setDate(now.getDate() + (daysLeft === 0 ? 7 : daysLeft));
  next.setHours(0, 0, 0, 0);
  const diffMs = next - now;
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function genRefCode(userId) {
  return `ref_${userId}`;
}

// Reverses genRefCode(): pulls the numeric userId back out of a payload
// like "ref_8516417508" (the string Telegram sends after /start ).
// Returns null for anything that isn't a valid ref_<digits> code, so
// malformed or unrelated /start payloads are safely ignored upstream.
function parseRefCode(payload) {
  if (typeof payload !== 'string') return null;
  const match = payload.trim().match(/^ref_(\d+)$/);
  if (!match) return null;
  return Number(match[1]);
}

// Telegram's getChatMember returns a "status" field that can be:
// creator | administrator | member | restricted | left | kicked
// A user counts as an active member of the chat for everything except
// "left" (no longer in the chat) and "kicked" (banned). "restricted"
// still means they're physically in the chat, just limited — so it
// still counts as "joined" for our purposes.
function isActiveMember(status) {
  return ['creator', 'administrator', 'member', 'restricted'].includes(status);
}

// Generic short unique ID generator (timestamp + random suffix) for any
// future record type that doesn't already have its own prefix convention
// in db.js (products use 'p<ts>', deposits 'dep-<uid>-<ts>', orders
// 'ord-<uid>-<ts>').
function genId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Validates the value an admin types in for a "Channel Chat ID" /
// "Group Chat ID" field — either a numeric Telegram chat ID (groups/
// channels are negative, e.g. -1001234567890) or an @username.
function isValidChatIdOrUsername(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (/^-?\d+$/.test(trimmed)) return true;           // numeric chat ID
  if (/^@[A-Za-z0-9_]{5,32}$/.test(trimmed)) return true; // @username
  return false;
}

// Formats a Date.now()-style timestamp for admin-facing lists (deposits,
// orders, hired-admin list) — short, readable, IST-friendly.
function fmtDateTime(ts) {
  return new Date(ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

module.exports = {
  fmtUsd,
  fmtInr,
  fmtMoney,
  inrToUsd,
  fmtBoth,
  isValidPositiveInt,
  isValidPositiveNumber,
  isValidChatIdOrUsername,
  todayKey,
  weekKey,
  timeUntilWeekReset,
  fmtDateTime,
  escapeHtml,
  genRefCode,
  parseRefCode,
  isActiveMember,
  genId,
};
