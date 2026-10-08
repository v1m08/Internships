// Job sources: GitHub internship repos. Supports SimplifyJobs-style
// .github/scripts/listings.json and README tables (HTML or Markdown), as
// used by SimplifyJobs, vanshb03, speedyapply and most other lists.
// No DOM APIs here: this also runs in the background service worker.

export const DEFAULT_SOURCES = [
  { id: "simplify-2027", label: "SimplifyJobs/Summer2027-Internships", input: "SimplifyJobs/Summer2027-Internships", enabled: true },
  { id: "vanshb03-2027", label: "vanshb03/Summer2027-Internships", input: "vanshb03/Summer2027-Internships", enabled: true },
  { id: "speedyapply-2027", label: "speedyapply/2027-SWE-College-Jobs", input: "speedyapply/2027-SWE-College-Jobs", enabled: true },
];

const RAW = "https://raw.githubusercontent.com";

// "owner/repo", a github.com URL, a raw README/listings URL.
export function describeSource(input) {
  const s = (input || "").trim();
  let m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m) return { kind: "repo", owner: m[1], repo: m[2] };
  m = s.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:blob|tree)\/([^/]+)\/(.+))?/);
  if (m) {
    if (m[4]) return { kind: "url", url: `${RAW}/${m[1]}/${m[2]}/${m[3]}/${m[4]}` };
    return { kind: "repo", owner: m[1], repo: m[2].replace(/\.git$/, "") };
  }
  if (/^https?:\/\//.test(s)) return { kind: "url", url: s };
  return null;
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function fetchSource(src) {
  const d = describeSource(src.input);
  if (!d) throw new Error(`Not a GitHub repo or URL: ${src.input}`);
  if (d.kind === "url") {
    const text = await fetchText(d.url);
    return /\.json($|\?)/.test(d.url) ? parseListingsJson(text) : parseReadme(text);
  }
  for (const branch of ["dev", "HEAD"]) {
    try {
      const items = parseListingsJson(await fetchText(`${RAW}/${d.owner}/${d.repo}/${branch}/.github/scripts/listings.json`));
      if (items.length) return items;
    } catch {}
  }
  return parseReadme(await fetchText(`${RAW}/${d.owner}/${d.repo}/HEAD/README.md`));
}

// --------------------------------------------------------- listings.json

export function parseListingsJson(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("listings.json isn't an array");
  return data
    .filter((j) => j.active !== false && j.is_visible !== false && j.url)
    .map((j) => ({
      id: j.id || j.url,
      company: j.company_name || "",
      title: j.title || "",
      url: j.url,
      locations: j.locations || [],
      category: j.category || guessCategory(j.title || ""),
      sponsorship: j.sponsorship || "",
      posted: j.date_posted || j.date_updated || 0,
    }));
}

// ------------------------------------------------------------ README tables

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e) => ENTITIES[e]);
const stripTags = (s) =>
  decode(
    s
      .replace(/<br\s*\/?>/gi, " / ")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__/g, "")
  )
    .replace(/\s+/g, " ")
    .trim();

function linksIn(cell) {
  const urls = [];
  for (const m of cell.matchAll(/href="([^"]+)"/g)) urls.push(decode(m[1]));
  for (const m of cell.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) urls.push(m[1]);
  for (const m of cell.matchAll(/(?<![("])(https?:\/\/[^\s|)<"]+)/g)) urls.push(m[1]);
  return urls.filter((u) => /^https?:\/\//.test(u) && !/i\.imgur\.com|\.(png|jpg|svg|gif)(\?|$)/i.test(u));
}

function parseAge(text, now) {
  const t = (text || "").trim().toLowerCase();
  let m = t.match(/^(\d+)\s*d/);
  if (m) return now - Number(m[1]) * 86400;
  m = t.match(/^(\d+)\s*w/);
  if (m) return now - Number(m[1]) * 7 * 86400;
  m = t.match(/^(\d+)\s*mo/);
  if (m) return now - Number(m[1]) * 30 * 86400;
  const parsed = Date.parse(`${text} ${new Date().getFullYear()}`) || Date.parse(text);
  if (parsed) {
    let s = Math.floor(parsed / 1000);
    if (s > now + 86400) s -= 365 * 86400; // "Dec 20" seen in January
    return s;
  }
  return 0;
}

export function guessCategory(title) {
  const t = title.toLowerCase();
  if (/quant|trading|trader/.test(t)) return "Quant";
  if (/product manag|\bapm\b|\bpm intern/.test(t)) return "Product";
  if (/hardware|firmware|embedded|electrical|asic|fpga|silicon|circuit/.test(t)) return "Hardware";
  if (/machine learning|\bml\b|\bai\b|data scien|data eng|data anal|research/.test(t)) return "AI/ML/Data";
  return "Software";
}

function columnIndexes(headers) {
  const find = (re) => headers.findIndex((h) => re.test(h.toLowerCase()));
  return {
    company: find(/company|employer/),
    title: find(/role|position|title|job/),
    location: find(/location/),
    link: find(/application|apply|link|posting|url/),
    age: find(/age|date|posted/),
  };
}

function rowsFromHtml(text) {
  const tables = [];
  for (const t of text.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = [...t[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) => [...r[0].matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t\1>/gi)].map((c) => c[2]));
    if (rows.length > 1) tables.push(rows);
  }
  return tables;
}

function rowsFromMarkdown(text) {
  const tables = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\|/.test(line)) {
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
      (cur ||= []).push(cells);
    } else if (cur) {
      if (cur.length > 1) tables.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length > 1) tables.push(cur);
  return tables;
}

export function parseReadme(text) {
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (const table of [...rowsFromHtml(text), ...rowsFromMarkdown(text)]) {
    const cols = columnIndexes(table[0].map(stripTags));
    if (cols.company < 0 || cols.title < 0 || cols.link < 0) continue;
    let lastCompany = "";
    for (const cells of table.slice(1)) {
      const linkCell = cells[cols.link] || "";
      if (/🔒|closed/i.test(stripTags(linkCell)) || /🔒/.test(linkCell)) continue;
      const links = linksIn(linkCell);
      const url = links.find((u) => !/simplify\.jobs/.test(u)) || links[0];
      if (!url) continue;
      let company = stripTags(cells[cols.company] || "").replace(/^[🔥⭐️\s]+/u, "").trim();
      if (!company || /^↳/.test(company)) company = lastCompany;
      else lastCompany = company;
      const rawTitle = cells[cols.title] || "";
      const title = stripTags(rawTitle).replace(/[🛂🇺🇸🎓]/gu, "").trim();
      const flags = `${rawTitle} ${cells[cols.company] || ""}`;
      out.push({
        id: url,
        company,
        title,
        url,
        locations: stripTags(cells[cols.location] || "").split(/\s*\/\s*|;\s*/).filter(Boolean),
        category: guessCategory(title),
        sponsorship: /🇺🇸/u.test(flags) ? "U.S. Citizenship is Required" : /🛂/u.test(flags) ? "Does Not Offer Sponsorship" : "",
        posted: cols.age >= 0 ? parseAge(stripTags(cells[cols.age] || ""), now) : 0,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------- merge all

function dedupeKey(j) {
  try {
    const u = new URL(j.url);
    const gh = u.searchParams.get("gh_jid");
    return `${u.hostname}${u.pathname.replace(/\/(apply|application)\/?$/i, "").replace(/\/$/, "")}${gh ? `?gh_jid=${gh}` : ""}`.toLowerCase();
  } catch {
    return j.url;
  }
}

// Fetch every enabled source; returns { items, errors }.
export async function fetchAll(sources) {
  const enabled = sources.filter((s) => s.enabled);
  const results = await Promise.allSettled(enabled.map((s) => fetchSource(s)));
  const byUrl = new Map();
  const byName = new Set();
  const errors = [];
  results.forEach((r, i) => {
    const src = enabled[i];
    if (r.status === "rejected") {
      errors.push(`${src.label}: ${r.reason.message}`);
      return;
    }
    for (const j of r.value) {
      const k = dedupeKey(j);
      const nameKey = `${j.company}|${j.title}|${(j.locations[0] || "").toLowerCase()}`.toLowerCase();
      if (byUrl.has(k) || byName.has(nameKey)) {
        const prev = byUrl.get(k);
        if (prev && !prev.sources.includes(src.label)) prev.sources.push(src.label);
        continue;
      }
      byName.add(nameKey);
      byUrl.set(k, { ...j, sources: [src.label] });
    }
  });
  const items = [...byUrl.values()].sort((a, b) => b.posted - a.posted);
  return { items, errors };
}

// ----------------------------------------------------------------- filters

export const DEFAULT_FILTERS = {
  include: "", // comma-separated: role must match one (e.g. "software, data")
  exclude: "", // comma-separated: skip if role/company matches (e.g. "phd, senior")
  locations: "", // comma-separated: any location must match one (e.g. "NY, remote, CA")
  categories: [], // empty = all
  maxAgeDays: 30,
  respectSponsorship: true, // skip roles that can't sponsor / need citizenship when your profile needs sponsorship
};

const terms = (s) =>
  (s || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

export function matchesFilters(j, f, profile) {
  const title = `${j.title}`.toLowerCase();
  const all = `${j.company} ${j.title}`.toLowerCase();
  const inc = terms(f.include);
  if (inc.length && !inc.some((t) => title.includes(t))) return false;
  if (terms(f.exclude).some((t) => all.includes(t))) return false;
  const locs = terms(f.locations);
  if (locs.length && !j.locations.some((l) => locs.some((t) => l.toLowerCase().includes(t)))) return false;
  if (f.categories?.length && !f.categories.some((c) => j.category.toLowerCase().includes(c.toLowerCase().split("/")[0]))) return false;
  if (f.maxAgeDays && j.posted && Date.now() / 1000 - j.posted > f.maxAgeDays * 86400) return false;
  if (f.respectSponsorship && profile?.needsSponsorship === "yes" && /does not offer|citizenship/i.test(j.sponsorship)) return false;
  return true;
}
