// Thin wrappers over chrome.storage.local. Everything stays on this device.

export const DEFAULT_SETTINGS = {
  provider: "claude-code", // "claude-code" (subscription via bridge) | "api"
  ccModel: "default",
  aiVerified: false,
  apiKey: "",
  model: "claude-opus-5-5",
  fileNamePattern: "{First}_{Last}_Resume_{Company}",
  font: "times",
  attachWhenUntailored: "generated", // "generated" | "original"
  jobSourceUrl: "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
  // Where JobPilot updates come from. Point this at your own fork if you have one.
  updateRepo: "v1m08/Internships",
  updateBranch: "main",
  autoUpdate: "ask", // "auto" | "ask" | "off"
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
  currentCompany: "",
  currentTitle: "",
  workAuthorized: "yes",
  needsSponsorship: "no",
  over18: "yes",
  willingToRelocate: "yes",
  howHeard: "Job board",
  availableStart: "",
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
  return { ...DEFAULT_SETTINGS, ...(await get("settings", {})) };
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
