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
    try {
      console.log(`[saveHistory] Writing ${list.length} records to history file`);
      // Write to temporary file first, then rename (atomic operation)
      const tempPath = `${historyPath}.tmp`;
      await fs.writeJSON(tempPath, list, { spaces: 2 });
      console.log(`[saveHistory] Temp file written: ${tempPath}`);
      // Use rename for atomic operation (works on most filesystems)
      if (await fs.pathExists(historyPath)) {
        await fs.remove(historyPath);
      }
      await fs.rename(tempPath, historyPath);
      console.log(`[saveHistory] History file saved successfully: ${historyPath}`);
    } catch (err) {
      console.error('[saveHistory] Error saving history:', err);
      console.error('[saveHistory] Error stack:', err.stack);
      // Clean up temp file if it exists
      await fs.remove(`${historyPath}.tmp`).catch(() => {});
      throw err;
    }
  }).catch((err) => {
    console.error('[saveHistory] Queue error:', err);
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

  console.log(`[addBackupRecord] Adding record with ${record.routers.length} routers`);
  console.log(`[addBackupRecord] Router names:`, record.routers.map(r => r.name));

  // Use queue to prevent race condition when reading and writing
  return new Promise((resolve, reject) => {
    writeQueue = writeQueue.then(async () => {
      try {
        const history = await getHistory();
        console.log(`[addBackupRecord] Current history length: ${history.length}`);
        // Add new record at the beginning (most recent first)
        history.unshift(record);
        // Keep only last 1000 records to prevent file from growing too large
        if (history.length > 1000) {
          history.splice(1000);
        }
        console.log(`[addBackupRecord] About to save ${history.length} records`);
        await saveHistory(history);
        console.log(`[addBackupRecord] History saved successfully. New length: ${history.length}`);
        
        // Verify save by reading back
        const verifyHistory = await getHistory();
        console.log(`[addBackupRecord] Verification read: ${verifyHistory.length} records`);
        if (verifyHistory.length !== history.length) {
          console.error(`[addBackupRecord] WARNING: History length mismatch! Expected ${history.length}, got ${verifyHistory.length}`);
        }
        
        resolve(record);
      } catch (err) {
        console.error(`[addBackupRecord] Error saving history:`, err);
        console.error(`[addBackupRecord] Error stack:`, err.stack);
        reject(err);
      }
    }).catch((err) => {
      console.error(`[addBackupRecord] Queue promise error:`, err);
      reject(err);
    });
  });
}

async function getRouterHistory(routerName, limit = 50) {
  const history = await getHistory();
  
  // Debug logging
  console.log(`[getRouterHistory] Looking for router: "${routerName}"`);
  console.log(`[getRouterHistory] Total history records: ${history.length}`);
  if (history.length > 0) {
    console.log(`[getRouterHistory] First record routers:`, history[0].routers.map(r => r.name));
  }
  
  const routerHistory = history
    .filter((record) => {
      // Use trim and case-insensitive matching for router name
      const found = record.routers.some((r) => {
        const rName = (r.name || '').trim();
        const searchName = (routerName || '').trim();
        return rName === searchName;
      });
      return found;
    })
    .map((record) => {
      // Use trim and case-insensitive matching
      const routerResult = record.routers.find((r) => {
        const rName = (r.name || '').trim();
        const searchName = (routerName || '').trim();
        return rName === searchName;
      });
      if (!routerResult) {
        console.warn(`[getRouterHistory] Router result not found for "${routerName}"`);
        return null;
      }
      return {
        timestamp: record.timestamp,
        success: routerResult.success,
        error: routerResult.error,
        triggeredBySchedule: record.triggeredBySchedule || false,
      };
    })
    .filter(Boolean) // Remove null entries
    .slice(0, limit);
  
  console.log(`[getRouterHistory] Found ${routerHistory.length} records for router "${routerName}"`);
  
  return routerHistory;
}

async function getStatistics(routerName = null) {
  const history = await getHistory();
  
  console.log(`[getStatistics] Total history records: ${history.length}`);
  if (history.length > 0) {
    console.log(`[getStatistics] Sample record routers:`, history[0].routers?.map(r => r.name) || 'no routers');
  }
  
  if (routerName) {
    // Statistics for specific router
    // Use trim for matching
    const searchName = (routerName || '').trim();
    const routerRecords = history
      .map((record) => {
        return record.routers.find((r) => {
          const rName = (r.name || '').trim();
          return rName === searchName;
        });
      })
      .filter(Boolean);
    
    console.log(`[getStatistics] Looking for router: "${routerName}" (trimmed: "${searchName}")`);
    console.log(`[getStatistics] Total history records: ${history.length}`);
    console.log(`[getStatistics] Found ${routerRecords.length} matching records`);
    
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
  getHistory, // Export for debug
};

