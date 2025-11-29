const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const { verifyToken, verifyTokenOnly } = require('./downloadTokens');
const { getBackupFilesByRouter, formatFileSize } = require('./backupFiles');
const config = require('../config');

let server = null;

function startDownloadServer() {
  if (server) {
    return; // Server already running
  }
  
  if (!config.downloadServer.enabled) {
    return; // Download server disabled
  }
  
  const app = express();
  
  // Disable express header
  app.disable('x-powered-by');
  
  // Parse form data
  app.use(express.urlencoded({ extended: true }));
  
  // Parse JSON (if needed)
  app.use(express.json());
  
  // Helper function to render file list page
  async function renderFileListPage(token, pass, tokenData, files) {
    if (files.length === 0) {
      return `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Download Backup - ${tokenData.routerName}</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .container {
              background: white;
              border-radius: 12px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.2);
              padding: 40px;
              max-width: 600px;
              width: 100%;
              text-align: center;
            }
            h1 { color: #333; margin-bottom: 20px; }
            .empty { color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>📁 File Backup: ${tokenData.routerName}</h1>
            <p class="empty">Belum ada file backup untuk router ini.</p>
          </div>
        </body>
        </html>
      `;
    }
    
    // Group files by timestamp (backup + rsc pairs)
    const fileGroups = new Map();
    for (const file of files) {
      const timestampMatch = file.filename.match(/_(\d{8}_\d{6})\./);
      if (timestampMatch) {
        const timestamp = timestampMatch[1];
        if (!fileGroups.has(timestamp)) {
          fileGroups.set(timestamp, { backup: null, rsc: null, timestamp });
        }
        if (file.type === 'backup') {
          fileGroups.get(timestamp).backup = file;
        } else if (file.type === 'rsc') {
          fileGroups.get(timestamp).rsc = file;
        }
      }
    }
    
    // Sort by timestamp (newest first)
    const sortedGroups = Array.from(fileGroups.values()).sort((a, b) => {
      return b.timestamp.localeCompare(a.timestamp);
    });
    
    // Format date for display
    function formatDate(timestamp) {
      const year = timestamp.substring(0, 4);
      const month = timestamp.substring(4, 6);
      const day = timestamp.substring(6, 8);
      const hour = timestamp.substring(9, 11);
      const minute = timestamp.substring(11, 13);
      const second = timestamp.substring(13, 15);
      return `${day}/${month}/${year} ${hour}:${minute}:${second}`;
    }
    
    // Build file list HTML
    let fileListHtml = '';
    for (const group of sortedGroups) {
      const dateStr = formatDate(group.timestamp);
      fileListHtml += `
        <div class="file-group">
          <div class="file-date">📅 ${dateStr}</div>
          <div class="file-buttons">
            ${group.backup ? `
              <a href="/download/file?token=${token}&pass=${pass}&file=${encodeURIComponent(group.backup.filePath)}" class="btn btn-backup">
                📦 Download Backup (.backup)
                <span class="file-size">${formatFileSize(group.backup.size)}</span>
              </a>
            ` : ''}
            ${group.rsc ? `
              <a href="/download/file?token=${token}&pass=${pass}&file=${encodeURIComponent(group.rsc.filePath)}" class="btn btn-rsc">
                📄 Download Export (.rsc)
                <span class="file-size">${formatFileSize(group.rsc.size)}</span>
              </a>
            ` : ''}
          </div>
        </div>
      `;
    }
    
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Download Backup - ${tokenData.routerName}</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
          }
          .container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            padding: 30px;
            max-width: 800px;
            margin: 0 auto;
          }
          h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 24px;
          }
          .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
          }
          .file-group {
            margin-bottom: 25px;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 8px;
            border-left: 4px solid #667eea;
          }
          .file-date {
            color: #333;
            font-weight: 600;
            margin-bottom: 15px;
            font-size: 16px;
          }
          .file-buttons {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .btn {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            border-radius: 6px;
            text-decoration: none;
            color: white;
            font-weight: 500;
            transition: transform 0.2s, box-shadow 0.2s;
          }
          .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
          }
          .btn-backup {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .btn-rsc {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
          }
          .file-size {
            font-size: 12px;
            opacity: 0.9;
          }
          @media (min-width: 600px) {
            .file-buttons {
              flex-direction: row;
            }
            .btn {
              flex: 1;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📁 File Backup: ${tokenData.routerName}</h1>
          <p class="subtitle">Total: ${files.length} file</p>
          ${fileListHtml}
        </div>
      </body>
      </html>
    `;
  }
  
  // Password form page (GET /download?token=xxx without password)
  // Or file list page (GET /download?token=xxx&pass=xxx with password)
  app.get('/download', async (req, res) => {
    try {
      const { token, pass } = req.query;
      
      // If password provided in query, show file list
      if (token && pass) {
        const tokenData = await verifyToken(token, pass);
        
        if (!tokenData) {
          return res.redirect(`/download?token=${token}&error=${encodeURIComponent('Password salah atau token tidak valid')}`);
        }
        
        // Get all backup files for this router
        const files = await getBackupFilesByRouter(tokenData.routerName, 100);
        const html = renderFileListPage(token, pass, tokenData, files);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      }
      
      // If no token, show error
      if (!token) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(400).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Download Error</title>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .error { color: #d32f2f; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ Token tidak ditemukan</h1>
            <p>Token diperlukan untuk mengakses halaman download.</p>
          </body>
          </html>
        `);
      }
      
      // Verify token exists (without password)
      const tokenData = await verifyTokenOnly(token);
      
      if (!tokenData) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(403).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Download Error</title>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .error { color: #d32f2f; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ Token tidak valid</h1>
            <p>Token tidak ditemukan atau sudah tidak berlaku.</p>
          </body>
          </html>
        `);
      }
      
      // Show password form
      const errorMsg = req.query.error ? decodeURIComponent(req.query.error) : '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Download Backup - ${tokenData.routerName}</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .container {
              background: white;
              border-radius: 12px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.2);
              padding: 40px;
              max-width: 400px;
              width: 100%;
            }
            h1 {
              color: #333;
              margin-bottom: 10px;
              font-size: 24px;
            }
            .subtitle {
              color: #666;
              margin-bottom: 30px;
              font-size: 14px;
            }
            .error {
              background: #fee;
              color: #c33;
              padding: 12px;
              border-radius: 6px;
              margin-bottom: 20px;
              font-size: 14px;
              display: ${errorMsg ? 'block' : 'none'};
            }
            form {
              display: flex;
              flex-direction: column;
            }
            label {
              color: #333;
              margin-bottom: 8px;
              font-weight: 500;
              font-size: 14px;
            }
            input[type="password"] {
              padding: 12px;
              border: 2px solid #e0e0e0;
              border-radius: 6px;
              font-size: 16px;
              transition: border-color 0.3s;
              margin-bottom: 20px;
            }
            input[type="password"]:focus {
              outline: none;
              border-color: #667eea;
            }
            button {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              padding: 12px;
              border: none;
              border-radius: 6px;
              font-size: 16px;
              font-weight: 600;
              cursor: pointer;
              transition: transform 0.2s, box-shadow 0.2s;
            }
            button:hover {
              transform: translateY(-2px);
              box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
            }
            button:active {
              transform: translateY(0);
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🔐 Masukkan Password</h1>
            <p class="subtitle">Router: <strong>${tokenData.routerName}</strong></p>
            <div class="error">${errorMsg}</div>
            <form method="POST" action="/download">
              <input type="hidden" name="token" value="${token}">
              <label for="password">Password:</label>
              <input type="password" id="password" name="pass" required autofocus>
              <button type="submit">Masuk</button>
            </form>
          </div>
        </body>
        </html>
      `);
      
    } catch (err) {
      console.error('Error in GET /download:', err);
      res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8').send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Download Error</title>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            .error { color: #d32f2f; }
          </style>
        </head>
        <body>
          <h1 class="error">❌ Error</h1>
          <p>Terjadi kesalahan saat memproses permintaan.</p>
          <p style="font-size: 12px; color: #999;">${err.message || 'Unknown error'}</p>
        </body>
        </html>
      `);
    }
  });
  
  // File list page (POST /download with token and password)
  app.post('/download', async (req, res) => {
    try {
      const { token, pass } = req.body;
      
      console.log('POST /download - token:', token ? 'present' : 'missing', 'pass:', pass ? 'present' : 'missing');
      
      if (!token || !pass) {
        return res.redirect(`/download?token=${token || ''}&error=${encodeURIComponent('Password diperlukan')}`);
      }
      
      const tokenData = await verifyToken(token, pass);
      
      if (!tokenData) {
        console.log('POST /download - Invalid token or password');
        return res.redirect(`/download?token=${token}&error=${encodeURIComponent('Password salah atau token tidak valid')}`);
      }
      
      console.log('POST /download - Token valid, router:', tokenData.routerName);
      
      // Get all backup files for this router
      const files = await getBackupFilesByRouter(tokenData.routerName, 100);
      console.log('POST /download - Found files:', files.length);
      
      const html = renderFileListPage(token, pass, tokenData, files);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
      
    } catch (err) {
      console.error('Error in POST /download:', err);
      res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8').send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Download Error</title>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            .error { color: #d32f2f; }
          </style>
        </head>
        <body>
          <h1 class="error">❌ Error</h1>
          <p>Terjadi kesalahan saat memproses permintaan.</p>
          <p style="font-size: 12px; color: #999;">${err.message || 'Unknown error'}</p>
        </body>
        </html>
      `);
    }
  });
  
  // File download endpoint
  app.get('/download/file', async (req, res) => {
    try {
      const { token, pass, file } = req.query;
      
      if (!token || !pass || !file) {
        return res.status(400).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Download Error</title>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .error { color: #d32f2f; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ Parameter tidak lengkap</h1>
            <p>Token, password, dan file diperlukan untuk mengunduh file.</p>
          </body>
          </html>
        `);
      }
      
      const tokenData = await verifyToken(token, pass);
      
      if (!tokenData) {
        return res.status(403).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Download Error</title>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .error { color: #d32f2f; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ Token tidak valid</h1>
            <p>Token tidak ditemukan atau password salah.</p>
          </body>
          </html>
        `);
      }
      
      // Verify file path is within backup directory and belongs to this router
      const filePath = decodeURIComponent(file);
      const backupDir = config.backup.directory;
      const safeRouterName = tokenData.routerName.replace(/[^a-zA-Z0-9-_]/g, '_');
      
      if (!filePath.startsWith(backupDir) || !filePath.includes(safeRouterName)) {
        return res.status(403).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Download Error</title>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .error { color: #d32f2f; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ Akses ditolak</h1>
            <p>File tidak dapat diakses dengan token ini.</p>
          </body>
          </html>
        `);
      }
      
      if (!(await fs.pathExists(filePath))) {
        return res.status(404).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Download Error</title>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .error { color: #d32f2f; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ File tidak ditemukan</h1>
            <p>File backup tidak ditemukan di server.</p>
          </body>
          </html>
        `);
      }
      
      // Send file
      const fileName = path.basename(filePath);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      
    } catch (err) {
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Download Error</title>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            .error { color: #d32f2f; }
          </style>
        </head>
        <body>
          <h1 class="error">❌ Error</h1>
          <p>Terjadi kesalahan saat mengunduh file.</p>
        </body>
        </html>
      `);
    }
  });
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });
  
  // 404 handler
  app.use((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>404 - Not Found</title>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .error { color: #d32f2f; }
        </style>
      </head>
      <body>
        <h1 class="error">❌ 404 - Halaman tidak ditemukan</h1>
        <p>Endpoint yang diminta tidak tersedia.</p>
      </body>
      </html>
    `);
  });
  
  // Global error handler
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Server Error</title>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .error { color: #d32f2f; }
        </style>
      </head>
      <body>
        <h1 class="error">❌ Server Error</h1>
        <p>Terjadi kesalahan pada server.</p>
        <p style="font-size: 12px; color: #999;">${err.message || 'Unknown error'}</p>
      </body>
      </html>
    `);
  });
  
  const port = config.downloadServer.port || 8888;
  // Listen on all interfaces (0.0.0.0) to accept connections from any IP
  server = app.listen(port, '0.0.0.0', () => {
    // Server started successfully - will be logged by caller
  });
  
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Port already in use - will be handled by caller
    }
    // Error will be logged by caller if needed
  });
}

function stopDownloadServer() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = {
  startDownloadServer,
  stopDownloadServer,
};

