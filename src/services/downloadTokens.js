const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const config = require('../config');

const tokensDir = path.join(__dirname, '..', '..', 'data', 'downloadTokens');
const tokensFile = path.join(tokensDir, 'tokens.json');

// Token tidak expire (permanent)
// const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

let tokensCache = null;

async function ensureTokensFile() {
  await fs.ensureDir(tokensDir);
  if (!(await fs.pathExists(tokensFile))) {
    await fs.writeJSON(tokensFile, {}, { spaces: 2 });
  }
}

async function loadTokens() {
  await ensureTokensFile();
  try {
    const data = await fs.readJSON(tokensFile);
    return data || {};
  } catch (err) {
    return {};
  }
}

async function saveTokens(tokens) {
  await ensureTokensFile();
  await fs.writeJSON(tokensFile, tokens, { spaces: 2 });
  tokensCache = tokens;
}

async function getTokens() {
  if (tokensCache) {
    return tokensCache;
  }
  tokensCache = await loadTokens();
  return tokensCache;
}

// Clean expired tokens (no longer needed since tokens don't expire)
async function cleanExpiredTokens() {
  // Tokens are now permanent, no cleanup needed
  // But keep function for backward compatibility
}

// Generate random token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Generate random password (6-8 characters, alphanumeric)
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
  let password = '';
  for (let i = 0; i < 6; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

// Create download token for a router (not per file, permanent)
async function createRouterToken(routerName, password) {
  await cleanExpiredTokens();
  
  const tokens = await getTokens();
  
  // Check if token already exists for this router
  let existingToken = null;
  for (const [token, data] of Object.entries(tokens)) {
    if (data.routerName === routerName && !data.expiresAt) {
      existingToken = token;
      // Update password if provided, or use default from config
      const newPassword = password || config.downloadServer.defaultPassword;
      if (tokens[token].password !== newPassword) {
        tokens[token].password = newPassword;
        await saveTokens(tokens);
      }
      return { token: existingToken, password: tokens[token].password };
    }
  }
  
  // Create new token if doesn't exist
  const token = generateToken();
  const tokenPassword = password || config.downloadServer.defaultPassword;
  
  tokens[token] = {
    routerName,
    password: tokenPassword,
    createdAt: Date.now(),
    // No expiresAt - permanent token
  };
  
  await saveTokens(tokens);
  return { token, password: tokenPassword };
}

// Legacy function for backward compatibility (creates router token)
async function createToken(filePath, fileName, routerName) {
  // For backward compatibility, create router token
  return await createRouterToken(routerName);
}

// Verify token and password
async function verifyToken(token, password) {
  await cleanExpiredTokens();
  
  const tokens = await getTokens();
  const tokenData = tokens[token];
  
  if (!tokenData) {
    return null; // Token not found
  }
  
  // Check expiry only if expiresAt exists (for backward compatibility)
  if (tokenData.expiresAt && tokenData.expiresAt < Date.now()) {
    // Token expired, remove it
    delete tokens[token];
    await saveTokens(tokens);
    return null;
  }
  
  if (tokenData.password !== password) {
    return null; // Wrong password
  }
  
  return tokenData;
}

// Verify token only (for password prompt page)
async function verifyTokenOnly(token) {
  await cleanExpiredTokens();
  
  const tokens = await getTokens();
  const tokenData = tokens[token];
  
  if (!tokenData) {
    return null; // Token not found
  }
  
  // Check expiry only if expiresAt exists
  if (tokenData.expiresAt && tokenData.expiresAt < Date.now()) {
    delete tokens[token];
    await saveTokens(tokens);
    return null;
  }
  
  return tokenData;
}

// Update all existing tokens to use default password
async function updateAllTokensToDefaultPassword() {
  const tokens = await getTokens();
  let updated = false;
  const defaultPassword = config.downloadServer.defaultPassword;
  
  for (const [token, data] of Object.entries(tokens)) {
    if (data.password !== defaultPassword && !data.expiresAt) {
      tokens[token].password = defaultPassword;
      updated = true;
    }
  }
  
  if (updated) {
    await saveTokens(tokens);
  }
}

// Update all tokens to default password on startup
updateAllTokensToDefaultPassword().catch(err => {
  // Silently fail
});

// Cleanup expired tokens periodically (every hour)
setInterval(() => {
  cleanExpiredTokens().catch(err => {
    // Silently fail
  });
}, 60 * 60 * 1000);

module.exports = {
  createToken,
  createRouterToken,
  verifyToken,
  verifyTokenOnly,
  cleanExpiredTokens,
};

