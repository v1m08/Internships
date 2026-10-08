// Talking to the active tab: reading the job posting and running the
// autofill engine (content/autofill.js) in every frame.

export async function activeTab() {
  const isOwn = (t) => (t.url || "").startsWith(chrome.runtime.getURL(""));
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && !isOwn(tab)) return tab;
  // The panel itself was opened as a tab/window (e.g. in tests): use the
  // active tab of another window.
  const others = (await chrome.tabs.query({ active: true })).filter((t) => !isOwn(t));
  return others[0] || tab;
}

function assertScriptable(tab) {
  if (!tab || !/^https?:/.test(tab.url || "")) throw new Error("Open a job posting or application page in this tab first.");
}

async function inject(tabId) {
  await Promise.all([
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content/autofill.js"] }),
    // Page-world helper for react-select dropdowns (see content/mainworld.js).
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content/mainworld.js"], world: "MAIN" }).catch(() => {}),
  ]);
}

async function runInFrames(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
  return results.map((r) => r.result).filter((r) => r !== undefined && r !== null);
}

// The posting text: the longest readable text among the tab's frames.
export async function readJobPosting(tab) {
  assertScriptable(tab);
  const texts = await runInFrames(tab.id, () => {
    const root = document.querySelector('main, [role="main"], #content, .job, [class*="job-description" i], article') || document.body;
    const text = (root.innerText || "").length > 400 ? root.innerText : document.body.innerText;
    return { url: location.href, title: document.title, text: (text || "").replace(/\n{3,}/g, "\n\n").slice(0, 40000) };
  });
  if (!texts.length) throw new Error("Couldn't read this page.");
  texts.sort((a, b) => b.text.length - a.text.length);
  const best = texts[0];
  if (best.text.length < 200) throw new Error("This page doesn't have much text. Open the job description page, then try again.");
  return { url: tab.url, title: tab.title, text: best.text };
}

export async function autofill(tab, payload) {
  assertScriptable(tab);
  await inject(tab.id);
  const reports = await runInFrames(tab.id, (p) => window.__jobpilot.fill(p), [payload]);
  // Only attach the resume once, in the first frame that has a resume field.
  const merged = { filled: [], review: [], attached: null, skippedFilled: 0, controls: 0 };
  for (const r of reports) {
    merged.filled.push(...r.filled);
    merged.review.push(...r.review);
    merged.skippedFilled += r.skippedFilled;
    merged.controls += r.controls;
    merged.attached = merged.attached || r.attached;
  }
  return merged;
}

// opts: { stuck, profile } (see collectQuestions in content/autofill.js)
export async function collectQuestions(tab, opts = {}) {
  assertScriptable(tab);
  await inject(tab.id);
  const lists = await runInFrames(tab.id, (o) => window.__jobpilot.collectQuestions(o), [opts]);
  return lists.flat();
}

export async function fillAnswers(tab, answers) {
  const counts = await runInFrames(tab.id, (a) => window.__jobpilot.fillAnswers(a), [answers]);
  return counts.reduce((a, b) => a + b, 0);
}

// ------------------------------------------------------------- autopilot

// Run a window.__jobpilot function in every frame; returns per-frame results.
export async function callAll(tab, name, args = []) {
  await inject(tab.id);
  return runInFrames(tab.id, (n, a) => window.__jobpilot[n](...a), [name, args]);
}

export function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => id === tabId && info.status === "complete" && finish();
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && finish(), finish);
  });
}

// Wait until the page's form stops growing (single-page apps render late)
// instead of sleeping a fixed time. Returns the last form size.
export async function waitForForm(tab, { timeoutMs = 8000, minControls = 3 } = {}) {
  await waitForLoad(tab.id);
  const start = Date.now();
  let last = -1;
  let stable = 0;
  let size = { controls: 0, files: 0 };
  while (Date.now() - start < timeoutMs) {
    try {
      const stats = await callAll(tab, "formStats");
      size = { controls: stats.reduce((a, s) => a + s.controls, 0), files: stats.reduce((a, s) => a + s.fileInputs, 0) };
    } catch {}
    if (size.controls === last) {
      stable++;
      // A real form settles fast; a page without one gets ~1s to prove it.
      if ((size.controls >= minControls && stable >= 2) || stable >= 4) break;
    } else stable = 0;
    last = size.controls;
    await new Promise((r) => setTimeout(r, 250));
  }
  return size;
}
