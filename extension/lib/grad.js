// Flexible graduation date. If your profile has a window ("I could graduate
// any time from Dec 2028 to May 2030"), each job gets the date in that window
// that its posting asks for: on the tailored resume's Education line and in
// the application's graduation questions. Without a window nothing changes.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SEASON_MONTH = { spring: 4, summer: 7, fall: 11, autumn: 11, winter: 11 }; // May, Aug, Dec, Dec

// Months as one number (year * 12 + month index) so ranges are easy.
const at = (y, m) => y * 12 + m;
const yearOf = (n) => Math.floor(n / 12);
const monthOf = (n) => n % 12;

export function formatDate(n, short = false) {
  const name = MONTHS[monthOf(n)];
  const m = short ? name.slice(0, 3) : name;
  return `${m[0].toUpperCase()}${m.slice(1)} ${yearOf(n)}`;
}

const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_RE = `(?:${MONTH_RE}\\s*,?\\s*(\\d{4})|(spring|summer|fall|autumn|winter)\\s+(?:of\\s+)?(\\d{4})|(\\d{1,2})\\/(\\d{4})|((?:19|20)\\d{2}))`;

// One date in posting text -> { from, to } (a bare year covers the whole year).
function readDate(m, offset) {
  const g = (i) => m[offset + i];
  if (g(1)) {
    const n = at(Number(g(2)), MONTHS.findIndex((x) => x.startsWith(g(1).toLowerCase().slice(0, 3))));
    return { from: n, to: n };
  }
  if (g(3)) {
    const n = at(Number(g(4)), SEASON_MONTH[g(3).toLowerCase()]);
    return { from: n, to: n };
  }
  if (g(5)) {
    const n = at(Number(g(6)), Number(g(5)) - 1);
    return { from: n, to: n };
  }
  if (g(7)) return { from: at(Number(g(7)), 0), to: at(Number(g(7)), 11) };
  return null;
}

// "May 2030" / "Dec 2028" / "Fall 2028" from the profile.
export function parseDate(s) {
  const m = new RegExp(`^\\s*${DATE_RE}\\s*$`, "i").exec(String(s || ""));
  if (!m) return null;
  const d = readDate(m, 0);
  return d && d.from === d.to ? d.from : null;
}

// The summer the internship is for: "Summer 2027" in the title or posting,
// otherwise the next summer.
function internshipYear(text, title) {
  const m = /(?:summer|fall|spring|winter)\s+(20\d{2})\s+(?:intern|co-?op)/i.exec(`${title || ""} ${text}`) || /(20\d{2})\s+(?:summer\s+)?intern/i.exec(title || "");
  if (m) return Number(m[1]);
  const now = new Date();
  return now.getMonth() <= 6 ? now.getFullYear() : now.getFullYear() + 1;
}

// Student standing for a summer-Y internship -> graduation year offset.
const STANDINGS = [
  [/\brising\s+sophomores?\b/, 3],
  [/\brising\s+juniors?\b/, 2],
  [/\brising\s+seniors?\b/, 1],
  [/\b(first[- ]year|freshm[ae]n)\b/, 3],
  [/\b(second[- ]year|sophomores?)\b/, 2],
  [/\b(third[- ]year|penultimate[- ]year|juniors\b|junior year)/, 1],
  [/\b(final[- ]year|fourth[- ]year|seniors\b|senior year)/, 0],
];

// Graduation dates the posting is looking for, or null if it doesn't say.
// -> { from, to, why }
export function postingWindow(text, title = "") {
  const all = `${title}\n${text}`;
  const sentences = all.split(/(?<=[.!?;])\s+|\n+/).filter((s) => /graduat|class of|degree (completion|conferral)|expected to (complete|finish)|enrolled|first[- ]year|second[- ]year|third[- ]year|freshm|sophomore|junior|senior|penultimate|final[- ]year|rising/i.test(s));
  const date = new RegExp(DATE_RE, "gi");
  let from = null;
  let to = null;
  let why = "";
  const widen = (a, b, w) => {
    from = from === null ? a : Math.min(from, a);
    to = to === null ? b : Math.max(to, b);
    why = why || w.trim().slice(0, 140);
  };

  for (const s of sentences) {
    if (!/graduat|class of|degree|complete|finish/i.test(s)) continue;
    // Skip the internship's own dates ("Summer 2027 internship, June – August 2027").
    const dates = [...s.matchAll(date)].map((m) => ({ d: readDate(m, 0), i: m.index, len: m[0].length })).filter((x) => x.d && !/^\s*(intern|co-?op|program)/i.test(s.slice(x.i + x.len, x.i + x.len + 12)));
    if (!dates.length) continue;
    // Neighbouring dates joined by "–", "to", "and", "or"… form one range
    // ("between December 2028 and June 2029", "Fall 2028 or Spring 2029").
    const groups = [[dates[0]]];
    for (let i = 1; i < dates.length; i++) {
      const gap = s.slice(dates[i - 1].i + dates[i - 1].len, dates[i].i);
      if (/^\s*(?:-|–|—|to|and|or|through|until|thru)\s*$/i.test(gap)) groups[groups.length - 1].push(dates[i]);
      else groups.push([dates[i]]);
    }
    for (const g of groups) {
      const a = g[0].d.from;
      const b = g[g.length - 1].d.to;
      const before = s.slice(0, g[0].i);
      if (g.length === 1 && /\b(by|before|no later than|prior to|on or before)\s*$/i.test(before)) widen(at(1900, 0), b, s);
      else if (g.length === 1 && /\b(after|no earlier than|on or after)\s*$/i.test(before)) widen(a, at(2200, 0), s);
      else widen(a, b, s);
    }
  }
  if (from !== null) return { from, to, why };

  // No dates: student standing ("open to first-year students").
  const y = internshipYear(text, title);
  for (const s of sentences) {
    let low = s.toLowerCase();
    for (const [re, k] of STANDINGS) {
      if (!re.test(low)) continue;
      widen(at(y + k, 0), at(y + k, 11), s);
      low = low.replace(new RegExp(re.source, "g"), " "); // "rising juniors" isn't also "juniors"
    }
  }
  return from === null ? null : { from, to, why };
}

// The profile's window: { default, earliest, latest } or null if not flexible.
export function profileWindow(p) {
  const def = p.gradMonth && p.gradYear ? parseDate(`${p.gradMonth} ${p.gradYear}`) : null;
  const earliest = parseDate(p.gradEarliest);
  const latest = parseDate(p.gradLatest);
  if (def === null || (earliest === null && latest === null)) return null;
  return { def, earliest: Math.min(earliest ?? def, def), latest: Math.max(latest ?? def, def) };
}

// Pick the graduation date for a job. -> { date, shifted, why, outside } | null
export function gradForJob(profile, postingText, title, aiWindow = null) {
  const w = profileWindow(profile);
  if (!w) return null;
  const want = postingWindow(postingText || "", title) || aiWindow;
  if (!want) return { date: w.def, shifted: false };
  // Real graduation months: the ones in your profile (e.g. December and May).
  const months = new Set([monthOf(w.def), monthOf(w.earliest), monthOf(w.latest)]);
  const options = [];
  for (let n = w.earliest; n <= w.latest; n++) if (months.has(monthOf(n)) && n >= want.from && n <= want.to) options.push(n);
  if (!options.length) return { date: w.def, shifted: false, why: want.why, outside: true };
  const date = options.reduce((best, n) => (Math.abs(n - w.def) < Math.abs(best - w.def) ? n : best));
  return { date, shifted: date !== w.def, why: want.why };
}

// AI's { earliest, latest } ("Month YYYY" or "") -> window, or null.
export function windowFromAI(g) {
  if (!g) return null;
  const a = parseDate(g.earliest);
  const b = parseDate(g.latest);
  if (a === null && b === null) return null;
  return { from: a ?? at(1900, 0), to: b ?? at(2200, 0), why: "Claude read the posting's eligibility" };
}

// The profile to use for one job's application.
// Also fills in when the degree started (asked by Greenhouse's education
// block) if the profile doesn't say: four years before the usual graduation.
export function profileWithGrad(profile, date) {
  let p = profile;
  if (!p.schoolStart && Number(p.gradYear)) p = { ...p, schoolStart: `August ${Number(p.gradYear) - 4}` };
  if (date === null || date === undefined) return p;
  return { ...p, gradMonth: formatDate(date).split(" ")[0], gradYear: String(yearOf(date)) };
}

// Education-line change: replace the default graduation date with `date`,
// keeping the resume's month style ("Dec 2028" vs "December 2028").
export function gradChange(resume, profile, date) {
  const w = profileWindow(profile);
  if (!w || date === w.def) return null;
  const re = new RegExp(`${MONTH_RE}\\s+(\\d{4})`, "gi");
  for (const s of resume.sections || []) {
    if (s.kind !== "entries" || !/education|academic/i.test(s.title || "")) continue;
    for (const e of s.entries) {
      let hit = null;
      for (const m of (e.dates || "").matchAll(re)) {
        if (Number(m[2]) === yearOf(w.def) && MONTHS[monthOf(w.def)].startsWith(m[1].toLowerCase().slice(0, 3))) hit = m;
      }
      if (!hit) continue;
      const short = hit[1].replace(".", "").length <= 4 && hit[1].toLowerCase() !== "june" && hit[1].toLowerCase() !== "july";
      const after = e.dates.slice(0, hit.index) + formatDate(date, short) + e.dates.slice(hit.index + hit[0].length);
      return { target: e.id, field: "dates", before: e.dates, after, where: e.title || s.title };
    }
  }
  return null;
}
