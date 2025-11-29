const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');

const tokensDir = path.join(__dirname, '..', '..', 'data', 'downloadTokens');
const tokensFile = path.join(tokensDir, 'tokens.json');

// Token expiry: 24 hours
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

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

// Clean expired tokens
async function cleanExpiredTokens() {
  const tokens = await getTokens();
  const now = Date.now();
  let cleaned = false;
  
  for (const [token, data] of Object.entries(tokens)) {
    if (data.expiresAt && data.expiresAt < now) {
      delete tokens[token];
      cleaned = true;
    }
  }
  
  if (cleaned) {
    await saveTokens(tokens);
  }
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

// Create download token for a file
async function createToken(filePath, fileName, routerName) {
  await cleanExpiredTokens();
  
  const tokens = await getTokens();
  const token = generateToken();
  const password = generatePassword();
  const expiresAt = Date.now() + TOKEN_EXPIRY_MS;
  
  tokens[token] = {
    filePath,
    fileName,
    routerName,
    password,
    createdAt: Date.now(),
    expiresAt,
  };
  
  await saveTokens(tokens);
  return { token, password };
}

// Verify token and password
async function verifyToken(token, password) {
  await cleanExpiredTokens();
  
  const tokens = await getTokens();
  const tokenData = tokens[token];
  
  if (!tokenData) {
    return null; // Token not found
  }
  
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

// Cleanup expired tokens periodically (every hour)
setInterval(() => {
  cleanExpiredTokens().catch(err => {
    // Silently fail
  });
}, 60 * 60 * 1000);

module.exports = {
  createToken,
  verifyToken,
  cleanExpiredTokens,
};

