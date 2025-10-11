export const HIDDEN_FIELD_KEY = 'hidden_field';
export const GLOBAL_SETTINGS_KEY = 'global-settings';
export const METADATA_CACHE_KEY = 'metadata:all';
export const IS_PUBLIC_KEY = 'isPublic';

export const BOOTSTRAP_SCRIPT_RELOAD_EVENT_KEY = 'enfyra:bootstrap-script-reload';
export const BOOTSTRAP_SCRIPT_EXECUTION_LOCK_KEY = 'bootstrap-script-execution';
export const ROUTE_CACHE_SYNC_EVENT_KEY = 'enfyra:route-cache-sync';
export const PACKAGE_CACHE_SYNC_EVENT_KEY = 'enfyra:package-cache-sync';
export const METADATA_CACHE_SYNC_EVENT_KEY = 'enfyra:metadata-cache-sync';

export const REDIS_TTL = {
  BOOTSTRAP_LOCK_TTL: 30000,
  
  FILE_CACHE_TTL: {
    SMALL: 3600 * 1000,
    MEDIUM: 1800 * 1000,
    LARGE: 600 * 1000,
    XLARGE: 300 * 1000,
  },
  
  CACHE_STATS_INTERVAL: 600000,
  CACHE_CLEANUP_INTERVAL: 300000,
} as const;
