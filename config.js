require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  botToken: requireEnv('BOT_TOKEN'),
  adminBotToken: requireEnv('ADMIN_BOT_TOKEN'),
  ownerId: requireEnv('OWNER_ID'),
  adminIds: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  adminPassword: requireEnv('ADMIN_PASSWORD'),
  joinUrl: process.env.JOIN_URL || '',
  joinUrlName: process.env.JOIN_URL_NAME || 'Our Channel',
  channelId: process.env.CHANNEL_ID || '',
  supportUsername: process.env.SUPPORT_USERNAME || '',
  usdtToInrRate: parseFloat(process.env.USDT_TO_INR_RATE || '90'),
  referralRewardInr: parseFloat(process.env.REFERRAL_REWARD_INR || '10'),
  databasePath: process.env.DATABASE_PATH || './data/shop.db',
};

module.exports = config;
