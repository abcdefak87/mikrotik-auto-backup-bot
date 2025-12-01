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
  
  // Helper function to escape HTML
  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  
  // Helper function to render file list page
  function renderFileListPage(token, pass, tokenData, files) {
    if (files.length === 0) {
      return `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Download Backup - ${escapeHtml(tokenData.routerName)}</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: #f5f5f5;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .container {
            background: white;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            padding: 30px;
            max-width: 600px;
            width: 100%;
            text-align: center;
          }
          h1 { color: #333; margin-bottom: 20px; font-size: 20px; }
          .empty { color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>📁 File Backup: ${escapeHtml(tokenData.routerName)}</h1>
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
    
    // Format date for display (24 jam, WIB Jakarta)
    function formatDate(timestamp) {
      try {
        // Parse timestamp string: yyyyMMdd_HHmmss
        // Timestamp dibuat dari waktu lokal server, jadi parse sebagai waktu lokal
        const year = parseInt(timestamp.substring(0, 4), 10);
        const month = parseInt(timestamp.substring(4, 6), 10) - 1; // Month is 0-indexed
        const day = parseInt(timestamp.substring(6, 8), 10);
        const hour = parseInt(timestamp.substring(9, 11), 10);
        const minute = parseInt(timestamp.substring(11, 13), 10);
        const second = parseInt(timestamp.substring(13, 15), 10);
        
        // Create Date object (as local time, since timestamp is from local time)
        const date = new Date(year, month, day, hour, minute, second);
        
        // Format with Jakarta timezone (WIB) in 24 hour format
        const formatter = new Intl.DateTimeFormat('id-ID', {
          timeZone: 'Asia/Jakarta',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false, // 24 jam format
        });
        
        const parts = formatter.formatToParts(date);
        const dayPart = parts.find(p => p.type === 'day').value;
        const monthPart = parts.find(p => p.type === 'month').value;
        const yearPart = parts.find(p => p.type === 'year').value;
        const hourPart = parts.find(p => p.type === 'hour').value;
        const minutePart = parts.find(p => p.type === 'minute').value;
        const secondPart = parts.find(p => p.type === 'second').value;
        
        return `${dayPart}/${monthPart}/${yearPart} ${hourPart}:${minutePart}:${secondPart}`;
      } catch (err) {
        // Fallback to simple format if error
        const year = timestamp.substring(0, 4);
        const month = timestamp.substring(4, 6);
        const day = timestamp.substring(6, 8);
        const hour = timestamp.substring(9, 11);
        const minute = timestamp.substring(11, 13);
        const second = timestamp.substring(13, 15);
        return `${day}/${month}/${year} ${hour}:${minute}:${second}`;
      }
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
            background: #f5f5f5;
            min-height: 100vh;
            padding: 20px;
          }
          .container {
            background: white;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            padding: 30px;
            max-width: 800px;
            margin: 0 auto;
          }
          h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 20px;
          }
          .subtitle {
            color: #666;
            margin-bottom: 20px;
            font-size: 14px;
          }
          .file-group {
            margin-bottom: 15px;
            padding: 15px;
            background: #fafafa;
            border-radius: 4px;
            border: 1px solid #e0e0e0;
          }
          .file-date {
            color: #333;
            font-weight: 500;
            margin-bottom: 10px;
            font-size: 14px;
          }
          .file-buttons {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .btn {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px;
            border-radius: 4px;
            text-decoration: none;
            color: white;
            font-weight: 400;
            font-size: 14px;
            transition: background-color 0.2s;
          }
          .btn:hover {
            opacity: 0.9;
          }
          .btn-backup {
            background: #2196F3;
          }
          .btn-rsc {
            background: #4CAF50;
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
          <h1>📁 File Backup: ${escapeHtml(tokenData.routerName)}</h1>
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
      console.log('[GET /download] Request received');
      const { token, pass } = req.query;
      console.log('[GET /download] token:', token ? 'present' : 'missing', 'pass:', pass ? 'present' : 'missing');
      
      // If password provided in query, show file list
      if (token && pass) {
        console.log('[GET /download] Verifying token with password');
        const tokenData = await verifyToken(token, pass);
        
        if (!tokenData) {
          console.log('[GET /download] Invalid token or password');
          return res.redirect(`/download?token=${token}&error=${encodeURIComponent('Password salah atau token tidak valid')}`);
        }
        
        console.log('[GET /download] Token valid, router:', tokenData.routerName);
        
        // Get all backup files for this router
        console.log('[GET /download] Getting backup files for router:', tokenData.routerName);
        const files = await getBackupFilesByRouter(tokenData.routerName, 100);
        console.log('[GET /download] Found files:', files.length);
        
        const html = renderFileListPage(token, pass, tokenData, files);
        console.log('[GET /download] HTML generated, length:', html.length);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      }
      
      // If no token, show error
      if (!token) {
        console.log('[GET /download] No token provided');
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
      console.log('[GET /download] Showing password form for router:', tokenData.routerName);
      const errorMsg = req.query.error ? decodeURIComponent(req.query.error) : '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Download Backup - ${escapeHtml(tokenData.routerName)}</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
              background: #f5f5f5;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .container {
              background: white;
              border-radius: 4px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
              padding: 30px;
              max-width: 400px;
              width: 100%;
            }
            h1 {
              color: #333;
              margin-bottom: 10px;
              font-size: 20px;
            }
            .subtitle {
              color: #666;
              margin-bottom: 20px;
              font-size: 14px;
            }
            .error {
              background: #fee;
              color: #c33;
              padding: 10px;
              border-radius: 4px;
              margin-bottom: 15px;
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
              font-weight: 400;
              font-size: 14px;
            }
            input[type="password"] {
              padding: 10px;
              border: 1px solid #ddd;
              border-radius: 4px;
              font-size: 14px;
              margin-bottom: 15px;
            }
            input[type="password"]:focus {
              outline: none;
              border-color: #2196F3;
            }
            button {
              background: #2196F3;
              color: white;
              padding: 10px;
              border: none;
              border-radius: 4px;
              font-size: 14px;
              font-weight: 400;
              cursor: pointer;
              transition: background-color 0.2s;
            }
            button:hover {
              background: #1976D2;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🔐 Masukkan Password</h1>
            <p class="subtitle">Router: <strong>${escapeHtml(tokenData.routerName)}</strong></p>
            <div class="error">${escapeHtml(errorMsg)}</div>
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

