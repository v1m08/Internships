// Job listings merged from all enabled GitHub sources, cached locally.
import { get, set } from "./store.js";
import { fetchAll } from "./sources.js";

export async function refreshJobs(sources) {
  const { items, errors } = await fetchAll(sources);
  if (!items.length && errors.length) throw new Error(`Couldn't load jobs: ${errors.join("; ")}`);
  const cache = { fetchedAt: Date.now(), items, errors };
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
