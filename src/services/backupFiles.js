const path = require('path');
const fs = require('fs-extra');
const config = require('../config');
const { format, parse } = require('date-fns');

// Safe name for file system (same as mikrotikService)
const safeName = (name = 'router') =>
  name.replace(/[^a-zA-Z0-9-_]/g, '_') || 'router';

// Parse timestamp from filename: routerName_backup_yyyyMMdd_HHmmss.backup
function parseTimestampFromFilename(filename) {
  const match = filename.match(/_(\d{8}_\d{6})\./);
  if (!match) return null;
  
  try {
    const timestampStr = match[1];
    const year = parseInt(timestampStr.substring(0, 4), 10);
    const month = parseInt(timestampStr.substring(4, 6), 10) - 1; // Month is 0-indexed
    const day = parseInt(timestampStr.substring(6, 8), 10);
    const hour = parseInt(timestampStr.substring(9, 11), 10);
    const minute = parseInt(timestampStr.substring(11, 13), 10);
    const second = parseInt(timestampStr.substring(13, 15), 10);
    
    return new Date(year, month, day, hour, minute, second);
  } catch (err) {
    return null;
  }
}

// Get router name from filename: routerName_backup_yyyyMMdd_HHmmss.backup
function getRouterNameFromFilename(filename) {
  const match = filename.match(/^(.+?)_(?:backup|export)_/);
  return match ? match[1] : null;
}

async function getBackupFiles(routerName = null) {
  const backupDir = config.backup.directory;
  
  if (!(await fs.pathExists(backupDir))) {
    return [];
  }
  
  const files = [];
  
  if (routerName) {
    // Get files for specific router
    const routerDir = path.join(backupDir, routerName);
    if (!(await fs.pathExists(routerDir))) {
      return [];
    }
    
    const backupSubDir = path.join(routerDir, 'backup');
    const rscSubDir = path.join(routerDir, 'rsc');
    
    // Scan backup files
    if (await fs.pathExists(backupSubDir)) {
      const backupFiles = await fs.readdir(backupSubDir);
      for (const file of backupFiles) {
        if (file.endsWith('.backup')) {
          const filePath = path.join(backupSubDir, file);
          const stats = await fs.stat(filePath);
          const timestamp = parseTimestampFromFilename(file);
          
          files.push({
            routerName,
            filename: file,
            filePath,
            type: 'backup',
            size: stats.size,
            createdAt: stats.birthtime || stats.mtime,
            timestamp: timestamp || stats.birthtime || stats.mtime,
          });
        }
      }
    }
    
    // Scan rsc files
    if (await fs.pathExists(rscSubDir)) {
      const rscFiles = await fs.readdir(rscSubDir);
      for (const file of rscFiles) {
        if (file.endsWith('.rsc')) {
          const filePath = path.join(rscSubDir, file);
          const stats = await fs.stat(filePath);
          const timestamp = parseTimestampFromFilename(file);
          
          files.push({
            routerName,
            filename: file,
            filePath,
            type: 'rsc',
            size: stats.size,
            createdAt: stats.birthtime || stats.mtime,
            timestamp: timestamp || stats.birthtime || stats.mtime,
          });
        }
      }
    }
  } else {
    // Get files for all routers
    const routerDirs = await fs.readdir(backupDir);
    
    for (const dir of routerDirs) {
      const routerDirPath = path.join(backupDir, dir);
      const stats = await fs.stat(routerDirPath);
      
      if (stats.isDirectory()) {
        const routerFiles = await getBackupFiles(dir);
        files.push(...routerFiles);
      }
    }
  }
  
  // Sort by timestamp (newest first)
  files.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  
  return files;
}

async function getBackupFilesByRouter(routerName, limit = 50) {
  // Convert router name to safe name for file system lookup
  const safeRouterName = safeName(routerName);
  const allFiles = await getBackupFiles(safeRouterName);
  // Map back to original router name for display
  return allFiles.map(file => ({
    ...file,
    routerName: routerName, // Use original name for display
  })).slice(0, limit);
}

async function deleteBackupFile(filePath) {
  try {
    await fs.remove(filePath);
    return true;
  } catch (err) {
    // Error will be thrown and handled by caller
    throw err;
  }
}

async function deleteBackupPair(backupFilePath) {
  // Delete both .backup and .rsc files with same timestamp
  const backupDir = path.dirname(backupFilePath);
  const filename = path.basename(backupFilePath);
  const timestampMatch = filename.match(/_(\d{8}_\d{6})\./);
  
  if (!timestampMatch) {
    // If can't parse timestamp, just delete the single file
    return await deleteBackupFile(backupFilePath);
  }
  
  const timestamp = timestampMatch[1];
  const routerName = getRouterNameFromFilename(filename);
  
  if (!routerName) {
    return await deleteBackupFile(backupFilePath);
  }
  
  const routerDir = path.dirname(backupDir);
  const backupSubDir = path.join(routerDir, 'backup');
  const rscSubDir = path.join(routerDir, 'rsc');
  
  const deletedFiles = [];
  
  // Delete backup file
  const backupFile = path.join(backupSubDir, `${routerName}_backup_${timestamp}.backup`);
  if (await fs.pathExists(backupFile)) {
    await deleteBackupFile(backupFile);
    deletedFiles.push(backupFile);
  }
  
  // Delete rsc file
  const rscFile = path.join(rscSubDir, `${routerName}_export_${timestamp}.rsc`);
  if (await fs.pathExists(rscFile)) {
    await deleteBackupFile(rscFile);
    deletedFiles.push(rscFile);
  }
  
  return deletedFiles;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

module.exports = {
  getBackupFiles,
  getBackupFilesByRouter,
  deleteBackupFile,
  deleteBackupPair,
  formatFileSize,
  parseTimestampFromFilename,
};

