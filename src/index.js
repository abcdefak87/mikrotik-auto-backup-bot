const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');
const { createReadStream } = require('fs');
const { format } = require('date-fns');
const config = require('./config');
const { performBackup, testConnection } = require('./services/mikrotikService');
const {
  getRouters,
  addRouter,
  removeRouter,
} = require('./services/routerStore');
const {
  getBackupFiles,
  getBackupFilesByRouter,
  deleteBackupPair,
  formatFileSize,
} = require('./services/backupFiles');
const { createRouterToken } = require('./services/downloadTokens');
const { startDownloadServer } = require('./services/downloadServer');

// Logging helper functions - must be defined before use
const logger = {
  error: (message, error = null) => {
    const timestamp = new Date().toISOString();
    if (error) {
      console.error(`[${timestamp}] ERROR: ${message}`, error.message || error);
      if (error.stack && process.env.NODE_ENV !== 'production') {
        console.error(error.stack);
      }
    } else {
      console.error(`[${timestamp}] ERROR: ${message}`);
    }
  },
  warn: (message) => {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] WARN: ${message}`);
  },
  info: (message) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] INFO: ${message}`);
  }
};

if (!config.telegram.token) {
  logger.error('Missing TELEGRAM_BOT_TOKEN. Set it in telegram-bot/.env before running.');
  process.exit(1);
}

const allowedChats = new Set(
  (config.telegram.allowedChatIds || []).filter(Boolean)
);
if (config.telegram.defaultChatId) {
  allowedChats.add(config.telegram.defaultChatId);
}

const ensureChatAllowed = (chatId) =>
  allowedChats.size === 0 || allowedChats.has(String(chatId));

const bot = new TelegramBot(config.telegram.token, { 
  polling: {
    interval: 1000,
    autoStart: true,
    params: {
      timeout: 10,
    },
  },
});
let lastBackupMeta = null;
let scheduledJob = null;
const sessions = new Map();
const sessionTimeouts = new Map(); // Track session timeouts for auto-cleanup
let customSchedule = null; // Store custom schedule set by user
const startTime = Date.now(); // Track bot start time for health check
const routerFailureCounts = new Map(); // Track consecutive failures per router

// Load custom schedule from file on startup
const scheduleFilePath = path.join(__dirname, '..', 'data', 'customSchedule.json');
async function loadCustomSchedule() {
  try {
    if (await fs.pathExists(scheduleFilePath)) {
      const data = await fs.readJSON(scheduleFilePath);
      customSchedule = data.schedule || null;
      // Custom schedule loaded
    }
  } catch (err) {
    logger.warn(`Failed to load custom schedule: ${err.message}`);
  }
}

async function saveCustomSchedule() {
  try {
    await fs.ensureDir(path.dirname(scheduleFilePath));
    await fs.writeJSON(scheduleFilePath, { schedule: customSchedule }, { spaces: 2 });
  } catch (err) {
    logger.error('Failed to save custom schedule', err);
  }
}

// Sanitize password from error messages
function sanitizeError(error) {
  if (!error) return error;
  const errorStr = error.toString();
  // Remove password patterns from error messages
  return errorStr.replace(/password[=:]\s*['"]?[^'"]*['"]?/gi, 'password=***');
}

// Helper function to detect network errors
function isNetworkError(err) {
  return err.code === 'EFATAL' || 
         err.code === 'ETIMEDOUT' || 
         err.code === 'ECONNRESET';
}

// Validate host/IP format
function isValidHost(host) {
  if (!host || typeof host !== 'string') return false;
  const trimmed = host.trim();
  if (!trimmed) return false;
  
  // IPv4 regex
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  // Basic hostname regex (allows letters, numbers, dots, hyphens)
  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  
  if (ipv4Regex.test(trimmed)) {
    // Validate each octet is 0-255
    const parts = trimmed.split('.');
    return parts.every(part => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
  }
  
  return hostnameRegex.test(trimmed);
}

const formatDate = (date, timezone = 'Asia/Jakarta') =>
  date
    ? new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: timezone,
      }).format(date)
    : '-';

// Escape special characters for Markdown (don't escape dots and dashes in numbers/dates)
function escapeMarkdown(text) {
  if (!text) return '';
  return String(text)
    .replace(/\_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\~/g, '\\~')
    .replace(/\`/g, '\\`')
    .replace(/\>/g, '\\>')
    .replace(/\#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/\=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\!/g, '\\!');
    // Don't escape dots (.) and dashes (-) as they're needed for dates, times, IPs, etc.
}

// Escape HTML special characters
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Format text with consistent HTML style
function formatHtml(text, options = {}) {
  if (!text) return '';
  const escaped = escapeHtml(String(text));
  if (options.bold) return `<b>${escaped}</b>`;
  if (options.code) return `<code>${escaped}</code>`;
  if (options.italic) return `<i>${escaped}</i>`;
  return escaped;
}

const parseArgs = (text) => text.split(/\s+/).slice(1).filter(Boolean);
const makeCallbackData = (action, payload) =>
  payload ? `${action}|${encodeURIComponent(payload)}` : action;
const parseCallbackData = (text = '') => {
  const [action, rawPayload] = text.split('|');
  return {
    action,
    payload: rawPayload ? decodeURIComponent(rawPayload) : null,
  };
};

const chunkButtons = (items, size = 2) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const sendMainMenu = async (chatId) => {
  const keyboard = [
    [
      {
        text: '📊 Status Backup',
      },
      {
        text: '📋 Daftar Router',
      },
    ],
    [
      {
        text: '💾 Backup',
      },
      {
        text: '⚙️ Setting Auto Backup',
      },
    ],
    [
      {
        text: '➕ Tambah Router',
      },
      {
        text: '➖ Hapus Router',
      },
    ],
    [
      {
        text: '🧪 Test Koneksi Router',
      },
      {
        text: '📁 File Backup',
      },
    ],
  ];

  await bot.sendMessage(chatId, 'Pilih menu:', {
    reply_markup: {
      keyboard,
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
};

async function findRouterByName(name) {
  const routers = await getRouters();
  return routers.find((r) => r.name === name);
}

async function sendBackup(chatId, triggeredBySchedule = false, routerName) {
  if (!chatId) {
    logger.warn('No chat ID available for backup delivery.');
    return;
  }

  const routers = await getRouters();
  if (!routers.length) {
    await bot.sendMessage(
      chatId,
      'Belum ada router terdaftar. Tambahkan dengan tombol "Tambah Router".'
    );
    return;
  }

  let targetRouters = routers;
  if (routerName) {
    const router = routers.find((r) => r.name === routerName);
    if (!router) {
      await bot.sendMessage(chatId, `Router "${routerName}" tidak ditemukan.`);
      return;
    }
    targetRouters = [router];
  }

  const notifyMessage = triggeredBySchedule
    ? `⏰ <b>Menjalankan Backup Terjadwal</b>\n\n📦 Router: ${targetRouters.length}`
    : `💾 <b>Menjalankan Backup</b>\n\n📦 Router: ${targetRouters.length}`;
  try {
    await bot.sendMessage(chatId, notifyMessage, { parse_mode: 'HTML' });
  } catch (err) {
    // Only log if it's not a network error (to avoid spam)
    if (!isNetworkError(err)) {
      logger.error('Failed to send backup notification', err);
    }
    // Continue with backup even if notification fails
  }

  const summary = [];
  for (const router of targetRouters) {
    try {
      const result = await performBackup(router);

      // Send documents with error handling and proper stream cleanup
      let backupStream = null;
      try {
        const backupFileName = path.basename(result.backupPath);
        backupStream = createReadStream(result.backupPath);
        await bot.sendDocument(chatId, backupStream, {
          caption: `[${router.name}] Backup binary (${backupFileName})`,
          filename: backupFileName,
          contentType: 'application/octet-stream',
        });
      } catch (docErr) {
        // Only log if it's not a network error (to avoid spam)
        if (!isNetworkError(docErr)) {
          logger.error(`Failed to send backup document for ${router.name}`, docErr);
        }
        // Don't try to send error message if network is down (will fail again)
        if (!isNetworkError(docErr)) {
          try {
            const sanitizedMsg = sanitizeError(docErr.message || 'Tidak diketahui');
            await bot.sendMessage(
              chatId,
              `[${router.name}] Backup berhasil, tetapi gagal mengirim file binary: ${sanitizedMsg}`
            );
          } catch (msgErr) {
            // Silently fail if network is down
            if (!isNetworkError(msgErr)) {
              logger.error('Failed to send error message', msgErr);
            }
          }
        }
      } finally {
        // Ensure stream is properly closed to prevent file handle leaks
        if (backupStream) {
          backupStream.destroy();
        }
      }
      
      let exportStream = null;
      try {
        const exportFileName = path.basename(result.exportPath);
        exportStream = createReadStream(result.exportPath);
        await bot.sendDocument(chatId, exportStream, {
          caption: `[${router.name}] Backup konfigurasi (${exportFileName})`,
          filename: exportFileName,
          contentType: 'text/plain',
        });
      } catch (docErr) {
        // Only log if it's not a network error (to avoid spam)
        if (!isNetworkError(docErr)) {
          logger.error(`Failed to send export document for ${router.name}`, docErr);
        }
        // Don't try to send error message if network is down (will fail again)
        if (!isNetworkError(docErr)) {
          try {
            const sanitizedMsg = sanitizeError(docErr.message || 'Tidak diketahui');
            await bot.sendMessage(
              chatId,
              `[${router.name}] Backup berhasil, tetapi gagal mengirim file export: ${sanitizedMsg}`
            );
          } catch (msgErr) {
            // Silently fail if network is down
            if (!isNetworkError(msgErr)) {
              logger.error('Failed to send error message', msgErr);
            }
          }
        }
      } finally {
        // Ensure stream is properly closed to prevent file handle leaks
        if (exportStream) {
          exportStream.destroy();
        }
      }

      summary.push({
        name: router.name.trim(), // Ensure trimmed name
        success: true,
        backupPath: result.backupPath,
        exportPath: result.exportPath,
        backupFileName: path.basename(result.backupPath),
        exportFileName: path.basename(result.exportPath),
      });
    } catch (err) {
      const sanitizedError = sanitizeError(err);
      // Only log if it's not a network error (to avoid spam)
      if (!isNetworkError(err)) {
        logger.error('Backup error', err);
      }
      const errorMessage = sanitizeError(err.message || 'Tidak diketahui');
      summary.push({
        name: router.name.trim(), // Ensure trimmed name
        success: false,
        error: errorMessage,
      });
      // Don't try to send error message if network is down (will fail again)
      if (!isNetworkError(err)) {
        try {
          await bot.sendMessage(
            chatId,
            `[${router.name}] Backup gagal: ${errorMessage}`
          );
        } catch (msgErr) {
            // Silently fail if network is down
            if (!isNetworkError(msgErr)) {
              logger.error('Failed to send backup error message', msgErr);
            }
        }
      }
    }
  }

  const timestamp = new Date();
  lastBackupMeta = {
    successAt: timestamp,
    routers: summary,
  };


  // Update failure counts and check for alerts
  const failureThreshold = 3;
  for (const routerResult of summary) {
    if (routerResult.success) {
      // Reset failure count on success
      routerFailureCounts.set(routerResult.name, 0);
    } else {
      // Increment failure count
      const currentFailures = routerFailureCounts.get(routerResult.name) || 0;
      const newFailures = currentFailures + 1;
      routerFailureCounts.set(routerResult.name, newFailures);
      
      // Alert if threshold exceeded
      if (newFailures >= failureThreshold && config.telegram.defaultChatId) {
        try {
          await bot.sendMessage(
            config.telegram.defaultChatId,
            `⚠️ <b>ALERT: Backup Gagal Berulang</b>\n\n` +
            `📡 Router: <b>${formatHtml(routerResult.name)}</b>\n` +
            `❌ Gagal berturut-turut: ${newFailures}x\n` +
            `⚠️ Error: ${formatHtml(routerResult.error || 'Tidak diketahui')}\n\n` +
            `Silakan periksa koneksi dan konfigurasi router.`,
            { parse_mode: 'HTML' }
          );
        } catch (alertErr) {
          if (!isNetworkError(alertErr)) {
            logger.error('Failed to send failure alert', alertErr);
          }
        }
      }
    }
  }

  const successCount = summary.filter((s) => s.success).length;
  try {
    await bot.sendMessage(
      chatId,
      `✅ <b>Backup Selesai</b>\n\n🕐 Waktu: ${formatHtml(formatDate(lastBackupMeta.successAt, config.backup.timezone))}\n✅ Berhasil: ${successCount}\n❌ Gagal: ${summary.length - successCount}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    // Silently fail if network is down (to avoid spam)
    if (!isNetworkError(err)) {
      logger.error('Failed to send backup summary', err);
    }
  }

  // Send notification to group if configured
  await sendBackupNotificationToGroup(summary, triggeredBySchedule);
}

// Send backup notification to group
async function sendBackupNotificationToGroup(summary, triggeredBySchedule = false) {
  if (!config.telegram.groupChatId) {
    return; // Group chat ID not configured, skip
  }

  const successCount = summary.filter((s) => s.success).length;
  const failedCount = summary.length - successCount;
  const timestamp = lastBackupMeta?.successAt || new Date();
  const timeStr = formatDate(timestamp, config.backup.timezone);

  // Build router status list with download links
  const routerStatusList = [];
  const downloadLinks = [];
  
  for (const r of summary) {
    if (r.success) {
      routerStatusList.push(`  ✅ ${formatHtml(r.name)}`);
      
      // Generate download links if download server is enabled
      if (config.downloadServer.enabled && r.backupPath && r.exportPath) {
        try {
          const routerToken = await createRouterToken(r.name);
          
          const downloadUrl = `${config.downloadServer.baseUrl}/download?token=${routerToken.token}`;
          
          downloadLinks.push(
            `\n📡 <b>${formatHtml(r.name)}:</b>`,
            `  • <a href="${downloadUrl}">Download Backup</a>`
          );
        } catch (err) {
          logger.error(`Failed to create download token for ${r.name}`, err);
        }
      }
    } else {
      const errorMsg = sanitizeError(r.error || 'Tidak diketahui');
      routerStatusList.push(`  ❌ ${formatHtml(r.name)}: ${formatHtml(errorMsg)}`);
    }
  }

  // Build notification message
  const triggerType = triggeredBySchedule ? '⏰ Backup Terjadwal' : '💾 Backup Manual';
  const statusIcon = failedCount === 0 ? '✅' : failedCount === summary.length ? '❌' : '⚠️';
  
  const message = [
    `${statusIcon} <b>${triggerType} Selesai</b>`,
    '',
    `🕐 <b>Waktu:</b> ${formatHtml(timeStr)}`,
    `📦 <b>Total Router:</b> ${summary.length}`,
    `✅ <b>Berhasil:</b> ${successCount}`,
    failedCount > 0 ? `❌ <b>Gagal:</b> ${failedCount}` : '',
    '',
    `<b>📋 Detail Router:</b>`,
    routerStatusList.join('\n'),
    downloadLinks.length > 0 ? '\n<b>🔗 Download Link:</b>' : '',
    ...downloadLinks,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    await bot.sendMessage(config.telegram.groupChatId, message, { 
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    // Silently fail if network is down (to avoid spam)
    if (!isNetworkError(err)) {
      logger.error('Failed to send backup notification to group', err);
    }
  }
}

// Validate timezone
function isValidTimezone(timezone) {
  try {
    // Use explicit locale to avoid system default
    const formatter = Intl.DateTimeFormat('en-US', { timeZone: timezone });
    // Also try to format a date to ensure timezone is valid
    const testDate = new Date();
    formatter.format(testDate);
    return true;
  } catch (e) {
    return false;
  }
}

async function scheduleJob(cronSchedule = null) {
  if (!config.telegram.defaultChatId) {
    logger.warn('TELEGRAM_DEFAULT_CHAT_ID belum diatur. Backup terjadwal tidak akan dikirim.');
    return;
  }

  // Use custom schedule if set, otherwise use default from config
  const schedule = cronSchedule || customSchedule || config.backup.cronSchedule;
  
  // Validate and fix timezone
  let timezone = config.backup.timezone;
  if (!isValidTimezone(timezone)) {
    logger.warn(`Invalid timezone "${timezone}", falling back to "Asia/Jakarta"`);
    timezone = 'Asia/Jakarta';
  }
  
  // Stop existing job if any
  if (scheduledJob) {
    scheduledJob.stop();
    scheduledJob = null;
  }

  try {
    scheduledJob = cron.schedule(
      schedule,
      () => sendBackup(config.telegram.defaultChatId, true),
      {
        timezone: timezone,
      }
    );
  } catch (err) {
    logger.error(`Failed to schedule job with timezone "${timezone}"`, err);
    // Fallback to UTC if timezone fails
    logger.warn('Falling back to UTC timezone');
    scheduledJob = cron.schedule(
      schedule,
      () => sendBackup(config.telegram.defaultChatId, true),
      {
        timezone: 'UTC',
      }
    );
    timezone = 'UTC';
  }

  // Store custom schedule
  if (cronSchedule) {
    customSchedule = cronSchedule;
    await saveCustomSchedule();
  }

}

function getNextRunTime() {
  if (!scheduledJob) return null;
  
  // Get current schedule
  const schedule = customSchedule || config.backup.cronSchedule;
  
  try {
    const { CronExpressionParser } = require('cron-parser');
    const timezone = config.backup.timezone || 'Asia/Jakarta';
    
    const expr = CronExpressionParser.parse(schedule, {
      tz: timezone
    });
    const next = expr.next();
    return next.toDate();
  } catch (err) {
    logger.error('Error calculating next run time', err);
    // Fallback to simple calculation for daily schedules
    try {
      const parts = schedule.trim().split(/\s+/);
      if (parts.length === 5) {
        const [minute, hour, day, month, dayOfWeek] = parts;
        if (day === '*' && month === '*' && dayOfWeek === '*') {
          const now = new Date();
          const nextRun = new Date(now);
          const scheduleHour = hour === '*' ? 0 : parseInt(hour, 10);
          const scheduleMinute = minute === '*' ? 0 : parseInt(minute, 10);
          
          nextRun.setHours(scheduleHour, scheduleMinute, 0, 0);
          
          if (nextRun <= now) {
            nextRun.setDate(nextRun.getDate() + 1);
          }
          
          return nextRun;
        }
      }
    } catch (fallbackErr) {
      // Ignore fallback errors
    }
    return null;
  }
}

async function sendStatusMessage(chatId) {
  try {
    const routers = await getRouters();
    const nextRun = getNextRunTime();
    const routerLines = routers.length
      ? routers
          .map(
            (r) => `• ${formatHtml(r.name)}: ${formatHtml(r.host)}:${r.port || 22} (${formatHtml(r.username)})`
          )
          .join('\n')
      : '• Belum ada router';

    const lastSummary = lastBackupMeta?.routers
      ?.map(
        (r) => {
          const errorMsg = r.error ? sanitizeError(r.error) : 'Tidak diketahui';
          return `  • ${formatHtml(r.name)}: ${r.success ? '✅ Berhasil' : `❌ ${formatHtml(errorMsg)}`}`;
        }
      )
      .join('\n');

    const scheduleTime = cronToTime(config.backup.cronSchedule) || config.backup.cronSchedule;
    const lastBackupTime = lastBackupMeta?.successAt
      ? formatDate(lastBackupMeta.successAt, config.backup.timezone)
      : '❌ Belum pernah';
    const nextRunTime = nextRun
      ? formatDate(nextRun, config.backup.timezone)
      : '❌ Tidak terjadwal / menunggu konfigurasi';

    // Use HTML mode instead of Markdown for better compatibility
    const response = [
      `📊 <b>Status Backup</b>`,
      '',
      `📦 <b>Total Router:</b> ${routers.length}`,
      routerLines,
      '',
      `📁 <b>Folder Lokal:</b>`,
      `<code>${formatHtml(config.backup.directory)}</code>`,
      '',
      `⏰ <b>Jadwal Backup:</b>`,
      `${formatHtml(scheduleTime)} (${formatHtml(config.backup.timezone)})`,
      '',
      `🕐 <b>Backup Terakhir:</b>`,
      formatHtml(lastBackupTime),
      lastSummary ? `\n📋 <b>Ringkasan Terakhir:</b>\n${lastSummary}` : '',
      '',
      `⏭️ <b>Backup Berikutnya:</b>`,
      formatHtml(nextRunTime),
    ]
      .filter(Boolean)
      .join('\n');

    await bot.sendMessage(chatId, response, { parse_mode: 'HTML' });
  } catch (err) {
    const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
    try {
      await bot.sendMessage(chatId, `❌ Error saat menampilkan status: ${sanitizedMsg}`);
    } catch (sendErr) {
      if (!isNetworkError(sendErr)) {
        logger.error('Failed to send error message', sendErr);
      }
    }
    logger.error('Error in sendStatusMessage', err);
  }
}

async function sendRouterListMessage(chatId) {
  const routers = await getRouters();
  if (!routers.length) {
    await bot.sendMessage(chatId, '❌ Belum ada router terdaftar.');
    return;
  }
  const lines = routers
    .map(
      (r, idx) =>
        `${idx + 1}. <b>${formatHtml(r.name)}</b>\n   📍 ${formatHtml(r.host)}:${r.port || 22}\n   👤 ${formatHtml(r.username)}`
    )
    .join('\n\n');
  await bot.sendMessage(chatId, `📋 <b>Daftar Router</b>\n\n${lines}`, { parse_mode: 'HTML' });
}

async function sendHealthCheck(chatId) {
  const uptime = Date.now() - startTime;
  const uptimeHours = Math.floor(uptime / (1000 * 60 * 60));
  const uptimeMinutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
  const uptimeSeconds = Math.floor((uptime % (1000 * 60)) / 1000);
  
  const memory = process.memoryUsage();
  const memoryMB = {
    rss: (memory.rss / 1024 / 1024).toFixed(2),
    heapUsed: (memory.heapUsed / 1024 / 1024).toFixed(2),
    heapTotal: (memory.heapTotal / 1024 / 1024).toFixed(2),
  };
  
  const routers = await getRouters();
  
  const healthInfo = [
    '🏥 <b>Health Check</b>',
    '',
    '⏱️ <b>Uptime:</b>',
    `${uptimeHours}j ${uptimeMinutes}m ${uptimeSeconds}s`,
    '',
    '💾 <b>Memory Usage:</b>',
    `RSS: ${formatHtml(memoryMB.rss)} MB`,
    `Heap Used: ${formatHtml(memoryMB.heapUsed)} MB`,
    `Heap Total: ${formatHtml(memoryMB.heapTotal)} MB`,
    '',
    '🔧 <b>System:</b>',
    `Total Router: ${routers.length}`,
    `Auto Backup: ${scheduledJob ? '✅ Aktif' : '❌ Nonaktif'}`,
    `Timezone: ${formatHtml(config.backup.timezone)}`,
  ].join('\n');
  
  await bot.sendMessage(chatId, healthInfo, { parse_mode: 'HTML' });
}

async function sendFileBackupMenu(chatId) {
  const routers = await getRouters();
  if (!routers.length) {
    await bot.sendMessage(chatId, 'Belum ada router terdaftar.');
    return;
  }
  
  const keyboard = [
    [
      {
        text: '📁 Semua Router',
        callback_data: 'files_all',
      },
    ],
  ];
  
  // Add router-specific buttons
  const routerButtons = routers.map((router) => [
    {
      text: `📁 ${router.name}`,
      callback_data: `files_${encodeURIComponent(router.name)}`,
    },
  ]);
  
  keyboard.push(...routerButtons);
  
  keyboard.push([
    {
      text: '⬅️ Kembali ke Menu',
      callback_data: 'menu',
    },
  ]);
  
  await bot.sendMessage(chatId, '📁 <b>File Backup</b>\n\nPilih router untuk melihat file backup:', {
    reply_markup: {
      inline_keyboard: keyboard,
    },
    parse_mode: 'HTML',
  });
}

async function sendBackupFilesList(chatId, routerName = null, page = 0) {
  const limit = 10;
  const offset = page * limit;
  
  let files;
  let title;
  
  // Clean up old file path maps
  if (sessions.has(chatId)) {
    const session = sessions.get(chatId);
    if (session.filePathMapExpiry && session.filePathMapExpiry < Date.now()) {
      delete session.filePathMap;
      delete session.filePathMapExpiry;
    }
  }
  
  if (routerName) {
    files = await getBackupFilesByRouter(routerName, 100); // Get more to allow pagination
    title = `📁 <b>File Backup: ${formatHtml(routerName)}</b>`;
  } else {
    // For all routers, we need to map safe names back to original names
    const routers = await getRouters();
    const routerNameMap = new Map();
    routers.forEach(r => {
      const safe = r.name.replace(/[^a-zA-Z0-9-_]/g, '_');
      routerNameMap.set(safe, r.name);
    });
    
    const allFiles = await getBackupFiles();
    // Map safe router names back to original names
    files = allFiles.map(file => {
      const originalName = routerNameMap.get(file.routerName) || file.routerName;
      return { ...file, routerName: originalName };
    });
    title = '📁 <b>File Backup: Semua Router</b>';
  }
  
  if (files.length === 0) {
    await bot.sendMessage(
      chatId,
      routerName
        ? `Belum ada file backup untuk router "${formatHtml(routerName)}".`
        : 'Belum ada file backup.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  
  const totalPages = Math.ceil(files.length / limit);
  const pageFiles = files.slice(offset, offset + limit);
  
  // Group files by timestamp (backup + rsc pairs)
  const fileGroups = new Map();
  for (const file of pageFiles) {
    const timestamp = format(file.timestamp, 'yyyyMMdd_HHmmss');
    const key = `${file.routerName}_${timestamp}`;
    
    if (!fileGroups.has(key)) {
      fileGroups.set(key, {
        routerName: file.routerName,
        timestamp: file.timestamp,
        files: [],
      });
    }
    
    fileGroups.get(key).files.push(file);
  }
  
  const fileList = Array.from(fileGroups.values())
    .map((group, idx) => {
      const date = formatDate(group.timestamp, config.backup.timezone);
      const backupFile = group.files.find((f) => f.type === 'backup');
      const rscFile = group.files.find((f) => f.type === 'rsc');
      const totalSize = group.files.reduce((sum, f) => sum + f.size, 0);
      
      return `${offset + idx + 1}. ${formatHtml(date)}\n   📦 ${backupFile ? formatFileSize(backupFile.size) : 'N/A'} | 📄 ${rscFile ? formatFileSize(rscFile.size) : 'N/A'}\n   💾 Total: ${formatFileSize(totalSize)}`;
    });
  
  const keyboard = [];
  
  // Store file paths in a map for delete operation (use simple index to avoid long callback_data)
  const filePathMap = new Map();
  let fileIndex = 0;
  
  // Add delete buttons for each file group
  for (const [key, group] of fileGroups.entries()) {
    const backupFile = group.files.find((f) => f.type === 'backup');
    if (backupFile) {
      // Use index instead of full path to avoid BUTTON_DATA_INVALID error
      const indexKey = `file_${page}_${fileIndex++}`;
      filePathMap.set(indexKey, backupFile.filePath);
      
      keyboard.push([
        {
          text: `🗑️ Hapus ${formatDate(group.timestamp, config.backup.timezone)}`,
          callback_data: `delete_backup|${indexKey}|${routerName ? encodeURIComponent(routerName) : 'all'}`,
        },
      ]);
    }
  }
  
  // Store file path map in session for this chat (will be used in delete handler)
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {});
  }
  sessions.get(chatId).filePathMap = filePathMap;
  sessions.get(chatId).filePathMapExpiry = Date.now() + (5 * 60 * 1000); // 5 minutes expiry
  
  // Add pagination and back buttons
  const navRow = [];
  
  // Add "Kembali" button
  navRow.push({
    text: '⬅️ Kembali',
    callback_data: routerName ? `files_${encodeURIComponent(routerName)}` : 'files_all',
  });
  
  // Add pagination buttons if more than 1 page
  if (totalPages > 1) {
    if (page > 0) {
      navRow.push({
        text: '⬅️ Sebelumnya',
        callback_data: `files_page_${routerName ? encodeURIComponent(routerName) : 'all'}_${page - 1}`,
      });
    }
    if (page < totalPages - 1) {
      navRow.push({
        text: 'Selanjutnya ➡️',
        callback_data: `files_page_${routerName ? encodeURIComponent(routerName) : 'all'}_${page + 1}`,
      });
    }
  }
  
  keyboard.push(navRow);
  
  const messageText = [
    title,
    '',
    ...fileList,
    '',
    `Total: ${files.length} file backup | Halaman ${page + 1}/${totalPages}`,
  ].join('\n');
  
  await bot.sendMessage(chatId, messageText, {
    reply_markup: {
      inline_keyboard: keyboard,
    },
    parse_mode: 'HTML',
  });
}


async function sendAutoBackupSettings(chatId) {
  const routers = await getRouters();
  const isEnabled = scheduledJob !== null;
  const nextRun = getNextRunTime();
  const currentSchedule = customSchedule || config.backup.cronSchedule;
  const readableTime = cronToTime(currentSchedule) || currentSchedule;
  
  const statusText = isEnabled 
    ? `✅ <b>Aktif</b>\n⏰ Waktu: ${formatHtml(readableTime)} (setiap hari)\n🌍 Timezone: ${formatHtml(config.backup.timezone)}\n⏭️ Backup berikut: ${nextRun ? formatHtml(formatDate(nextRun, config.backup.timezone)) : 'Tidak diketahui'}`
    : `❌ <b>Nonaktif</b>\n⏰ Waktu: ${formatHtml(readableTime)} (setiap hari)\n🌍 Timezone: ${formatHtml(config.backup.timezone)}\n⚠️ Belum ada jadwal backup otomatis yang diaktifkan.`;

  const keyboard = [
    [
      {
        text: isEnabled ? '⏸️ Nonaktifkan Auto Backup' : '▶️ Aktifkan Auto Backup',
      },
    ],
    [
      {
        text: '🕐 Atur Jadwal Backup',
      },
    ],
    [
      {
        text: '⬅️ Kembali ke Menu',
      },
    ],
  ];

  await bot.sendMessage(
    chatId,
    `⚙️ <b>Setting Auto Backup</b>\n\n${statusText}\n\n📦 Total router: ${routers.length}`,
    {
      reply_markup: {
        keyboard,
        resize_keyboard: true,
        one_time_keyboard: false,
      },
      parse_mode: 'HTML',
    }
  );
}

async function startScheduleSettingFlow(chatId) {
  clearSession(chatId);
  sessions.set(chatId, {
    action: 'set_schedule',
    step: 'time',
    data: {},
  });
  setSessionTimeout(chatId);
  try {
    await bot.sendMessage(
      chatId,
      '⏰ <b>Atur Jadwal Backup</b>\n\nMasukkan waktu backup dalam format:\n<b>HH:MM</b> (24 jam)\n\nContoh:\n• <code>18:00</code> = Setiap hari jam 18:00\n• <code>00:00</code> = Setiap hari jam 00:00 (tengah malam)\n• <code>09:30</code> = Setiap hari jam 09:30\n\nMasukkan waktu (HH:MM):',
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.error('Failed to send message in startScheduleSettingFlow', err);
    clearSession(chatId);
  }
}

// Convert time format (HH:MM) to cron expression
function timeToCron(timeStr) {
  const timeMatch = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatch) return null;
  
  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  
  // Convert to cron: minute hour * * * (every day)
  return `${minute} ${hour} * * *`;
}

// Convert cron expression to readable time format (HH:MM)
function cronToTime(cronExpr) {
  if (!cronExpr) return null;
  
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  
  const [minute, hour, day, month, dayOfWeek] = parts;
  
  // Only convert if it's a daily schedule (* * * *)
  if (day === '*' && month === '*' && dayOfWeek === '*') {
    const h = hour === '*' ? '00' : hour.padStart(2, '0');
    const m = minute === '*' ? '00' : minute.padStart(2, '0');
    return `${h}:${m}`;
  }
  
  return null;
}

async function sendRouterSelection(chatId, action, emptyMessage) {
  const routers = await getRouters();
  if (!routers.length) {
    await bot.sendMessage(chatId, emptyMessage || 'Belum ada router.');
    return;
  }

  const buttons = routers.map((router) => ({
    text: router.name,
    callback_data: makeCallbackData(action, router.name),
  }));

  const inline_keyboard = chunkButtons(buttons);
  inline_keyboard.push([
    {
      text: '⬅️ Kembali ke Menu',
      callback_data: makeCallbackData('menu'),
    },
  ]);

  await bot.sendMessage(chatId, 'Pilih router:', {
    reply_markup: {
      inline_keyboard,
    },
  });
}

async function startAddRouterFlow(chatId) {
  clearSession(chatId);
  sessions.set(chatId, {
    action: 'add_router',
    step: 'name',
    data: {},
  });
  setSessionTimeout(chatId);
  try {
    await bot.sendMessage(
      chatId,
      'Tambah router baru.\nMasukkan nama router (contoh: kantor):'
    );
  } catch (err) {
    logger.error('Failed to send message in startAddRouterFlow', err);
    clearSession(chatId);
  }
}

function clearSession(chatId) {
  sessions.delete(chatId);
  // Clear timeout if exists
  if (sessionTimeouts.has(chatId)) {
    clearTimeout(sessionTimeouts.get(chatId));
    sessionTimeouts.delete(chatId);
  }
}

function setSessionTimeout(chatId, timeoutMs = 30 * 60 * 1000) {
  // Clear existing timeout if any
  if (sessionTimeouts.has(chatId)) {
    clearTimeout(sessionTimeouts.get(chatId));
  }
  
  // Set new timeout to auto-cleanup session after 30 minutes
  const timeout = setTimeout(() => {
    clearSession(chatId);
  }, timeoutMs);
  
  sessionTimeouts.set(chatId, timeout);
}

// Periodic cleanup for stale session timeouts (every hour)
setInterval(() => {
  for (const [chatId, timeout] of sessionTimeouts.entries()) {
    // Check if session is stale (session deleted but timeout still exists)
    if (!sessions.has(chatId)) {
      clearTimeout(timeout);
      sessionTimeouts.delete(chatId);
    }
  }
}, 60 * 60 * 1000); // Every hour

async function handleSessionInput(chatId, text) {
  const session = sessions.get(chatId);
  if (!session) return;
  const value = text.trim();

  if (session.action === 'add_router') {
    if (session.step === 'name') {
      if (!value) {
        try {
          await bot.sendMessage(chatId, 'Nama router tidak boleh kosong. Silakan masukkan nama router:');
        } catch (err) {
          // Silently fail - error already handled by try-catch
        }
        return;
      }
      session.data.name = value;
      session.step = 'host';
      try {
        await bot.sendMessage(chatId, 'Masukkan host/IP router (contoh: 192.168.88.1):');
      } catch (err) {
        // Silently fail - error already handled by try-catch
      }
      return;
    }
    if (session.step === 'host') {
      if (!value) {
        try {
          await bot.sendMessage(chatId, 'Host/IP tidak boleh kosong. Silakan masukkan host/IP router:');
        } catch (err) {
          // Silently fail - error already handled by try-catch
        }
        return;
      }
      if (!isValidHost(value)) {
        try {
          await bot.sendMessage(chatId, 'Format host/IP tidak valid. Silakan masukkan IP address (contoh: 192.168.88.1) atau hostname (contoh: router.example.com):');
        } catch (err) {
          // Silently fail - error already handled by try-catch
        }
        return;
      }
      session.data.host = value.trim();
      session.step = 'username';
      try {
        await bot.sendMessage(chatId, 'Masukkan username router:');
      } catch (err) {
        // Silently fail - error already handled by try-catch
      }
      return;
    }
    if (session.step === 'username') {
      if (!value) {
        try {
          await bot.sendMessage(chatId, 'Username tidak boleh kosong. Silakan masukkan username router:');
        } catch (err) {
          // Silently fail - error already handled by try-catch
        }
        return;
      }
      session.data.username = value;
      session.step = 'password';
      try {
        await bot.sendMessage(chatId, 'Masukkan password router:');
      } catch (err) {
        // Silently fail - error already handled by try-catch
      }
      return;
    }
    if (session.step === 'password') {
      if (!value) {
        try {
          await bot.sendMessage(chatId, 'Password tidak boleh kosong. Silakan masukkan password router:');
        } catch (err) {
          // Silently fail - error already handled by try-catch
        }
        return;
      }
      session.data.password = value;
      session.step = 'port';
      try {
        await bot.sendMessage(
          chatId,
          'Masukkan port SSH (tekan Enter untuk default 22):'
        );
      } catch (err) {
        // Silently fail - error already handled by try-catch
      }
      return;
    }
    if (session.step === 'port') {
      const port = value ? Number(value) : 22;
      if (Number.isNaN(port) || port <= 0 || port > 65535) {
        try {
          await bot.sendMessage(chatId, 'Port tidak valid. Masukkan angka antara 1-65535.');
        } catch (err) {
          // Silently fail - error already handled by try-catch
        }
        return;
      }
      session.data.port = port;
      
      // Validate required fields
      if (!session.data.name || !session.data.host || !session.data.username || !session.data.password) {
        try {
          await bot.sendMessage(chatId, 'Data router tidak lengkap. Silakan mulai lagi.');
        } catch (err) {
          // Silently fail - error already handled by try-catch
        }
        clearSession(chatId);
        try {
          await sendMainMenu(chatId);
        } catch (err) {
          logger.error('Failed to send main menu', err);
        }
        return;
      }
      
      try {
        await addRouter(session.data);
        logger.info(`Router "${session.data.name}" berhasil ditambahkan`);
        try {
          await bot.sendMessage(
            chatId,
            `✅ Router "${formatHtml(session.data.name)}" berhasil ditambahkan.`,
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          logger.error('Failed to send success message', err);
        }
      } catch (err) {
        logger.error('Failed to add router', err);
        try {
          const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
          await bot.sendMessage(
            chatId,
            `❌ Gagal menambah router: ${formatHtml(sanitizedMsg)}`,
            { parse_mode: 'HTML' }
          );
        } catch (sendErr) {
          logger.error('Failed to send error message', sendErr);
        }
      } finally {
        clearSession(chatId);
        try {
          await sendMainMenu(chatId);
        } catch (err) {
          logger.error('Failed to send main menu', err);
        }
      }
    }
  }
  
  if (session.action === 'set_schedule') {
    if (session.step === 'time') {
      if (!value) {
        try {
          await bot.sendMessage(chatId, 'Waktu tidak boleh kosong. Silakan masukkan waktu dalam format HH:MM:\nContoh: 18:00');
        } catch (err) {
          // Silently fail - error already handled by try-catch
        }
        return;
      }
      
      // Convert time to cron expression
      const cronExpression = timeToCron(value);
      if (!cronExpression) {
        try {
          await bot.sendMessage(chatId, '❌ Format waktu tidak valid.\n\nGunakan format: **HH:MM** (24 jam)\n\nContoh:\n- `18:00` = Setiap hari jam 18:00\n- `09:30` = Setiap hari jam 09:30\n\nSilakan masukkan lagi:');
        } catch (err) {
          // Silently fail - error already handled by try-catch
        }
        return;
      }
      
      try {
        // Test if cron expression is valid by trying to create a schedule
        let testSchedule = null;
        try {
          testSchedule = cron.schedule(cronExpression, () => {}, { timezone: config.backup.timezone });
          testSchedule.stop();
        } catch (scheduleErr) {
          if (testSchedule) {
            testSchedule.stop();
          }
          throw scheduleErr;
        }
        
        // If valid, update schedule
        customSchedule = cronExpression;
        await saveCustomSchedule();
        if (scheduledJob) {
          // Restart with new schedule
          await scheduleJob(cronExpression);
          try {
            await bot.sendMessage(chatId, `✅ Jadwal backup berhasil diatur: **${value}** (setiap hari)\nAuto backup akan menggunakan jadwal baru ini.`);
          } catch (err) {
            // Silently fail - error already handled by try-catch
          }
        } else {
          try {
            await bot.sendMessage(chatId, `✅ Jadwal backup berhasil diatur: **${value}** (setiap hari)\nAktifkan auto backup untuk menggunakan jadwal ini.`);
          } catch (err) {
            // Silently fail - error already handled by try-catch
          }
        }
      } catch (err) {
        try {
          const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
          await bot.sendMessage(chatId, `❌ Gagal mengatur jadwal: ${sanitizedMsg}\nSilakan coba lagi dengan format HH:MM`);
        } catch (sendErr) {
          logger.error('Failed to send message', sendErr);
        }
        return;
      }
      
      clearSession(chatId);
      try {
        await sendAutoBackupSettings(chatId);
      } catch (err) {
        logger.error('Failed to send auto backup settings', err);
      }
    }
  }
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ensureChatAllowed(chatId)) return;
  await bot.sendMessage(
    chatId,
    'Bot backup MikroTik siap. Gunakan tombol menu untuk mulai.'
  );
  await sendMainMenu(chatId);
});

bot.onText(/\/menu\b/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ensureChatAllowed(chatId)) return;
  await sendMainMenu(chatId);
});

bot.onText(/\/status\b/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ensureChatAllowed(chatId)) return;
  await sendStatusMessage(chatId);
});

bot.onText(/\/get_chat_id\b/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Allow /get_chat_id to work even if chat is not whitelisted (for getting group ID)
  // But still check for private chats
  const chatType = msg.chat.type;
  if (chatType === 'private' && !ensureChatAllowed(chatId)) {
    return;
  }
  
  const chatInfo = msg.chat;
  const chatIdStr = String(chatId);
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const displayType = isGroup ? 'Group' : 'Private Chat';
  const chatTitle = chatInfo.title || chatInfo.first_name || chatInfo.username || 'N/A';
  
  const message = [
    `📋 <b>Chat ID Information</b>`,
    '',
    `💬 <b>Tipe:</b> ${formatHtml(displayType)}`,
    `📝 <b>Nama:</b> ${formatHtml(chatTitle)}`,
    `🆔 <b>Chat ID:</b> <code>${formatHtml(chatIdStr)}</code>`,
    '',
    isGroup 
      ? `✅ Gunakan Chat ID ini untuk <code>TELEGRAM_GROUP_CHAT_ID</code> di file .env`
      : `ℹ️ Untuk mendapatkan Group Chat ID, tambahkan bot ke group dan kirim command ini di group tersebut.`,
  ].join('\n');
  
  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (err) {
    // Log error for debugging
      logger.error('Failed to send chat ID info', err);
    // Try to send a simpler message if HTML fails
    try {
      await bot.sendMessage(
        chatId, 
        `Chat ID: ${chatIdStr}\n\nGunakan Chat ID ini untuk TELEGRAM_GROUP_CHAT_ID di file .env`
      );
    } catch (err2) {
        logger.error('Failed to send fallback chat ID message', err2);
    }
  }
});

bot.onText(/\/backup_now\b/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ensureChatAllowed(chatId)) return;
  const args = parseArgs(msg.text);
  const routerName = args[0];
  await sendBackup(chatId, false, routerName);
});

bot.onText(/\/test_connection\b/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ensureChatAllowed(chatId)) return;
  const args = parseArgs(msg.text);
  const routerName = args[0];
  if (!routerName) {
    await bot.sendMessage(chatId, 'Gunakan: /test_connection <nama_router>');
    return;
  }
  const router = await findRouterByName(routerName);
  if (!router) {
    await bot.sendMessage(chatId, `Router "${routerName}" tidak ditemukan.`);
    return;
  }
          try {
            await testConnection(router);
            await bot.sendMessage(
              chatId,
              `✅ <b>Koneksi Berhasil</b>\n\n📡 Router: <b>${formatHtml(router.name)}</b>\n📍 Host: ${formatHtml(router.host)}:${router.port || 22}\n👤 Username: ${formatHtml(router.username)}`,
              { parse_mode: 'HTML' }
            );
          } catch (err) {
            const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
            await bot.sendMessage(
              chatId,
              `❌ <b>Koneksi Gagal</b>\n\n📡 Router: <b>${formatHtml(router.name)}</b>\n📍 Host: ${formatHtml(router.host)}:${router.port || 22}\n👤 Username: ${formatHtml(router.username)}\n\n⚠️ Error: ${formatHtml(sanitizedMsg)}`,
              { parse_mode: 'HTML' }
            );
          }
});

bot.onText(/\/add_router\b/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ensureChatAllowed(chatId)) return;
  await startAddRouterFlow(chatId);
});

bot.onText(/\/remove_router\b/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ensureChatAllowed(chatId)) return;
  await sendRouterSelection(chatId, 'remove_router', 'Belum ada router.');
});

bot.onText(/\/list_routers\b/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ensureChatAllowed(chatId)) return;
  await sendRouterListMessage(chatId);
});

bot.onText(/\/cancel\b/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ensureChatAllowed(chatId)) return;
  if (sessions.has(chatId)) {
    clearSession(chatId);
    await bot.sendMessage(chatId, 'Aksi dibatalkan.');
  }
});

bot.onText(/\/health\b/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ensureChatAllowed(chatId)) return;
  await sendHealthCheck(chatId);
});

bot.on('callback_query', async (query) => {
  if (!query.message) return;
  const chatId = query.message.chat.id;
  if (!ensureChatAllowed(chatId)) {
    try {
      await bot.answerCallbackQuery(query.id, { text: 'Tidak diizinkan.' });
    } catch (err) {
      // Ignore expired query errors
      if (err.code !== 'ETELEGRAM' || !err.message.includes('query is too old')) {
        logger.error('Error answering callback query', err);
      }
    }
    return;
  }

  const { action, payload } = parseCallbackData(query.data);

  // Answer callback query immediately to prevent timeout
  // For operations that might take time, we'll answer with "Processing..."
  const isLongOperation = [
    'backup_all',
    'backup_router',
    'files_all',
    'files',
    'delete_backup',
    'files_page',
  ].includes(action) || action.startsWith('files_');

  if (isLongOperation) {
    try {
      await bot.answerCallbackQuery(query.id, { text: 'Memproses...' });
    } catch (err) {
      // Ignore expired query errors silently
      if (err.code !== 'ETELEGRAM' || !err.message.includes('query is too old')) {
        logger.warn(`Error answering callback query: ${err.message}`);
      }
    }
  } else {
    // For quick operations, answer after completion
  }
  
  try {
    switch (action) {
      case 'menu':
        await sendMainMenu(chatId);
        break;
      case 'status':
        await sendStatusMessage(chatId);
        break;
      case 'backup_all':
        await sendBackup(chatId, false);
        break;
      case 'backup_router_select':
        await sendRouterSelection(
          chatId,
          'backup_router',
          'Belum ada router untuk backup.'
        );
        break;
      case 'backup_router':
        if (payload) {
          await sendBackup(chatId, false, payload);
        }
        break;
      case 'list_routers':
        await sendRouterListMessage(chatId);
        break;
      case 'add_router_flow':
        await startAddRouterFlow(chatId);
        break;
      case 'remove_router_select':
        await sendRouterSelection(
          chatId,
          'remove_router',
          'Belum ada router untuk dihapus.'
        );
        break;
      case 'remove_router':
        if (payload) {
          try {
            await removeRouter(payload);
            logger.info(`Router "${payload}" berhasil dihapus`);
            await bot.sendMessage(chatId, `✅ Router "${formatHtml(payload)}" dihapus.`, { parse_mode: 'HTML' });
            // Answer callback query after successful removal
            try {
              await bot.answerCallbackQuery(query.id, { text: 'Router dihapus' });
            } catch (answerErr) {
              if (answerErr.code !== 'ETELEGRAM' || !answerErr.message.includes('query is too old')) {
                logger.warn(`Failed to answer callback query: ${answerErr.message}`);
              }
            }
          } catch (err) {
            logger.error('Failed to remove router', err);
            const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
            try {
              await bot.sendMessage(
                chatId,
                `❌ Gagal menghapus router: ${formatHtml(sanitizedMsg)}`,
                { parse_mode: 'HTML' }
              );
            } catch (sendErr) {
              logger.error('Failed to send error message', sendErr);
            }
            // Answer callback query even on error
            try {
              await bot.answerCallbackQuery(query.id, { text: 'Gagal menghapus router' });
            } catch (answerErr) {
              if (answerErr.code !== 'ETELEGRAM' || !answerErr.message.includes('query is too old')) {
                logger.warn(`Failed to answer callback query: ${answerErr.message}`);
              }
            }
          }
        } else {
          // Answer callback query if no payload
          try {
            await bot.answerCallbackQuery(query.id, { text: 'Router tidak ditemukan' });
          } catch (answerErr) {
            if (answerErr.code !== 'ETELEGRAM' || !answerErr.message.includes('query is too old')) {
                logger.warn(`Failed to answer callback query: ${answerErr.message}`);
            }
          }
        }
        break;
      case 'test_router_select':
        await sendRouterSelection(
          chatId,
          'test_router',
          'Belum ada router untuk diuji.'
        );
        break;
      case 'test_router':
        if (payload) {
          const router = await findRouterByName(payload);
          if (!router) {
            await bot.sendMessage(chatId, `Router "${payload}" tidak ditemukan.`);
            break;
          }
          try {
            await testConnection(router);
            await bot.sendMessage(
              chatId,
              `✅ <b>Koneksi Berhasil</b>\n\n📡 Router: <b>${formatHtml(router.name)}</b>\n📍 Host: ${formatHtml(router.host)}:${router.port || 22}\n👤 Username: ${formatHtml(router.username)}`,
              { parse_mode: 'HTML' }
            );
          } catch (err) {
            const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
            await bot.sendMessage(
              chatId,
              `❌ <b>Koneksi Gagal</b>\n\n📡 Router: <b>${formatHtml(router.name)}</b>\n📍 Host: ${formatHtml(router.host)}:${router.port || 22}\n👤 Username: ${formatHtml(router.username)}\n\n⚠️ Error: ${formatHtml(sanitizedMsg)}`,
              { parse_mode: 'HTML' }
            );
          }
        }
        break;
      case 'files_all':
        await sendBackupFilesList(chatId);
        break;
      case 'files':
        if (payload) {
          await sendBackupFilesList(chatId, payload);
        }
        break;
      case 'delete_backup':
        if (payload) {
          try {
            // Parse payload: indexKey|routerName
            const parts = payload.split('|');
            const indexKey = parts[0];
            const routerNameParam = parts[1] ? decodeURIComponent(parts[1]) : null;
            
            // Get file path from session map
            const session = sessions.get(chatId);
            let filePath = null;
            
            if (session && session.filePathMap && session.filePathMapExpiry > Date.now()) {
              filePath = session.filePathMap.get(indexKey);
            }
            
            if (!filePath) {
              await bot.sendMessage(chatId, '❌ Session expired. Silakan pilih file backup lagi.');
              break;
            }
            
            const deletedFiles = await deleteBackupPair(filePath);
            await bot.sendMessage(
              chatId,
              `✅ File backup berhasil dihapus.\n\nDihapus ${deletedFiles.length} file.`
            );
            
            // Clean up session map
            if (session && session.filePathMap) {
              session.filePathMap.delete(indexKey);
            }
            
            // Refresh file list
            const routerName = routerNameParam === 'all' ? null : routerNameParam;
            await sendBackupFilesList(chatId, routerName);
          } catch (err) {
            const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
            await bot.sendMessage(chatId, `❌ Gagal menghapus file backup: ${sanitizedMsg}`);
          }
        }
        break;
      case 'files_page':
        // Handle pagination: files_page_<routerName>_<page>
        if (payload) {
          const parts = payload.split('_');
          const page = parseInt(parts[parts.length - 1], 10);
          const routerPart = parts.slice(0, -1).join('_');
          const routerName = routerPart === 'all' ? null : decodeURIComponent(routerPart);
          await sendBackupFilesList(chatId, routerName, page);
        }
        break;
      default:
        if (action.startsWith('files_')) {
          // Handle files_<routerName> pattern
          const routerName = action.replace('files_', '');
          if (routerName === 'all') {
            await sendBackupFilesList(chatId);
          } else {
            await sendBackupFilesList(chatId, decodeURIComponent(routerName));
          }
        } else {
          await bot.sendMessage(chatId, 'Perintah tidak dikenal.');
        }
      }
      
      // Answer callback query for quick operations
      if (!isLongOperation) {
        try {
          await bot.answerCallbackQuery(query.id);
        } catch (err) {
          // Ignore expired query errors
          if (err.code !== 'ETELEGRAM' || !err.message.includes('query is too old')) {
            logger.warn(`Error answering callback query: ${err.message}`);
          }
        }
      }
    } catch (err) {
      // Handle errors gracefully
      const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
      try {
        await bot.sendMessage(chatId, `❌ Error: ${sanitizedMsg}`);
      } catch (sendErr) {
        if (!isNetworkError(sendErr)) {
          logger.error('Error sending error message', sendErr);
        }
      }
      
      // Try to answer callback query even on error
      if (!isLongOperation) {
        try {
          await bot.answerCallbackQuery(query.id, { text: 'Terjadi error' });
        } catch (answerErr) {
          // Ignore expired query errors
          if (answerErr.code !== 'ETELEGRAM' || !answerErr.message.includes('query is too old')) {
            logger.warn(`Failed to answer callback query on error: ${answerErr.message}`);
          }
        }
      }
    }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (!ensureChatAllowed(chatId)) return;
  
  // Handle keyboard button presses
  if (msg.text && !msg.text.startsWith('/')) {
    const text = msg.text.trim();
    
    // Check if it's a keyboard button
    switch (text) {
      case '📊 Status Backup':
        await sendStatusMessage(chatId);
        return;
      case '💾 Backup':
        await sendBackup(chatId, false);
        return;
      case '⚙️ Setting Auto Backup':
        await sendAutoBackupSettings(chatId);
        return;
      case '⬅️ Kembali ke Menu':
        await sendMainMenu(chatId);
        return;
      case '▶️ Aktifkan Auto Backup':
        if (!config.telegram.defaultChatId) {
          await bot.sendMessage(
            chatId,
            '❌ Gagal: TELEGRAM_DEFAULT_CHAT_ID belum diatur. Silakan set di file .env terlebih dahulu.'
          );
          return;
        }
        // Stop existing job if any
        if (scheduledJob) {
          scheduledJob.stop();
          scheduledJob = null;
        }
        // Start new scheduled job
        await scheduleJob();
        await bot.sendMessage(chatId, '✅ Auto backup telah diaktifkan.');
        await sendAutoBackupSettings(chatId);
        return;
      case '⏸️ Nonaktifkan Auto Backup':
        if (scheduledJob) {
          scheduledJob.stop();
          scheduledJob = null;
          await bot.sendMessage(chatId, '✅ Auto backup telah dinonaktifkan.');
        } else {
          await bot.sendMessage(chatId, 'ℹ️ Auto backup sudah dalam keadaan nonaktif.');
        }
        await sendAutoBackupSettings(chatId);
        return;
      case '🕐 Atur Jadwal Backup':
        await startScheduleSettingFlow(chatId);
        return;
      case '📋 Daftar Router':
        await sendRouterListMessage(chatId);
        return;
      case '➕ Tambah Router':
        await startAddRouterFlow(chatId);
        return;
      case '➖ Hapus Router':
        await sendRouterSelection(chatId, 'remove_router', 'Belum ada router untuk dihapus.');
        return;
      case '🧪 Test Koneksi Router':
        await sendRouterSelection(chatId, 'test_router', 'Belum ada router untuk diuji.');
        return;
      case '📁 File Backup':
        await sendFileBackupMenu(chatId);
        return;
    }
    
    // Handle session input if session exists
    if (sessions.has(chatId)) {
      await handleSessionInput(chatId, msg.text);
      return;
    }
  }
});

// Track polling errors to avoid spam logging
let lastPollingError = null;
let pollingErrorCount = 0;
let pollingErrorLastLog = 0;

bot.on('polling_error', (err) => {
  const now = Date.now();
  const errorKey = err.code || 'UNKNOWN';
  
  // Reset counter if error type changed or 5 minutes passed
  if (lastPollingError !== errorKey || (now - pollingErrorLastLog) > 5 * 60 * 1000) {
    pollingErrorCount = 0;
    lastPollingError = errorKey;
  }
  
  pollingErrorCount++;
  
  // Only log every 10th error or if it's a new error type
  if (pollingErrorCount === 0 || pollingErrorCount % 10 === 0) {
    // Handle different types of errors
    if (isNetworkError(err)) {
      if (pollingErrorCount === 1) {
        logger.warn('Network error detected. Bot will continue polling...');
      } else {
        logger.warn(`Network error (${pollingErrorCount}x). Bot continues polling...`);
      }
      // Bot will automatically retry polling
    } else if (err.response && err.response.statusCode === 429) {
      // Rate limit error
      const retryAfter = err.response.headers['retry-after'] || 60;
      logger.warn(`Rate limit exceeded. Will retry after ${retryAfter} seconds.`);
      pollingErrorCount = 0; // Reset counter for rate limit
    } else {
      if (pollingErrorCount === 1) {
        logger.error('Polling error', err);
      } else {
        logger.warn(`Polling error (${pollingErrorCount}x): ${err.message || 'Unknown error'}`);
      }
    }
    pollingErrorLastLog = now;
  }
});

// Handle webhook errors if using webhook mode
bot.on('error', (err) => {
  logger.error('Bot error', err);
});

fs.ensureDirSync(config.backup.directory);

// Start download server if enabled
if (config.downloadServer.enabled) {
  try {
    startDownloadServer();
    logger.info(`Download server started on 0.0.0.0:${config.downloadServer.port}`);
    logger.info(`Download server URL: ${config.downloadServer.baseUrl}`);
  } catch (err) {
    logger.error('Failed to start download server', err);
  }
} else {
  logger.info('Download server disabled');
}

// Load custom schedule on startup
loadCustomSchedule().then(async () => {
  await scheduleJob();
}).catch(async (err) => {
  logger.error('Failed to load custom schedule on startup', err);
  await scheduleJob();
});

