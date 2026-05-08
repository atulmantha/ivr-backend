'use strict';

// ── queueManager.js ───────────────────────────────────────────
// In-memory per-category call queues (FIFO).
// Queue state is lost on server restart; the DB status='waiting'
// column persists for dashboard visibility across restarts.

const QUEUE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max wait time

// One array per IVR category — order determines priority (FIFO).
const queues = {
  billing:        [],
  service:        [],
  new_connection: [],
  general:        [],
};

function _cat(category) {
  return queues[category] ? category : 'general';
}

// Add a call to the queue. Returns its 1-based position.
// Safe to call multiple times for the same callId (idempotent).
function enqueue(callId, category) {
  const cat = _cat(category);
  const existing = queues[cat].findIndex(e => e.callId === callId);
  if (existing !== -1) return existing + 1;
  queues[cat].push({ callId, category: cat, enqueuedAt: Date.now() });
  const pos = queues[cat].length;
  console.log(`[queue] Enqueued callId=${callId} category=${cat} position=${pos}`);
  return pos;
}

// Remove and return the first entry for a category, or null if empty.
function dequeue(category) {
  const cat = _cat(category);
  const entry = queues[cat].shift() || null;
  if (entry) console.log(`[queue] Dequeued callId=${entry.callId} from ${cat}`);
  return entry;
}

// Remove a specific call from any queue (e.g., customer hung up while waiting).
// Returns the category it was removed from, or null if not found.
function remove(callId) {
  for (const [cat, arr] of Object.entries(queues)) {
    const idx = arr.findIndex(e => e.callId === callId);
    if (idx !== -1) {
      arr.splice(idx, 1);
      console.log(`[queue] Removed callId=${callId} from ${cat} queue`);
      return cat;
    }
  }
  return null;
}

// Returns 1-based queue position, or 0 if not in any queue.
function getPosition(callId) {
  for (const arr of Object.values(queues)) {
    const idx = arr.findIndex(e => e.callId === callId);
    if (idx !== -1) return idx + 1;
  }
  return 0;
}

// Returns the category a callId is queued in, or null.
function getCategoryFor(callId) {
  for (const [cat, arr] of Object.entries(queues)) {
    if (arr.some(e => e.callId === callId)) return cat;
  }
  return null;
}

// Returns per-category stats for the dashboard API.
function getStats() {
  const now = Date.now();
  const stats = {};
  for (const [cat, arr] of Object.entries(queues)) {
    stats[cat] = {
      count: arr.length,
      entries: arr.map((e, i) => ({
        callId:      e.callId,
        position:    i + 1,
        waitSeconds: Math.floor((now - e.enqueuedAt) / 1000),
      })),
    };
  }
  return stats;
}

// Returns all entries that have exceeded QUEUE_TIMEOUT_MS.
function getTimedOut() {
  const now = Date.now();
  const result = [];
  for (const arr of Object.values(queues)) {
    for (const entry of arr) {
      if (now - entry.enqueuedAt > QUEUE_TIMEOUT_MS) result.push({ ...entry });
    }
  }
  return result;
}

module.exports = {
  enqueue,
  dequeue,
  remove,
  getPosition,
  getCategoryFor,
  getStats,
  getTimedOut,
  QUEUE_TIMEOUT_MS,
  queues,
};
