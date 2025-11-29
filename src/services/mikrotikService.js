const { Client } = require('ssh2');
const fs = require('fs-extra');
const path = require('path');
const { format } = require('date-fns');
const config = require('../config');

const DEFAULT_PORT = 22;

const safeName = (name = 'router') =>
  name.replace(/[^a-zA-Z0-9-_]/g, '_') || 'router';

const connectSsh = (router) =>
  new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', (err) => reject(err))
      .connect({
        host: router.host,
        port: router.port || DEFAULT_PORT,
        username: router.username,
        password: router.password,
        readyTimeout: 10000,
      });
  });

const execCommand = (conn, command) =>
  new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      
      // Handle stderr if available
      if (stream.stderr) {
        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }
      
      stream
        .on('close', (code) => {
          // Reject if exit code is non-zero, even if stderr is empty
          if (code !== 0) {
            const errorMsg = stderr.trim() || stdout.trim() || `Command failed with exit code ${code}`;
            reject(new Error(errorMsg));
          } else {
            resolve(stdout.trim());
          }
        })
        .on('data', (data) => {
          stdout += data.toString();
        })
        .on('error', (err) => {
          reject(err);
        });
    });
  });

const getSftp = (conn) =>
  new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      resolve(sftp);
    });
  });

const downloadFile = (sftp, remotePath, localPath) =>
  new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, {}, (err) => {
      if (err) return reject(err);
      resolve(localPath);
    });
  });

async function performBackup(router) {
  if (!router) {
    throw new Error('Router tidak valid');
  }
  
  if (!router.host || !router.username || !router.password) {
    throw new Error('Router harus memiliki host, username, dan password');
  }

  const routerName = safeName(router.name || router.host);
  const timestamp = format(new Date(), 'yyyyMMdd_HHmmss');
  const backupName = `${routerName}_backup_${timestamp}`;
  const exportName = `${routerName}_export_${timestamp}`;
  const remoteBackupFile = `${backupName}.backup`;
  const remoteExportFile = `${exportName}.rsc`;
  const remoteBackup = `/${remoteBackupFile}`;
  const remoteExport = `/${remoteExportFile}`;
  const routerDir = path.join(config.backup.directory, routerName);
  const backupDir = path.join(routerDir, 'backup');
  const exportDir = path.join(routerDir, 'export');
  const localBackup = path.join(backupDir, `${backupName}.backup`);
  const localExport = path.join(exportDir, `${exportName}.rsc`);

  await fs.ensureDir(backupDir);
  await fs.ensureDir(exportDir);

  const conn = await connectSsh(router);
  try {
    await execCommand(conn, `/system backup save name=${backupName}`);
    await execCommand(conn, `/export file=${exportName}`);

    const sftp = await getSftp(conn);
    await downloadFile(sftp, remoteBackup, localBackup);
    await downloadFile(sftp, remoteExport, localExport);
    
    // Prevent MikroTik storage from filling up with leftover artifacts.
    // Use try-catch to prevent cleanup failures from affecting backup success
    try {
      await execCommand(conn, `/file remove "${remoteBackupFile}"`);
    } catch (err) {
      console.warn(`Failed to remove remote backup file ${remoteBackupFile}:`, err.message);
    }
    try {
      await execCommand(conn, `/file remove "${remoteExportFile}"`);
    } catch (err) {
      console.warn(`Failed to remove remote export file ${remoteExportFile}:`, err.message);
    }

    return {
      label: timestamp,
      routerName: router.name || router.host,
      backupPath: localBackup,
      exportPath: localExport,
    };
  } finally {
    conn.end();
  }
}

async function testConnection(router) {
  if (!router || !router.host || !router.username || !router.password) {
    throw new Error('Router harus memiliki host, username, dan password');
  }
  
  const conn = await connectSsh(router);
  try {
    await execCommand(conn, '/system resource print');
    return true;
  } finally {
    conn.end();
  }
}

module.exports = {
  performBackup,
  testConnection,
};

