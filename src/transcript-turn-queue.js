export function createTranscriptTurnQueue({ runTurn, debounceMs = 150, maxWaitMs = null, isReady = (_text) => true }) {
  let running = false;
  let buffered = [];
  let current = Promise.resolve();
  let currentDebounceMs = debounceMs;
  let currentMaxWaitMs = maxWaitMs;
  // Pending bucket holds chunks that arrived too recently to fire yet. Waiting
  // a short window lets bursts of small transcript chunks coalesce into one
  // turn. The isReady predicate gates whether the accumulated buffer has
  // enough substantive content to actually fire - if not, keep accumulating
  // until more chunks arrive or max wait / idle() forces a flush.
  let pending = [];
  let debounceTimer = null;
  let maxWaitTimer = null;

  function clearMaxWaitTimer() {
    if (!maxWaitTimer) return;
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }

  function startMaxWaitTimer() {
    if (Number.isFinite(currentMaxWaitMs) && currentMaxWaitMs > 0) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = null;
        flushPending({ force: true });
      }, currentMaxWaitMs);
    }
  }

  function flushPending({ force = false } = {}) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (pending.length === 0) return;
    const text = pending.join("\n");
    if (!force && !isReady(text)) {
      // Not enough content yet - the next enqueue restarts debounce, while
      // an enabled max-wait timer can still force this batch through.
      return;
    }
    pending = [];
    clearMaxWaitTimer();
    if (running) {
      buffered.push(text);
    } else {
      current = drain(text);
    }
  }

  async function drain(text) {
    running = true;
    try {
      await runTurn(text);
    } finally {
      if (buffered.length > 0) {
        const next = buffered.join("\n");
        buffered = [];
        current = drain(next);
      } else {
        running = false;
        // If pending arrived during the turn and is now ready, flush it. If
        // it's still not ready, keep accumulating until more text or max wait.
        if (pending.length > 0) {
          if (debounceTimer) clearTimeout(debounceTimer);
          flushPending();
        }
      }
    }
  }

  function enqueue(text) {
    const trimmed = text.trim();
    if (!trimmed) return current;
    const wasEmpty = pending.length === 0;
    pending.push(trimmed);
    if (wasEmpty) startMaxWaitTimer();
    if (currentDebounceMs > 0) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushPending, currentDebounceMs);
    } else {
      flushPending();
    }
    return current;
  }

  async function idle() {
    // Force-flush any pending content (bypassing isReady) so idle() always
    // terminates - tests and shutdown paths shouldn't hang on a buffer that
    // happens to contain only fillers.
    while (debounceTimer || maxWaitTimer || running || buffered.length > 0 || pending.length > 0) {
      if (debounceTimer || maxWaitTimer || pending.length > 0) {
        if (debounceTimer) clearTimeout(debounceTimer);
        clearMaxWaitTimer();
        flushPending({ force: true });
      }
      await current;
    }
  }

  // Drop queued text and timers; an already-running turn is not cancelled.
  function clear() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    clearMaxWaitTimer();
    pending = [];
    buffered = [];
  }

  // Apply timing changes immediately, restarting timers for pending text.
  function configure(next = {}) {
    if (next.debounceMs !== undefined) currentDebounceMs = next.debounceMs;
    if (next.maxWaitMs !== undefined) currentMaxWaitMs = next.maxWaitMs;
    if (pending.length === 0) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    clearMaxWaitTimer();
    startMaxWaitTimer();
    if (currentDebounceMs > 0) {
      debounceTimer = setTimeout(flushPending, currentDebounceMs);
    } else {
      flushPending();
    }
  }

  return { enqueue, idle, clear, configure };
}
