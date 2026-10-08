// What goes where on the page, shared by the LaTeX generator (latex.js) and
// the built-in renderer (pdf.js) so both draw the same resume.
//
// Sizes and gaps are measured from a real Jake's Resume PDF (in points, at
// scale 1). Gaps are baseline-to-baseline distances. Both renderers multiply
// every size and gap by one scale factor to fit the page.

export const METRICS = {
  page: { w: 612, h: 792, side: 36, top: 26, bottom: 14.4 },
  indent: 10.8, // entries start 0.15in in from the margin
  rowWidth: 0.97, // right column ends at 0.97 of the text width
  bulletX: 24.1, // bullet dot, from the margin
  bulletTextX: 32.7, // bullet text, from the margin
  size: { name: 24.88, contact: 9, section: 12, top: 10, topRight: 10, bottom: 9, inline: 9, inlineRight: 10, row: 9, bullet: 9, line: 9, text: 9 },
  gap: {
    nameToContact: 13,
    contactToSection: 22.2,
    sectionToHeading: 15.8,
    sectionToInline: 17.9,
    sectionToLines: 15.6,
    sectionToRow: 15.1,
    afterBulletsToHeading: 11, // next entry in the same section
    afterBulletsToInline: 13,
    afterRowToRow: 11,
    topToBottom: 12,
    headingToBullet: 9.2,
    bullet: 11, // between bullet lines, wrapped or not
    line: 11, // skills rows
    toSection: 14.3, // last line of a section to the next section title
    linesToSection: 15.2,
    ruleBelowTitle: 3.4, // section rule, below the title baseline
  },
};

// Section looks. Entries in a "heading" section have two lines (org and
// role); "inline" puts everything on one line (projects); "row" is a single
// line with no bullets (awards).
export const LAYOUTS = [
  ["heading", "Two-line heading (organization / role)"],
  ["inline", "One line: name | details (projects)"],
  ["row", "Single line, no bullets (awards)"],
];
export const ORDERS = [
  ["org-first", "Organization on top, role below"],
  ["role-first", "Role on top, organization below"],
];
export const DATES_ON = [
  ["top", "Dates on the top line"],
  ["bottom", "Dates on the second line"],
];

// Resumes parsed before layouts existed: guess from the section title.
export function sectionLayout(s) {
  const t = (s.title || "").toLowerCase();
  const guess = /project/.test(t)
    ? { layout: "inline", order: "org-first", datesOn: "top" }
    : /award|honor|achievement|certification/.test(t)
      ? { layout: "row", order: "org-first", datesOn: "top" }
      : /experience|employment|work|leadership|activities|involvement|research/.test(t)
        ? { layout: "heading", order: "org-first", datesOn: "top" }
        : { layout: "heading", order: "org-first", datesOn: "bottom" };
  return { layout: s.layout || guess.layout, order: s.order || guess.order, datesOn: s.datesOn || guess.datesOn };
}

// "**Activities:** AI Safety" -> [{ t: "Activities:", style: "bold" }, { t: " AI Safety", style }]
export function richRuns(text, style = "normal") {
  const out = [];
  const s = String(text ?? "");
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: s.slice(last, m.index), style });
    out.push({ t: m[1], style: style === "italic" ? "bolditalic" : "bold" });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: s.slice(last), style });
  return out.filter((r) => r.t);
}

export const plain = (text) => String(text ?? "").replace(/\*\*(.+?)\*\*/g, "$1");

const run = (t, style, extra = {}) => (t ? [{ t, style, ...extra }] : []);
const orgRuns = (e, style) => run(e.title, style, e.orgLink ? { u: true, url: e.url || "" } : {});

// One entry -> the lines of its heading:
// [{ kind: "top" | "bottom" | "inline" | "row", left: runs, right: runs }]
export function entryLines(s, e) {
  const { layout, order, datesOn } = sectionLayout(s);
  const linkRuns = e.linkLabel ? run(e.linkLabel, "normal", { u: true, url: e.url || "" }) : [];

  if (layout === "inline") {
    const left = run(e.title, "bold", e.orgLink && !e.linkLabel ? { u: true, url: e.url || "" } : {});
    if (e.subtitle) left.push({ t: " | ", style: "normal" }, ...richRuns(e.subtitle, "italic"));
    const right = e.dates ? run(e.dates, "normal") : linkRuns.length ? linkRuns : run(e.location, "normal");
    return [{ kind: "inline", left, right }];
  }

  if (layout === "row") {
    const left = orgRuns(e, "bold");
    const rest = String(e.subtitle || "");
    if (rest) {
      // Keep the resume's own separator (", Boy Scouts…" or "– Full-ride…").
      const sep = /^[,;:]/.test(rest) ? "" : /^[–—-]/.test(rest) ? " " : " – ";
      left.push(...richRuns(sep + rest, "normal"));
    }
    return [{ kind: "row", left, right: run(e.dates || e.location, "normal") }];
  }

  const roleFirst = order === "role-first" && e.subtitle;
  const topLeft = roleFirst ? run(e.subtitle, "bold") : orgRuns(e, "bold");
  const bottomLeft = roleFirst ? orgRuns(e, "italic") : richRuns(e.subtitle, "italic");
  const dates = run(e.dates, "normal");
  const loc = run(e.location, "normal");
  const top = { kind: "top", left: topLeft, right: datesOn === "top" ? dates : loc.length ? loc : linkRuns };
  const bottom = { kind: "bottom", left: bottomLeft, right: (datesOn === "top" ? loc : dates).map((r) => ({ ...r, style: "italic" })) };
  return bottom.left.length || bottom.right.length ? [top, bottom] : [top];
}

const displayUrl = (u) => String(u || "").replace(/^https?:\/\//, "").replace(/^mailto:/, "").replace(/^www\./, "").replace(/\/$/, "");
export const fullUrl = (u) => (!u ? "" : /^(https?:|mailto:)/.test(u) ? u : `https://${u}`);

// Contact line items in the resume's order: [{ t, url? }]
export function contactItems(b) {
  // The resume's order, then anything it didn't mention.
  const order = [...new Set([...(b.contactOrder || []), "phone", "email", "location", "links"])];
  const out = [];
  for (const key of order) {
    if (key === "phone" && b.phone) out.push({ t: b.phone });
    if (key === "email" && b.email) out.push({ t: b.email, url: `mailto:${b.email}` });
    if (key === "location" && b.location) out.push({ t: b.location });
    if (key === "links") for (const l of b.links || []) if (l.url) out.push({ t: displayUrl(l.url), url: fullUrl(l.url) });
  }
  return out;
}
