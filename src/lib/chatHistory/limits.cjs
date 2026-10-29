// Shared by the bundled app and the standalone worker. Byte units are binary.
module.exports = Object.freeze({
  queueBytes: 16 * 1024 * 1024,
  queueRecords: 50,
  recordBytes: 512 * 1024,
  batchRecords: 10,
  flushIntervalMs: 2000,
  captureBytes: 8 * 1024 * 1024,
  collectors: 32,
  requestMessages: 64,
  streamTailBytes: 8192,
});
