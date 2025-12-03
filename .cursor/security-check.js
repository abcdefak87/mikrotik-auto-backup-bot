#!/usr/bin/env node

/**
 * Script security check untuk Cursor hooks
 * Mencegah akses/penulisan file sensitif secara tidak sengaja
 */

const path = require('path');

const filePath = process.argv[2];
const hookType = process.argv[3]; // 'read' or 'write'

if (!filePath) {
  process.exit(0);
}

const sensitiveFiles = [
  '.env',
  'data/routers.json',
  'data/customSchedule.json',
  'data/downloadTokens/tokens.json',
];

const fileRelative = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

// Check if file is sensitive
for (const sensitive of sensitiveFiles) {
  if (fileRelative.includes(sensitive) || fileRelative.endsWith(sensitive)) {
    if (hookType === 'write') {
      console.warn(`⚠️  WARNING: Attempting to write sensitive file: ${fileRelative}`);
      console.warn('   Make sure this is intentional and file is in .gitignore');
    } else if (hookType === 'read') {
      console.warn(`ℹ️  Reading sensitive file: ${fileRelative}`);
      console.warn('   Ensure proper access control and error sanitization');
    }
    // Don't block, just warn
    process.exit(0);
  }
}

process.exit(0);

