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

const bot = new TelegramBot(config.telegram.token, { polling: true });
let lastBackupMeta = null;
let scheduledJob = null;
const sessions = new Map();
let customSchedule = null; // Store custom schedule set by user

const formatDate = (date) =>
  date
    ? new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'full',
        timeStyle: 'short',
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
    console.error('Failed to send backup notification:', err);
    // Continue with backup even if notification fails
  }

  const summary = [];
  for (const router of targetRouters) {
    try {
      const result = await performBackup(router);

      // Send documents with error handling
      try {
        const backupFileName = path.basename(result.backupPath);
        const backupStream = createReadStream(result.backupPath);
        await bot.sendDocument(chatId, backupStream, {
          caption: `[${router.name}] Backup binary (${backupFileName})`,
          filename: backupFileName,
          contentType: 'application/octet-stream',
        });
      } catch (docErr) {
        console.error(`Failed to send backup document for ${router.name}:`, docErr);
        try {
          await bot.sendMessage(
            chatId,
            `[${router.name}] Backup berhasil, tetapi gagal mengirim file binary: ${docErr.message || 'Tidak diketahui'}`
          );
        } catch (msgErr) {
          console.error('Failed to send error message:', msgErr);
        }
      }
      
      try {
        const exportFileName = path.basename(result.exportPath);
        const exportStream = createReadStream(result.exportPath);
        await bot.sendDocument(chatId, exportStream, {
          caption: `[${router.name}] Backup konfigurasi (${exportFileName})`,
          filename: exportFileName,
          contentType: 'text/plain',
        });
      } catch (docErr) {
        console.error(`Failed to send export document for ${router.name}:`, docErr);
        try {
          await bot.sendMessage(
            chatId,
            `[${router.name}] Backup berhasil, tetapi gagal mengirim file export: ${docErr.message || 'Tidak diketahui'}`
          );
        } catch (msgErr) {
          console.error('Failed to send error message:', msgErr);
        }
      }

      summary.push({
        name: router.name,
        success: true,
      });
    } catch (err) {
      console.error('Backup error:', err);
      summary.push({
        name: router.name,
        success: false,
        error: err.message || 'Tidak diketahui',
      });
      await bot.sendMessage(
        chatId,
        `[${router.name}] Backup gagal: ${err.message || 'Tidak diketahui'}`
      );
    }
  }

  lastBackupMeta = {
    successAt: new Date(),
    routers: summary,
  };

  const successCount = summary.filter((s) => s.success).length;
  await bot.sendMessage(
    chatId,
    `Backup selesai ${formatDate(
      lastBackupMeta.successAt
    )}. Berhasil: ${successCount}, Gagal: ${summary.length - successCount}.`
  );
}

function scheduleJob(cronSchedule = null) {
  if (!config.telegram.defaultChatId) {
    console.warn(
      'TELEGRAM_DEFAULT_CHAT_ID belum diatur. Backup terjadwal tidak akan dikirim.'
    );
    return;
  }

  // Use custom schedule if set, otherwise use default from config
  const schedule = cronSchedule || customSchedule || config.backup.cronSchedule;
  
  // Stop existing job if any
  if (scheduledJob) {
    scheduledJob.stop();
    scheduledJob = null;
  }

  scheduledJob = cron.schedule(
    schedule,
    () => sendBackup(config.telegram.defaultChatId, true),
    {
      timezone: config.backup.timezone,
    }
  );

  // Store custom schedule
  if (cronSchedule) {
    customSchedule = cronSchedule;
  }

  console.log(
    `Backup otomatis aktif setiap "${schedule}" (${config.backup.timezone})`
  );
}

function getNextRunTime() {
  if (!scheduledJob) return null;
  try {
    // node-cron v4: nextDates() returns an array, get first date
    const nextDates = scheduledJob.nextDates(1);
    if (nextDates && nextDates.length > 0) {
      return nextDates[0].toDate();
    }
    return null;
  } catch (err) {
    console.error('Error getting next run time:', err);
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
        ? formatDate(lastBackupMeta.successAt)
        : 'Belum pernah'
    }`,
    lastSummary ? `Ringkasan:\n${lastSummary}` : null,
    `Backup berikut: ${
      nextRun ? formatDate(nextRun) : 'Tidak terjadwal / menunggu konfigurasi'
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
  
  const statusText = isEnabled 
    ? `✅ Aktif\nJadwal: ${currentSchedule}\nTimezone: ${config.backup.timezone}\nBackup berikut: ${nextRun ? formatDate(nextRun) : 'Tidak diketahui'}`
    : `❌ Nonaktif\nJadwal: ${currentSchedule}\nTimezone: ${config.backup.timezone}\nBelum ada jadwal backup otomatis yang diaktifkan.`;

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
    step: 'cron',
    data: {},
  });
  try {
    await bot.sendMessage(
      chatId,
      'Atur jadwal backup otomatis.\n\nFormat cron: * * * * *\n(menit jam hari bulan hari-minggu)\n\nContoh:\n- `0 18 * * *` = Setiap hari jam 18:00\n- `0 0 * * 0` = Setiap Minggu jam 00:00\n- `0 0 1 * *` = Setiap tanggal 1 setiap bulan\n\nMasukkan format cron:'
    );
  } catch (err) {
    console.error('Failed to send message in startScheduleSettingFlow:', err);
    clearSession(chatId);
  }
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
}

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
      session.data.host = value;
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
          await bot.sendMessage(
            chatId,
            `Gagal menambah router: ${err.message || 'Tidak diketahui'}`
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
    if (session.step === 'cron') {
      if (!value) {
        try {
          await bot.sendMessage(chatId, 'Format cron tidak boleh kosong. Silakan masukkan format cron:');
        } catch (err) {
          console.error('Failed to send message:', err);
        }
        return;
      }
      
      // Validate cron format (basic validation)
      const cronParts = value.trim().split(/\s+/);
      if (cronParts.length !== 5) {
        try {
          await bot.sendMessage(chatId, 'Format cron tidak valid. Format harus: * * * * *\n(menit jam hari bulan hari-minggu)\n\nContoh: 0 18 * * *\nSilakan masukkan lagi:');
        } catch (err) {
          console.error('Failed to send message:', err);
        }
        return;
      }
      
      try {
        // Test if cron expression is valid by trying to create a schedule
        const testSchedule = cron.schedule(value, () => {}, { timezone: config.backup.timezone });
        testSchedule.stop();
        
        // If valid, update schedule
        customSchedule = value;
        if (scheduledJob) {
          // Restart with new schedule
          scheduleJob(value);
          try {
            await bot.sendMessage(chatId, `✅ Jadwal backup berhasil diatur: ${value}\nAuto backup akan menggunakan jadwal baru ini.`);
          } catch (err) {
            console.error('Failed to send message:', err);
          }
        } else {
          try {
            await bot.sendMessage(chatId, `✅ Jadwal backup berhasil diatur: ${value}\nAktifkan auto backup untuk menggunakan jadwal ini.`);
          } catch (err) {
            console.error('Failed to send message:', err);
          }
        }
      } catch (err) {
        try {
          await bot.sendMessage(chatId, `❌ Format cron tidak valid: ${err.message}\nSilakan masukkan format cron yang benar:\nContoh: 0 18 * * *`);
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
    await bot.sendMessage(
      chatId,
      `Koneksi ke "${router.name}" gagal: ${err.message || 'Tidak diketahui'}`
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
            await bot.sendMessage(
              chatId,
              `Gagal menghapus router: ${err.message || 'Tidak diketahui'}`
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
            await bot.sendMessage(
              chatId,
              `Koneksi ke "${router.name}" gagal: ${err.message || 'Tidak diketahui'}`
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
        scheduleJob();
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

bot.on('polling_error', (err) => {
  console.error('Polling error:', err);
});

fs.ensureDirSync(config.backup.directory);
scheduleJob();

console.log('Telegram bot berjalan. Tekan Ctrl+C untuk berhenti.');

