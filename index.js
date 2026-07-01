const config = require('./config');
require('./db'); // ensures schema is created on boot
const { createUserBot } = require('./userBot');
const { createAdminBot } = require('./adminBot');

// Create the user-facing bot first...
const userBotInstance = createUserBot();

// ...then the admin bot, giving it a reference to the user bot
// so it can relay photos and DM users directly.
const adminBotInstance = createAdminBot(userBotInstance);

// Wire up the events the user bot fires when a deposit/order is created,
// so the admin bot can notify the owner with an approve/reject prompt.
userBotInstance.bot.emitDepositCreated = (payload) => {
  adminBotInstance.notifyNewDeposit(payload).catch((err) =>
    console.error('[notifyNewDeposit] error:', err.message)
  );
};

userBotInstance.bot.emitOrderCreated = (payload) => {
  adminBotInstance.notifyNewOrder(payload).catch((err) =>
    console.error('[notifyNewOrder] error:', err.message)
  );
};

console.log('✅ User bot and Admin bot are both running (polling mode).');
console.log(`Owner ID: ${config.ownerId}`);
