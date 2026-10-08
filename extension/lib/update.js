// Keeping JobPilot up to date from its GitHub repo.
//
// With the Claude Code bridge installed from a git clone, updates are a
// `git pull` plus an extension reload. Otherwise we compare the manifest
// version on GitHub with ours and tell the user how to update by hand.
// Shared by the side panel and the background service worker.
import { get, set } from "./store.js";

const BRIDGE_HOST = "com.jobpilot.claude_bridge";

const CHECK_EVERY_MS = 6 * 3600 * 1000;

export function repoUrl(settings) {
  return `https://github.com/${settings.updateRepo}`;
}

function bridge(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(BRIDGE_HOST, msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message || "Bridge unavailable."));
      if (!resp || !resp.ok) return reject(Object.assign(new Error(resp?.error || "Bridge failed."), { code: resp?.code }));
      resolve(resp);
    });
  });
}

function newer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function remoteVersion(settings) {
  const url = `https://raw.githubusercontent.com/${settings.updateRepo}/${settings.updateBranch}/extension/manifest.json`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't read ${settings.updateRepo} on GitHub (HTTP ${res.status}). Check the repo in Settings → Updates.`);
  return (await res.json()).version;
}

// -> { available, canAutoUpdate, detail, checkedAt }
export async function checkForUpdate(settings) {
  const current = chrome.runtime.getManifest().version;
  let result;
  try {
    const r = await bridge({ type: "update-check", branch: settings.updateBranch });
    result = { available: r.behind > 0, canAutoUpdate: true, detail: r.behind > 0 ? `${r.behind} new commit${r.behind === 1 ? "" : "s"}` : "Up to date" };
  } catch (e) {
    // No bridge, an old bridge, or not a git clone: fall back to versions.
    const remote = await remoteVersion(settings);
    const available = newer(remote, current);
    result = { available, canAutoUpdate: false, detail: available ? `Version ${remote} is out (you have ${current})` : `Up to date (v${current})` };
  }
  result.checkedAt = Date.now();
  await set("updateStatus", result);
  showBadge(result.available);
  return result;
}

export function showBadge(on) {
  chrome.action.setBadgeText({ text: on ? "↑" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
}

export async function lastStatus() {
  return get("updateStatus", null);
}

export function isStale(status) {
  return !status || Date.now() - status.checkedAt > CHECK_EVERY_MS;
}

// Pulls the latest code and reloads the extension so it takes effect.
export async function applyUpdate(settings) {
  const r = await bridge({ type: "update", branch: settings.updateBranch });
  await set("updateStatus", null);
  showBadge(false);
  chrome.runtime.reload();
  return r;
}
