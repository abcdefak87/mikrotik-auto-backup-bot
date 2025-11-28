const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const envPath = fs.existsSync(path.join(__dirname, '..', '.env'))
  ? path.join(__dirname, '..', '.env')
  : path.join(__dirname, '..', 'env.example');

dotenv.config({ path: envPath });

const parseChatIds = (value = '') =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    allowedChatIds: parseChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    defaultChatId: process.env.TELEGRAM_DEFAULT_CHAT_ID || null,
  },
  backup: {
    directory: path.join(
      __dirname,
      '..',
      process.env.BACKUP_DIRECTORY || 'backups'
    ),
    cronSchedule: process.env.BACKUP_CRON_SCHEDULE || '0 18 * * *',
    timezone: process.env.ROUTER_TIMEZONE || 'Asia/Jakarta',
  },
};

