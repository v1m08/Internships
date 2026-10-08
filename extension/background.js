import { getSettings } from "./lib/store.js";
import { checkForUpdate, applyUpdate } from "./lib/update.js";

// Clicking the toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.alarms.create("update-check", { periodInMinutes: 360 });
});

// On browser start the panel is closed, so it's safe to update and reload.
chrome.runtime.onStartup.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.alarms.create("update-check", { periodInMinutes: 360 });
  const settings = await getSettings();
  if (settings.autoUpdate === "off") return;
  try {
    const r = await checkForUpdate(settings);
    if (r.available && r.canAutoUpdate && settings.autoUpdate === "auto") await applyUpdate(settings);
  } catch {}
});

// Later checks only show a badge; the user picks when to update.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "update-check") return;
  const settings = await getSettings();
  if (settings.autoUpdate !== "off") checkForUpdate(settings).catch(() => {});
});
