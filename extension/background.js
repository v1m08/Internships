// Background: opens the side panel from the toolbar icon, refreshes job
// sources on a timer, notifies you about new jobs matching your filters, and
// keeps JobPilot itself up to date from GitHub.
import { getSettings, getProfile, get, set } from "./lib/store.js";
import { refreshJobs, jobKeyForUrl } from "./lib/jobs.js";
import { matchesFilters } from "./lib/sources.js";
import { checkForUpdate, applyUpdate } from "./lib/update.js";

const ALARM = "refresh-jobs";
const UPDATE_ALARM = "update-check";

async function schedule() {
  const s = await getSettings();
  const hours = Number(s.autopilot.refreshHours) || 0;
  await chrome.alarms.clear(ALARM);
  if (hours > 0) chrome.alarms.create(ALARM, { periodInMinutes: hours * 60, delayInMinutes: 1 });
}

async function refreshAndNotify() {
  const [settings, profile] = await Promise.all([getSettings(), getProfile()]);
  const cache = await refreshJobs(settings.sources);
  const applied = await get("applied", {});
  const eligSignals = Object.fromEntries(Object.entries(await get("eligCache", {})).map(([id, e]) => [id, e.signals]));
  const seen = new Set(await get("seenJobs", []));
  const firstRun = seen.size === 0;
  const fresh = cache.items.filter((j) => !seen.has(j.id) && !applied[jobKeyForUrl(j.url)] && matchesFilters(j, settings.filters, profile, eligSignals));
  await set("seenJobs", cache.items.map((j) => j.id).slice(0, 20000));
  if (!firstRun && fresh.length && settings.autopilot.notify) {
    chrome.notifications.create("new-jobs", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `${fresh.length} new internship${fresh.length === 1 ? "" : "s"} match your filters`,
      message: fresh.slice(0, 3).map((j) => `${j.company}: ${j.title}`).join("\n"),
      priority: 1,
    });
  }
}

// On browser start the panel is closed, so it's safe to update and reload.
async function updateOnStartup() {
  const settings = await getSettings();
  if (settings.autoUpdate === "off") return;
  try {
    const r = await checkForUpdate(settings);
    if (r.available && r.canAutoUpdate && settings.autoUpdate === "auto") await applyUpdate(settings);
  } catch {}
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 360 });
  schedule();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 360 });
  schedule();
  updateOnStartup();
});
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === ALARM) refreshAndNotify().catch((e) => console.warn("JobPilot refresh failed", e));
  // Later update checks only show a badge; the user picks when to update.
  if (a.name === UPDATE_ALARM) {
    const settings = await getSettings();
    if (settings.autoUpdate !== "off") checkForUpdate(settings).catch(() => {});
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    const before = changes.settings.oldValue?.autopilot?.refreshHours;
    const after = changes.settings.newValue?.autopilot?.refreshHours;
    if (before !== after) schedule();
  }
});
chrome.notifications.onClicked.addListener(async () => {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch {}
});
