// Waiting that Chrome doesn't throttle. Timers in a hidden tab (like the
// pinned Autopilot tab) can be slowed to about once a minute, which made
// runs crawl; a worker's timers aren't. Falls back to setTimeout where
// workers aren't available (the background service worker).
let worker = null;
let seq = 0;
const waiting = new Map();

function timerWorker() {
  if (worker || typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(chrome.runtime.getURL("lib/clock-worker.js"));
    worker.onmessage = (e) => {
      const done = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (done) done();
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function sleep(ms) {
  const w = timerWorker();
  if (!w) return new Promise((r) => setTimeout(r, ms));
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, ms });
  });
}

// Reject if `promise` takes longer than ms.
export function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`${what} didn't respond within ${Math.round(ms / 1000)}s`);
    }),
  ]);
}
