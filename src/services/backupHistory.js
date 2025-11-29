const path = require('path');
const fs = require('fs-extra');

const dataDir = path.join(__dirname, '..', '..', 'data');
const historyPath = path.join(dataDir, 'backupHistory.json');

// Simple queue-based locking mechanism to prevent race conditions
let writeQueue = Promise.resolve();

async function ensureStore() {
  await fs.ensureDir(dataDir);
  if (!(await fs.pathExists(historyPath))) {
    await fs.writeJSON(historyPath, [], { spaces: 2 });
  }
}

async function getHistory() {
  await ensureStore();
  try {
    const history = await fs.readJSON(historyPath);
    // Validate that it's an array
    if (!Array.isArray(history)) {
      console.warn('backupHistory.json is not an array, resetting to empty array');
      await saveHistory([]);
      return [];
    }
    return history;
  } catch (err) {
    // If JSON is corrupted, reset to empty array
    if (err.name === 'SyntaxError' || err.code === 'ENOENT') {
      console.warn('backupHistory.json is corrupted or missing, resetting to empty array');
      await saveHistory([]);
      return [];
    }
    throw err;
  }
}

async function saveHistory(list) {
  await ensureStore();
  // Use queue to prevent concurrent writes (race condition fix)
  writeQueue = writeQueue.then(async () => {
    // Write to temporary file first, then rename (atomic operation)
    const tempPath = `${historyPath}.tmp`;
    await fs.writeJSON(tempPath, list, { spaces: 2 });
    // Use rename for atomic operation (works on most filesystems)
    if (await fs.pathExists(historyPath)) {
      await fs.remove(historyPath);
    }
    await fs.rename(tempPath, historyPath);
  }).catch((err) => {
    console.error('Error saving backup history:', err);
    // Clean up temp file if it exists
    fs.remove(`${historyPath}.tmp`).catch(() => {});
    throw err;
  });
  await writeQueue;
}

async function addBackupRecord(record) {
  // Validate required fields
  if (!record || typeof record !== 'object') {
    throw new Error('Data backup record tidak valid');
  }
  if (!record.timestamp || !record.routers || !Array.isArray(record.routers)) {
    throw new Error('Backup record harus memiliki timestamp dan routers array');
  }

  // Use queue to prevent race condition when reading and writing
  return new Promise((resolve, reject) => {
    writeQueue = writeQueue.then(async () => {
      try {
        const history = await getHistory();
        // Add new record at the beginning (most recent first)
        history.unshift(record);
        // Keep only last 1000 records to prevent file from growing too large
        if (history.length > 1000) {
          history.splice(1000);
        }
        await saveHistory(history);
        resolve(record);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function getRouterHistory(routerName, limit = 50) {
  const history = await getHistory();
  const routerHistory = history
    .filter((record) => 
      record.routers.some((r) => r.name === routerName)
    )
    .map((record) => {
      const routerResult = record.routers.find((r) => r.name === routerName);
      return {
        timestamp: record.timestamp,
        success: routerResult.success,
        error: routerResult.error,
        triggeredBySchedule: record.triggeredBySchedule || false,
      };
    })
    .slice(0, limit);
  
  return routerHistory;
}

async function getStatistics(routerName = null) {
  const history = await getHistory();
  
  if (routerName) {
    // Statistics for specific router
    const routerRecords = history
      .map((record) => record.routers.find((r) => r.name === routerName))
      .filter(Boolean);
    
    if (routerRecords.length === 0) {
      return {
        total: 0,
        success: 0,
        failed: 0,
        successRate: 0,
        lastBackup: null,
        consecutiveFailures: 0,
      };
    }
    
    const total = routerRecords.length;
    const success = routerRecords.filter((r) => r.success).length;
    const failed = total - success;
    const successRate = total > 0 ? ((success / total) * 100).toFixed(1) : 0;
    
    // Find last successful backup with timestamp from history
    let lastSuccessfulBackup = null;
    for (const record of history) {
      const routerResult = record.routers.find((r) => r.name === routerName);
      if (routerResult && routerResult.success) {
        lastSuccessfulBackup = {
          timestamp: record.timestamp,
          success: true,
        };
        break;
      }
    }
    
    // Calculate consecutive failures (from most recent)
    let consecutiveFailures = 0;
    for (const record of routerRecords) {
      if (!record.success) {
        consecutiveFailures++;
      } else {
        break;
      }
    }
    
    return {
      total,
      success,
      failed,
      successRate,
      lastBackup: lastSuccessfulBackup,
      consecutiveFailures,
    };
  } else {
    // Overall statistics
    const allRouterResults = history.flatMap((record) => record.routers);
    const total = allRouterResults.length;
    const success = allRouterResults.filter((r) => r.success).length;
    const failed = total - success;
    const successRate = total > 0 ? ((success / total) * 100).toFixed(1) : 0;
    
    return {
      total,
      success,
      failed,
      successRate,
      totalBackups: history.length,
    };
  }
}

module.exports = {
  addBackupRecord,
  getRouterHistory,
  getStatistics,
  getHistory,
};

