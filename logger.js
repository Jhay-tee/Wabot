// logger.js
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const CURRENT_LEVEL = process.env.LOG_LEVEL 
  ? LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] ?? LOG_LEVELS.INFO 
  : LOG_LEVELS.INFO;

const getTimestamp = () => {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
};

export const logger = {
  info: (...args) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.INFO) {
      console.log(`[INFO] ${getTimestamp()} |`, ...args);
    }
  },

  warn: (...args) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.WARN) {
      console.warn(`[WARN] ${getTimestamp()} |`, ...args);
    }
  },

  error: (...args) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.ERROR) {
      console.error(`[ERROR] ${getTimestamp()} |`, ...args);
    }
  },

  debug: (...args) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.DEBUG) {
      console.log(`[DEBUG] ${getTimestamp()} |`, ...args);
    }
  },

  // For important success messages
  success: (...args) => {
    console.log(`[✅ SUCCESS] ${getTimestamp()} |`, ...args);
  },

  // For connection & important events
  event: (...args) => {
    console.log(`[EVENT] ${getTimestamp()} |`, ...args);
  }
};

// Export default as well for flexibility
export default logger;