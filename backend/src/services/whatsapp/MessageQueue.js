/**
 * MessageQueue — per-bot in-memory outgoing message queue.
 *
 * Prevents WhatsApp account bans by enforcing:
 *  - A minimum interval between consecutive sends (default 1.5 s)
 *  - A per-minute rate cap (default 20 messages / minute)
 *
 * Usage:
 *   const q = new MessageQueue(botId);
 *   await q.send(async () => socket.sendMessage(jid, { text }));
 *   q.destroy(); // on bot stop
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MessageQueue {
  constructor(botId, opts = {}) {
    this.botId         = botId;
    this._queue        = [];
    this._processing   = false;
    this._minInterval  = opts.minIntervalMs ?? 1_500;
    this._maxPerMin    = opts.maxPerMinute  ?? 20;
    this._sentCount    = 0;
    this._windowStart  = Date.now();
    this._destroyed    = false;
  }

  /**
   * Enqueue an outgoing send operation.
   * @param {() => Promise<void>} fn — async function that executes the actual send
   * @returns {Promise<void>} resolves when the message has been sent
   */
  send(fn) {
    if (this._destroyed) return Promise.reject(new Error("Queue is destroyed."));
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._pump();
    });
  }

  /** Flush pending messages and mark queue as unusable. */
  destroy() {
    this._destroyed = true;
    const pending = this._queue.splice(0);
    for (const item of pending) {
      item.reject(new Error("Bot stopped — queue destroyed."));
    }
  }

  /** How many items are waiting to be sent. */
  get size() { return this._queue.length; }

  /* ── Internal pump ─────────────────────────────────────────── */

  async _pump() {
    if (this._processing || this._destroyed) return;
    this._processing = true;

    try {
      while (this._queue.length > 0 && !this._destroyed) {
        this._tickWindow();

        /* Rate cap: wait for the minute window to reset */
        if (this._sentCount >= this._maxPerMin) {
          const waitMs = 60_000 - (Date.now() - this._windowStart) + 200;
          await sleep(Math.max(waitMs, 1_000));
          this._tickWindow();
          continue;
        }

        const item = this._queue.shift();
        if (!item) break;

        try {
          await item.fn();
          item.resolve();
          this._sentCount++;
        } catch (err) {
          item.reject(err);
        }

        /* Throttle — respect minimum interval before next send */
        if (this._queue.length > 0 && !this._destroyed) {
          await sleep(this._minInterval);
        }
      }
    } finally {
      this._processing = false;
    }
  }

  /** Reset the per-minute counter when the 60-second window has elapsed. */
  _tickWindow() {
    if (Date.now() - this._windowStart >= 60_000) {
      this._sentCount   = 0;
      this._windowStart = Date.now();
    }
  }
}
