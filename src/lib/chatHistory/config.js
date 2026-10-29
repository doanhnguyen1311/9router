import limits from './limits.cjs';

export const HISTORY_LIMITS = limits;
export const HISTORY_DEFAULTS = {
  chatHistoryEnabled: false,
  chatHistoryRetentionDays: 30,
  chatHistoryQueueCapacity: limits.queueRecords,
  chatHistoryQueueMaxBytes: limits.queueBytes,
  chatHistoryMaxContentBytes: 64 * 1024,
  chatHistoryBatchSize: limits.batchRecords,
  chatHistoryFlushIntervalMs: limits.flushIntervalMs,
};

export function historyConfig(settings = {}) {
  const out = { ...HISTORY_DEFAULTS };
  const bounds = {
    chatHistoryRetentionDays: [1, 365], chatHistoryQueueCapacity: [1, limits.queueRecords],
    chatHistoryQueueMaxBytes: [65536, limits.queueBytes],
    chatHistoryMaxContentBytes: [4096, 256 * 1024],
    chatHistoryBatchSize: [limits.batchRecords, limits.batchRecords],
    chatHistoryFlushIntervalMs: [limits.flushIntervalMs, limits.flushIntervalMs],
  };
  out.chatHistoryEnabled = settings.chatHistoryEnabled === true;
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (Number.isFinite(settings[key])) out[key] = Math.max(min, Math.min(max, Math.floor(settings[key])));
  }
  return out;
}
