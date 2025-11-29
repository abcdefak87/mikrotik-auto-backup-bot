const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');
const { createReadStream } = require('fs');
const config = require('./config');
const { performBackup, testConnection } = require('./services/mikrotikService');
const {
  getRouters,
  addRouter,
  removeRouter,
} = require('./services/routerStore');

if (!config.telegram.token) {
  console.error(
    'Missing TELEGRAM_BOT_TOKEN. Set it in telegram-bot/.env before running.'
  );
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

// Load custom schedule from file on startup
const scheduleFilePath = path.join(__dirname, '..', 'data', 'customSchedule.json');
async function loadCustomSchedule() {
  try {
    if (await fs.pathExists(scheduleFilePath)) {
      const data = await fs.readJSON(scheduleFilePath);
      customSchedule = data.schedule || null;
      if (customSchedule) {
        console.log(`Loaded custom schedule: ${customSchedule}`);
      }
    }
  } catch (err) {
    console.warn('Failed to load custom schedule:', err.message);
  }
}

async function saveCustomSchedule() {
  try {
    await fs.ensureDir(path.dirname(scheduleFilePath));
    await fs.writeJSON(scheduleFilePath, { schedule: customSchedule }, { spaces: 2 });
  } catch (err) {
    console.error('Failed to save custom schedule:', err.message);
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
    console.warn('No chat ID available for backup delivery.');
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
    ? `Menjalankan backup terjadwal (${targetRouters.length} router)...`
    : `Menjalankan backup (${targetRouters.length} router)...`;
  try {
    await bot.sendMessage(chatId, notifyMessage);
  } catch (err) {
    // Only log if it's not a network error (to avoid spam)
    if (!isNetworkError(err)) {
      console.error('Failed to send backup notification:', err.message || err);
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
          console.error(`Failed to send backup document for ${router.name}:`, docErr.message || docErr);
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
              console.error('Failed to send error message:', msgErr.message || msgErr);
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
          console.error(`Failed to send export document for ${router.name}:`, docErr.message || docErr);
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
              console.error('Failed to send error message:', msgErr.message || msgErr);
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
        name: router.name,
        success: true,
      });
    } catch (err) {
      const sanitizedError = sanitizeError(err);
      // Only log if it's not a network error (to avoid spam)
      if (!isNetworkError(err)) {
        console.error('Backup error:', sanitizedError);
      }
      const errorMessage = sanitizeError(err.message || 'Tidak diketahui');
      summary.push({
        name: router.name,
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
            console.error('Failed to send backup error message:', msgErr.message || msgErr);
          }
        }
      }
    }
  }

  lastBackupMeta = {
    successAt: new Date(),
    routers: summary,
  };

  const successCount = summary.filter((s) => s.success).length;
  try {
    await bot.sendMessage(
      chatId,
      `Backup selesai ${formatDate(
        lastBackupMeta.successAt,
        config.backup.timezone
      )}. Berhasil: ${successCount}, Gagal: ${summary.length - successCount}.`
    );
  } catch (err) {
    // Silently fail if network is down (to avoid spam)
    if (!isNetworkError(err)) {
      console.error('Failed to send backup summary:', err.message || err);
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
    console.warn(
      'TELEGRAM_DEFAULT_CHAT_ID belum diatur. Backup terjadwal tidak akan dikirim.'
    );
    return;
  }

  // Use custom schedule if set, otherwise use default from config
  const schedule = cronSchedule || customSchedule || config.backup.cronSchedule;
  
  // Validate and fix timezone
  let timezone = config.backup.timezone;
  if (!isValidTimezone(timezone)) {
    console.warn(`Invalid timezone "${timezone}", falling back to "Asia/Jakarta"`);
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
    console.error(`Failed to schedule job with timezone "${timezone}":`, err.message);
    // Fallback to UTC if timezone fails
    console.warn('Falling back to UTC timezone');
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

  console.log(
    `Backup otomatis aktif setiap "${schedule}" (${timezone})`
  );
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
    console.error('Error calculating next run time:', err);
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
  const routers = await getRouters();
  const nextRun = getNextRunTime();
  const routerLines = routers.length
    ? routers
        .map(
          (r) => `- ${r.name}: ${r.host}:${r.port || 22} (${r.username})`
        )
        .join('\n')
    : '- Belum ada router';

  const lastSummary = lastBackupMeta?.routers
    ?.map(
      (r) => `  * ${r.name}: ${r.success ? '✅ Berhasil' : `❌ ${r.error}`}`
    )
    .join('\n');

  const response = [
    `Total router: ${routers.length}`,
    routerLines,
    `Folder lokal: ${config.backup.directory}`,
    `Jadwal cron: ${config.backup.cronSchedule} (${config.backup.timezone})`,
    `Backup terakhir: ${
      lastBackupMeta?.successAt
        ? formatDate(lastBackupMeta.successAt, config.backup.timezone)
        : 'Belum pernah'
    }`,
    lastSummary ? `Ringkasan:\n${lastSummary}` : null,
    `Backup berikut: ${
      nextRun ? formatDate(nextRun, config.backup.timezone) : 'Tidak terjadwal / menunggu konfigurasi'
    }`,
  ]
    .filter(Boolean)
    .join('\n');

  await bot.sendMessage(chatId, response);
}

async function sendRouterListMessage(chatId) {
  const routers = await getRouters();
  if (!routers.length) {
    await bot.sendMessage(chatId, 'Belum ada router terdaftar.');
    return;
  }
  const lines = routers
    .map(
      (r, idx) =>
        `${idx + 1}. ${r.name} - ${r.host}:${r.port || 22} (${r.username})`
    )
    .join('\n');
  await bot.sendMessage(chatId, `Daftar router:\n${lines}`);
}


async function sendAutoBackupSettings(chatId) {
  const routers = await getRouters();
  const isEnabled = scheduledJob !== null;
  const nextRun = getNextRunTime();
  const currentSchedule = customSchedule || config.backup.cronSchedule;
  const readableTime = cronToTime(currentSchedule) || currentSchedule;
  
  const statusText = isEnabled 
    ? `✅ Aktif\nWaktu: ${readableTime} (setiap hari)\nTimezone: ${config.backup.timezone}\nBackup berikut: ${nextRun ? formatDate(nextRun, config.backup.timezone) : 'Tidak diketahui'}`
    : `❌ Nonaktif\nWaktu: ${readableTime} (setiap hari)\nTimezone: ${config.backup.timezone}\nBelum ada jadwal backup otomatis yang diaktifkan.`;

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
    `⚙️ Setting Auto Backup\n\n${statusText}\n\nTotal router: ${routers.length}`,
    {
      reply_markup: {
        keyboard,
        resize_keyboard: true,
        one_time_keyboard: false,
      },
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
      'Atur jadwal backup otomatis.\n\nMasukkan waktu backup dalam format:\n**HH:MM** (24 jam)\n\nContoh:\n- `18:00` = Setiap hari jam 18:00\n- `00:00` = Setiap hari jam 00:00 (tengah malam)\n- `09:30` = Setiap hari jam 09:30\n\nMasukkan waktu (HH:MM):'
    );
  } catch (err) {
    console.error('Failed to send message in startScheduleSettingFlow:', err);
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
    console.error('Failed to send message in startAddRouterFlow:', err);
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
    console.log(`Auto-cleaning session for chatId: ${chatId} (timeout after 30 minutes)`);
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
          console.error('Failed to send message:', err);
        }
        return;
      }
      session.data.name = value;
      session.step = 'host';
      try {
        await bot.sendMessage(chatId, 'Masukkan host/IP router (contoh: 192.168.88.1):');
      } catch (err) {
        console.error('Failed to send message:', err);
      }
      return;
    }
    if (session.step === 'host') {
      if (!value) {
        try {
          await bot.sendMessage(chatId, 'Host/IP tidak boleh kosong. Silakan masukkan host/IP router:');
        } catch (err) {
          console.error('Failed to send message:', err);
        }
        return;
      }
      if (!isValidHost(value)) {
        try {
          await bot.sendMessage(chatId, 'Format host/IP tidak valid. Silakan masukkan IP address (contoh: 192.168.88.1) atau hostname (contoh: router.example.com):');
        } catch (err) {
          console.error('Failed to send message:', err);
        }
        return;
      }
      session.data.host = value.trim();
      session.step = 'username';
      try {
        await bot.sendMessage(chatId, 'Masukkan username router:');
      } catch (err) {
        console.error('Failed to send message:', err);
      }
      return;
    }
    if (session.step === 'username') {
      if (!value) {
        try {
          await bot.sendMessage(chatId, 'Username tidak boleh kosong. Silakan masukkan username router:');
        } catch (err) {
          console.error('Failed to send message:', err);
        }
        return;
      }
      session.data.username = value;
      session.step = 'password';
      try {
        await bot.sendMessage(chatId, 'Masukkan password router:');
      } catch (err) {
        console.error('Failed to send message:', err);
      }
      return;
    }
    if (session.step === 'password') {
      if (!value) {
        try {
          await bot.sendMessage(chatId, 'Password tidak boleh kosong. Silakan masukkan password router:');
        } catch (err) {
          console.error('Failed to send message:', err);
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
        console.error('Failed to send message:', err);
      }
      return;
    }
    if (session.step === 'port') {
      const port = value ? Number(value) : 22;
      if (Number.isNaN(port) || port <= 0 || port > 65535) {
        try {
          await bot.sendMessage(chatId, 'Port tidak valid. Masukkan angka antara 1-65535.');
        } catch (err) {
          console.error('Failed to send message:', err);
        }
        return;
      }
      session.data.port = port;
      
      // Validate required fields
      if (!session.data.name || !session.data.host || !session.data.username || !session.data.password) {
        try {
          await bot.sendMessage(chatId, 'Data router tidak lengkap. Silakan mulai lagi.');
        } catch (err) {
          console.error('Failed to send message:', err);
        }
        clearSession(chatId);
        try {
          await sendMainMenu(chatId);
        } catch (err) {
          console.error('Failed to send main menu:', err);
        }
        return;
      }
      
      try {
        await addRouter(session.data);
        try {
          await bot.sendMessage(
            chatId,
            `Router "${session.data.name}" berhasil ditambahkan.`
          );
        } catch (err) {
          console.error('Failed to send success message:', err);
        }
      } catch (err) {
        try {
          const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
          await bot.sendMessage(
            chatId,
            `Gagal menambah router: ${sanitizedMsg}`
          );
        } catch (sendErr) {
          console.error('Failed to send error message:', sendErr);
        }
      } finally {
        clearSession(chatId);
        try {
          await sendMainMenu(chatId);
        } catch (err) {
          console.error('Failed to send main menu:', err);
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
          console.error('Failed to send message:', err);
        }
        return;
      }
      
      // Convert time to cron expression
      const cronExpression = timeToCron(value);
      if (!cronExpression) {
        try {
          await bot.sendMessage(chatId, '❌ Format waktu tidak valid.\n\nGunakan format: **HH:MM** (24 jam)\n\nContoh:\n- `18:00` = Setiap hari jam 18:00\n- `09:30` = Setiap hari jam 09:30\n\nSilakan masukkan lagi:');
        } catch (err) {
          console.error('Failed to send message:', err);
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
            console.error('Failed to send message:', err);
          }
        } else {
          try {
            await bot.sendMessage(chatId, `✅ Jadwal backup berhasil diatur: **${value}** (setiap hari)\nAktifkan auto backup untuk menggunakan jadwal ini.`);
          } catch (err) {
            console.error('Failed to send message:', err);
          }
        }
      } catch (err) {
        try {
          const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
          await bot.sendMessage(chatId, `❌ Gagal mengatur jadwal: ${sanitizedMsg}\nSilakan coba lagi dengan format HH:MM`);
        } catch (sendErr) {
          console.error('Failed to send message:', sendErr);
        }
        return;
      }
      
      clearSession(chatId);
      try {
        await sendAutoBackupSettings(chatId);
      } catch (err) {
        console.error('Failed to send auto backup settings:', err);
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
    await bot.sendMessage(chatId, `Koneksi ke "${router.name}" OK.`);
  } catch (err) {
    const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
    await bot.sendMessage(
      chatId,
      `Koneksi ke "${router.name}" gagal: ${sanitizedMsg}`
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

bot.on('callback_query', async (query) => {
  if (!query.message) return;
  const chatId = query.message.chat.id;
  if (!ensureChatAllowed(chatId)) {
    await bot.answerCallbackQuery(query.id, { text: 'Tidak diizinkan.' });
    return;
  }

  const { action, payload } = parseCallbackData(query.data);

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
            await bot.sendMessage(chatId, `Router "${payload}" dihapus.`);
          } catch (err) {
            const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
            await bot.sendMessage(
              chatId,
              `Gagal menghapus router: ${sanitizedMsg}`
            );
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
            await bot.sendMessage(chatId, `Koneksi ke "${router.name}" OK.`);
          } catch (err) {
            const sanitizedMsg = sanitizeError(err.message || 'Tidak diketahui');
            await bot.sendMessage(
              chatId,
              `Koneksi ke "${router.name}" gagal: ${sanitizedMsg}`
            );
          }
        }
        break;
      default:
        await bot.sendMessage(chatId, 'Perintah tidak dikenal.');
    }
  } finally {
    await bot.answerCallbackQuery(query.id);
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
        console.error('Network error detected. Bot will continue polling...');
      } else {
        console.warn(`Network error (${pollingErrorCount}x). Bot continues polling...`);
      }
      // Bot will automatically retry polling
    } else if (err.response && err.response.statusCode === 429) {
      // Rate limit error
      const retryAfter = err.response.headers['retry-after'] || 60;
      console.error(`Rate limit exceeded. Will retry after ${retryAfter} seconds.`);
      pollingErrorCount = 0; // Reset counter for rate limit
    } else {
      if (pollingErrorCount === 1) {
        console.error('Polling error:', err.message || err);
      } else {
        console.warn(`Polling error (${pollingErrorCount}x):`, err.message || 'Unknown error');
      }
    }
    pollingErrorLastLog = now;
  }
});

// Handle webhook errors if using webhook mode
bot.on('error', (err) => {
  console.error('Bot error:', err);
});

fs.ensureDirSync(config.backup.directory);

// Load custom schedule on startup
loadCustomSchedule().then(async () => {
  await scheduleJob();
  console.log('Telegram bot berjalan. Tekan Ctrl+C untuk berhenti.');
}).catch(async (err) => {
  console.error('Failed to load custom schedule on startup:', err);
  await scheduleJob();
  console.log('Telegram bot berjalan. Tekan Ctrl+C untuk berhenti.');
});

