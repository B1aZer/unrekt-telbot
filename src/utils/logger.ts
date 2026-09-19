/**
 * Logger utility
 * - Console: Controlled by CONSOLE_LOG_LEVEL (default: DEBUG)
 * - File: Detailed logs (disabled in containers via DISABLE_FILE_LOGGING)
 */

import { appendFile } from 'fs/promises';
import { join } from 'path';

const LOG_FILE = join(process.cwd(), 'bot.log');

// Disable file logging in containers (Cloud Run, Docker, etc.)
const FILE_LOGGING_ENABLED = process.env.DISABLE_FILE_LOGGING !== 'true';

// Console log level control - set to INFO to skip DEBUG logs in console
const CONSOLE_LOG_LEVEL = process.env.CONSOLE_LOG_LEVEL || 'DEBUG'; // DEBUG, INFO, WARN, ERROR

// File log level control - set to INFO to skip DEBUG logs in file
const FILE_LOG_LEVEL = process.env.FILE_LOG_LEVEL || 'DEBUG'; // DEBUG, INFO, WARN, ERROR

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

const LOG_LEVELS = {
  'DEBUG': 0,
  'INFO': 1,
  'WARN': 2,
  'ERROR': 3,
};

function shouldLogToConsole(level: LogLevel): boolean {
  const currentLevel = LOG_LEVELS[CONSOLE_LOG_LEVEL as LogLevel] || 0;
  const messageLevel = LOG_LEVELS[level] || 0;
  return messageLevel >= currentLevel;
}

function shouldLogToFile(level: LogLevel): boolean {
  const currentLevel = LOG_LEVELS[FILE_LOG_LEVEL as LogLevel] || 0;
  const messageLevel = LOG_LEVELS[level] || 0;
  return messageLevel >= currentLevel;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

async function writeToFile(level: LogLevel, message: string, data?: any) {
  // Skip if file logging is disabled (e.g., in containers)
  if (!FILE_LOGGING_ENABLED) {
    return;
  }
  
  // Skip if below minimum log level
  if (!shouldLogToFile(level)) {
    return;
  }
  
  const timestamp = formatTimestamp();
  let logLine = `[${timestamp}] [${level}] ${message}`;
  
  if (data) {
    logLine += `\n${JSON.stringify(data, null, 2)}`;
  }
  
  logLine += '\n';
  
  try {
    await appendFile(LOG_FILE, logLine);
  } catch (error) {
    // Silently fail if can't write to file
  }
}

export const logger = {
  // Info - show in console + log to file
  info(message: string, showConsole = true) {
    if (showConsole) {
      console.log(message);
    }
    writeToFile('INFO', message);
  },

  // Warn - show in console + log to file
  warn(message: string, data?: any) {
    console.warn(`⚠️  ${message}`);
    writeToFile('WARN', message, data);
  },

  // Error - show in console + log to file
  error(message: string, error?: any) {
    console.error(`❌ ${message}`);
    writeToFile('ERROR', message, error);
  },

  // Debug - show in console (controlled by CONSOLE_LOG_LEVEL), log to file (controlled by FILE_LOG_LEVEL)
  debug(message: string, data?: any) {
    if (shouldLogToConsole('DEBUG')) {
      console.log(`🔍 [DEBUG] ${message}`);
      if (data) {
        console.log(JSON.stringify(data, null, 2));
      }
    }
    writeToFile('DEBUG', message, data);
  },

  // Success - show in console + log to file
  success(message: string) {
    console.log(`✅ ${message}`);
    writeToFile('INFO', `✅ ${message}`);
  },

  // Scan start
  scanStart() {
    console.log('\n🔍 Starting hot token scan...');
    writeToFile('INFO', 'Starting hot token scan');
  },

  // Scan complete
  scanComplete(trades: number, tokens: number, duration: number) {
    const message = `Scan complete: ${trades} trades, ${tokens} tokens found in ${duration}s`;
    console.log(`✅ ${message}`);
    writeToFile('INFO', message);
  },

  // Codex fetch
  codexFetch(requested: number, received: number) {
    if (received > 0) {
      console.log(`📊 Fetched metadata for ${received}/${requested} tokens`);
    } else {
      console.log(`⚠️  No metadata fetched (check API key)`);
    }
    writeToFile('INFO', `Codex: ${received}/${requested} tokens`, { requested, received });
  },
};

