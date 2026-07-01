// ─────────────────────────────────────────────────────────
// CROSS-BOT PHOTO RELAY
// Telegram file_id values are bot-specific: a file_id issued
// to BotA cannot be used by BotB. To move a photo from one
// bot's chat to the other bot's chat, we download the raw
// bytes with the bot that received the photo, then re-upload
// those bytes through the other bot's token, which mints a
// brand-new valid file_id for that bot.
// ─────────────────────────────────────────────────────────

/**
 * Downloads a photo (by file_id) using `fromBot`, then re-uploads
 * it as a new photo message to `toChatId` using `toBot`.
 *
 * @param {TelegramBot} fromBot - the bot instance that has the file_id
 * @param {TelegramBot} toBot - the bot instance that should receive the photo
 * @param {string} fileId - file_id valid for fromBot
 * @param {string|number} toChatId - chat to send the re-uploaded photo to
 * @param {object} [options] - optional caption/reply_markup for the re-sent photo
 * @returns {Promise<string|null>} the new file_id valid for toBot, or null on failure
 */
async function relayPhoto(fromBot, toBot, fileId, toChatId, options = {}) {
  try {
    const fileStream = fromBot.getFileStream(fileId);
    const chunks = [];
    for await (const chunk of fileStream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const sent = await toBot.sendPhoto(toChatId, buffer, options);
    const newFileId = sent.photo[sent.photo.length - 1].file_id;
    return newFileId;
  } catch (err) {
    console.error('[relayPhoto] failed:', err.message);
    return null; // caller should show a graceful fallback message, not crash
  }
}

module.exports = { relayPhoto };
