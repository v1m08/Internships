// Is this job a fit for you? Claude reads your resume once and writes a job
// target (what kinds of roles, which fields are out, your degree level);
// every listing is then scored against it without AI, from its title,
// category, degree requirements and term. The target is editable in
// Settings → What jobs to look for.
//
// Levels: "good" (★ good fit), "fit", "stretch" (adjacent), "no" (not a fit).

const GENERIC = /^(engineering intern|engineering|engineer|intern|internship|research|data|ai|ml|web|technology|tech|developer)$/i;

export const CATEGORIES = ["Software", "AI/ML/Data", "Quant", "Product", "Hardware"];

export const DEFAULT_TARGET = {
  summary: "",
  categories: [], // from CATEGORIES; empty = not set yet
  include: [], // title words that mean a good fit ("software", "machine learning")
  exclude: [], // title words that rule a job out ("electrical", "mechanical")
  degree: "Bachelor's", // Bachelor's | Master's | PhD
  builtAt: 0,
};

const words = (list) => (list || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
const hit = (title, list) => words(list).find((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`, "i").test(title));

// "Software Engineering" -> "Software", "Data Science, AI & ML" -> "AI/ML/Data"
function categoryOf(c) {
  const t = String(c || "").toLowerCase();
  if (/software/.test(t)) return "Software";
  if (/ai|ml|machine|data/.test(t)) return "AI/ML/Data";
  if (/quant/.test(t)) return "Quant";
  if (/product/.test(t)) return "Product";
  if (/hardware|electrical|mechanical/.test(t)) return "Hardware";
  return "";
}

// Degree level the title asks for, if it says ("MS/PhD" yes, "BS/MS" includes you).
function titleDegrees(title) {
  const t = title.toLowerCase();
  const out = new Set();
  if (/\bph\.?\s?d\b|doctoral/.test(t)) out.add("PhD");
  if (/\bmaster'?s\b|\bm\.?s\.?\b(?!\s*(office|word|excel))|\bmeng\b|graduate student/.test(t)) out.add("Master's");
  if (/\bmba\b/.test(t)) out.add("MBA");
  if (/\bbachelor'?s\b|\bb\.?s\.?\b|\bundergrad/.test(t)) out.add("Bachelor's");
  return out;
}

// Terms that already started aren't worth applying to.
const SEASON_START = { winter: 0, spring: 0, summer: 4, fall: 7, autumn: 7 };
function termStarted(term, now = new Date()) {
  const m = /^(winter|spring|summer|fall|autumn)\s+(20\d\d)$/i.exec(String(term).trim());
  if (!m) return false;
  const start = new Date(Number(m[2]), SEASON_START[m[1].toLowerCase()], 1);
  return start < now;
}

// listing: { title, category, degrees?, terms? } -> { level, reasons }
export function fitOf(listing, target) {
  const t = target || DEFAULT_TARGET;
  if (!t.categories?.length && !t.include?.length) return { level: "fit", reasons: [] }; // no target yet
  const title = String(listing.title || "");
  const reasons = [];

  // Degree: listing's own degree list first, then the title.
  const mine = t.degree || "Bachelor's";
  const listed = (listing.degrees || []).filter((d) => d !== "Associate's");
  if (listed.length && !listed.includes(mine)) return { level: "no", reasons: [`For ${listed.join("/")} students`] };
  const td = titleDegrees(title);
  if (td.size && !td.has(mine)) return { level: "no", reasons: [`For ${[...td].join("/")} students`] };

  // Term already under way (e.g. a Fall 2026 co-op in October 2026).
  const terms = listing.terms || [];
  if (terms.length && terms.every((x) => termStarted(x))) return { level: "no", reasons: [`${terms.join(", ")} already started`] };

  const cat = categoryOf(listing.category);
  const catOk = !t.categories?.length || !cat || t.categories.includes(cat);
  const good = hit(title, t.include);
  const specific = good && !GENERIC.test(good);

  // An excluded word rules a job out, unless the title is also clearly your
  // kind of role ("Privacy and Civil Liberties Software Engineer").
  const bad = hit(title, t.exclude);
  if (bad && !specific) return { level: "no", reasons: [`"${bad}" role`] };
  if (bad) return { level: catOk ? "fit" : "stretch", reasons: [`"${good}" role, though it mentions "${bad}"`] };
  if (catOk && good) return { level: "good", reasons: [`Matches "${good}"`] };
  if (catOk) return { level: "fit", reasons: [] };
  // Another category only counts as a stretch for a specific term
  // ("machine learning"), not a generic one ("engineering intern").
  if (specific) return { level: "stretch", reasons: [`${cat} role, but mentions "${good}"`] };
  return { level: "no", reasons: [`${cat} role`] };
}

// The posting itself (Apply tab, Autopilot): degree programs it requires.
export function fitFromPosting(text, target) {
  const mine = (target || DEFAULT_TARGET).degree || "Bachelor's";
  if (mine !== "Bachelor's") return null;
  for (const s of String(text || "").split(/(?<=[.!?;])\s+|\n+/)) {
    if (s.length > 400) continue;
    const needsGrad = /(currently )?(pursuing|enrolled in|candidates? for|working towards?)\s+(a |an )?(ph\.?\s?d|doctoral|master'?s|graduate)( degree| program)?/i.test(s);
    if (needsGrad && !/bachelor|undergrad|b\.?s\.?\b/i.test(s)) return { level: "no", reasons: [`Requires a graduate program: "${s.trim().slice(0, 140)}"`] };
  }
  return null;
}

export const FIT_RANK = { good: 0, fit: 1, stretch: 2, no: 3 };
export const FIT_LABEL = { good: "★ Good fit", fit: "", stretch: "~ Stretch", no: "Not a fit" };
