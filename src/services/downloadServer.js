const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const { verifyToken } = require('./downloadTokens');
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
  
  // Download endpoint
  app.get('/download', async (req, res) => {
    try {
      const { token, pass } = req.query;
      
      if (!token || !pass) {
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
            <p>Token dan password diperlukan untuk mengunduh file.</p>
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
            <h1 class="error">❌ Token tidak valid atau sudah expired</h1>
            <p>Token tidak ditemukan, password salah, atau link sudah kadaluarsa (24 jam).</p>
          </body>
          </html>
        `);
      }
      
      const filePath = tokenData.filePath;
      
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
      const fileName = tokenData.fileName || path.basename(filePath);
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

