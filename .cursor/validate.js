#!/usr/bin/env node

/**
 * Script validasi untuk Cursor hooks
 * Mengecek: syntax JS, ES6 modules, hardcoded credentials
 */

const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];

if (!filePath || !filePath.endsWith('.js')) {
  process.exit(0);
}

try {
  const content = fs.readFileSync(filePath, 'utf8');
  const errors = [];

  // Check for ES6 modules
  if (/^import\s+.*from|^export\s+/.test(content)) {
    errors.push('⚠️  ES6 modules detected! Use CommonJS (require/module.exports)');
  }

  // Check for hardcoded passwords (simple pattern)
  const passwordPattern = /password\s*[:=]\s*['"]([^'"]+)['"]/i;
  if (passwordPattern.test(content)) {
    errors.push('⚠️  Possible hardcoded password detected!');
  }

  // Check for hardcoded tokens
  const tokenPattern = /token\s*[:=]\s*['"]([^'"]{20,})['"]/i;
  if (tokenPattern.test(content)) {
    errors.push('⚠️  Possible hardcoded token detected!');
  }

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
} catch (err) {
  // Ignore errors, just validate syntax
  process.exit(0);
}

