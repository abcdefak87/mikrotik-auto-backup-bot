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
      stream
        .on('close', (code) => {
          if (code !== 0 && stderr) {
            reject(new Error(stderr.trim()));
          } else {
            resolve(stdout.trim());
          }
        })
        .on('data', (data) => {
          stdout += data.toString();
        })
        .stderr.on('data', (data) => {
          stderr += data.toString();
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

  const routerName = safeName(router.name || router.host);
  const timestamp = format(new Date(), 'yyyyMMdd_HHmmss');
  const backupName = `${routerName}_backup_${timestamp}`;
  const exportName = `${routerName}_export_${timestamp}`;
  const remoteBackup = `/${backupName}.backup`;
  const remoteExport = `/${exportName}.rsc`;
  const routerDir = path.join(config.backup.directory, routerName);
  const localBackup = path.join(routerDir, `${backupName}.backup`);
  const localExport = path.join(routerDir, `${exportName}.rsc`);

  await fs.ensureDir(routerDir);

  const conn = await connectSsh(router);
  try {
    await execCommand(conn, `/system backup save name=${backupName}`);
    await execCommand(conn, `/export file=${exportName}`);

    const sftp = await getSftp(conn);
    await downloadFile(sftp, remoteBackup, localBackup);
    await downloadFile(sftp, remoteExport, localExport);

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

