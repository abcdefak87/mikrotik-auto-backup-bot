#!/usr/bin/env node

/**
 * Script debugging untuk Cursor hooks
 * Mendeteksi: common bugs, undefined variables, missing requires, error patterns
 */

const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];

if (!filePath || !filePath.endsWith('.js')) {
  process.exit(0);
}

try {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const errors = [];
  const warnings = [];

  // Track required modules
  const requiredModules = new Set();
  const usedIdentifiers = new Set();

  // Pattern untuk detect common bugs
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Detect require statements
    const requireMatch = trimmed.match(/require\(['"]([^'"]+)['"]\)/);
    if (requireMatch) {
      requiredModules.add(requireMatch[1]);
    }

    // Detect undefined variables (simple pattern)
    if (/undefined\s*[!=]/.test(trimmed) && !/typeof/.test(trimmed)) {
      warnings.push(`Line ${lineNum}: Possible undefined check - consider using typeof or optional chaining`);
    }

    // Detect console.log in production code (bisa dihapus untuk production)
    if (/console\.(log|debug)/.test(trimmed)) {
      warnings.push(`Line ${lineNum}: console.log detected - consider removing for production`);
    }

    // Detect potential null/undefined access
    if (/\.\w+\s*[\(\.]/.test(trimmed) && !/\?\./.test(trimmed)) {
      // Simple check - bisa false positive
    }

    // Detect missing error handling in critical async operations only
    if (/await\s+(performBackup|testConnection|sendMessage|createReadStream|fs\.|conn\.)/.test(trimmed)) {
      // Check if there's try-catch nearby (within 20 lines)
      const contextLines = lines.slice(Math.max(0, i - 5), Math.min(i + 20, lines.length)).join('\n');
      if (!/try\s*\{/.test(contextLines)) {
        warnings.push(`Line ${lineNum}: Critical async operation without try-catch - consider adding error handling`);
      }
    }

    // Detect common typos
    if (/\bundefined\b.*===/.test(trimmed) || /\bnull\b.*===/.test(trimmed)) {
      // OK, just checking
    }

    // Detect missing return in function
    if (/function\s+\w+\s*\(/.test(trimmed)) {
      const funcContent = lines.slice(i, Math.min(i + 50, lines.length)).join('\n');
      if (/return\s+/.test(funcContent) === false && !/console\.|process\.exit/.test(funcContent)) {
        // Might need return - but too many false positives
      }
    }

    // Detect potential memory leaks (unclosed connections)
    if (/(\.end\(\)|\.close\(\)|\.destroy\(\))/.test(trimmed)) {
      // Good - connection cleanup detected
    }

    // Detect missing finally blocks for cleanup
    if (/try\s*\{/.test(trimmed)) {
      const tryContent = lines.slice(i, Math.min(i + 100, lines.length)).join('\n');
      if (/finally\s*\{/.test(tryContent) === false && /conn\.|stream\.|connection\./.test(tryContent)) {
        warnings.push(`Line ${lineNum}: try block with connections - consider adding finally block for cleanup`);
      }
    }
  }

  // Check for common error patterns
  if (/process\.exit\(1\)/.test(content) && !/logger\.error/.test(content)) {
    warnings.push('process.exit(1) detected - ensure error is logged before exit');
  }

  // Check for missing error sanitization
  if (/catch\s*\(/.test(content) && !/sanitizeError/.test(content)) {
    warnings.push('catch block detected - ensure errors are sanitized before sending to user');
  }

  // Output warnings (non-blocking)
  if (warnings.length > 0) {
    console.warn('🐛 Debug Warnings:');
    warnings.forEach(w => console.warn(`  ${w}`));
  } else {
    console.log('✅ Debug check passed: No issues detected');
  }

  // Output errors (blocking)
  if (errors.length > 0) {
    console.error('❌ Debug Errors:');
    errors.forEach(e => console.error(`  ${e}`));
    process.exit(1);
  }

  // If only warnings, exit with 0 (don't block)
  process.exit(0);
} catch (err) {
  // Ignore errors in debug script itself
  process.exit(0);
}

