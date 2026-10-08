// Job listings from a SimplifyJobs-format listings.json, cached locally.
import { get, set } from "./store.js";

export async function refreshJobs(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't load job list (HTTP ${res.status}). Check the source URL in Settings.`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Job source isn't a listings.json array.");
  const items = data
    .filter((j) => j.active !== false && j.is_visible !== false && j.url)
    .map((j) => ({
      id: j.id || j.url,
      company: j.company_name || "",
      title: j.title || "",
      url: j.url,
      locations: j.locations || [],
      category: j.category || "",
      sponsorship: j.sponsorship || "",
      posted: j.date_posted || j.date_updated || 0,
    }))
    .sort((a, b) => b.posted - a.posted);
  const cache = { fetchedAt: Date.now(), items };
  await set("jobsCache", cache);
  return cache;
}

export async function getJobs() {
  return get("jobsCache", { fetchedAt: 0, items: [] });
}

// A stable key for a job page, used to store tailored resumes and applied
// status. Listing ids win; otherwise the URL without the apply suffix.
export function jobKeyForUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/(apply|application)\/?$/i, "").replace(/\/$/, "");
    const gh = u.searchParams.get("gh_jid");
    return `${u.hostname}${path}${gh ? `?gh_jid=${gh}` : ""}`;
  } catch {
    return url;
  }
}

export function ageLabel(epochSeconds) {
  if (!epochSeconds) return "";
  const days = Math.floor((Date.now() / 1000 - epochSeconds) / 86400);
  if (days < 1) return "today";
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}
