// Timer thread for lib/clock.js: a dedicated worker's timers keep running
// at full speed while JobPilot's page is a hidden or background tab.
self.onmessage = (e) => setTimeout(() => self.postMessage(e.data), e.data.ms);
