// Thin wrappers over chrome.storage.local. Everything stays on this device.
import { DEFAULT_SOURCES, DEFAULT_FILTERS } from "./sources.js";

export const DEFAULT_AUTOPILOT = {
  autoSubmit: true, // submit when no typed answer had to be written (you allowed this)
  tailor: true,
  concurrency: 2, // jobs prepared at the same time
  refreshHours: 3, // background refresh of job sources; 0 = off
  notify: true,
};

export const DEFAULT_SETTINGS = {
  provider: "claude-code", // "claude-code" (subscription via bridge) | "api"
  ccModel: "sonnet",
  aiVerified: false,
  apiKey: "",
  model: "claude-sonnet-5-5",
  fileNamePattern: "{First}_{Last}_Resume_{Company}",
  renderer: "latex", // "latex" (via bridge when TeX is installed) | "built-in"
  attachWhenUntailored: "generated", // "generated" | "original"
  sources: DEFAULT_SOURCES,
  filters: DEFAULT_FILTERS,
  autopilot: DEFAULT_AUTOPILOT,
  // Where JobPilot updates come from. Point this at your own fork if you have one.
  updateRepo: "v1m08/Internships",
  updateBranch: "main",
  autoUpdate: "ask", // "auto" | "ask" | "off"
  coverAttach: "any", // attach your cover letter to "any" cover letter field | "required" ones only | "off"
};

export const DEFAULT_PROFILE = {
  firstName: "",
  lastName: "",
  preferredName: "",
  email: "",
  phone: "",
  linkedin: "",
  github: "",
  website: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  country: "United States",
  school: "",
  degree: "",
  major: "",
  gpa: "",
  gradMonth: "",
  gradYear: "",
  // Flexible graduation window ("December 2028" … "May 2030"); empty = fixed.
  schoolStart: "", // "August 2026"; estimated from graduation when empty
  gradEarliest: "",
  gradLatest: "",
  currentCompany: "",
  currentTitle: "",
  workAuthorized: "yes",
  needsSponsorship: "no",
  over18: "yes",
  willingToRelocate: "yes",
  howHeard: "Job board",
  availableStart: "",
  salaryExpectation: "",
  pronouns: "",
  gender: "Decline to self-identify",
  race: "Decline to self-identify",
  hispanic: "Decline to self-identify",
  veteran: "Decline to self-identify",
  disability: "Decline to self-identify",
};

export async function get(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] === undefined ? fallback : r[key];
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(await get("settings", {})) };
  s.filters = { ...DEFAULT_FILTERS, ...s.filters };
  s.autopilot = { ...DEFAULT_AUTOPILOT, ...s.autopilot };
  return s;
}

export async function getProfile() {
  return { ...DEFAULT_PROFILE, ...(await get("profile", {})) };
}

// Per-tab job context ("which listing did I open this tab from?"), kept in
// session storage so it survives the side panel closing.
export async function getTabJob(tabId) {
  const r = await chrome.storage.session.get("tabJobs");
  return (r.tabJobs || {})[tabId] || null;
}

export async function setTabJob(tabId, job) {
  const r = await chrome.storage.session.get("tabJobs");
  const tabJobs = r.tabJobs || {};
  tabJobs[tabId] = job;
  await chrome.storage.session.set({ tabJobs });
}
