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

module.exports = {
  fmtUsd,
  fmtInr,
  fmtMoney,
  isValidPositiveInt,
  isValidPositiveNumber,
  todayKey,
  weekKey,
  timeUntilWeekReset,
  escapeHtml,
  genRefCode,
};
