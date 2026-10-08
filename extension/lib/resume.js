// Resume data model.
//
// {
//   basics: { name, email, phone, location, links: [{ label, url }], contactOrder: ["phone", "email", "location", "links"] },
//   summary: "",
//   sections: [{
//     id, title, kind: "entries" | "lines" | "text",
//     layout: "heading" | "inline" | "row", order: "org-first" | "role-first", datesOn: "top" | "bottom",  (see layout.js)
//     entries: [{ id, title, subtitle, location, dates, linkLabel, url, orgLink, hidden, bullets: [{ id, text, hidden }] }],
//     lines:   [{ id, label, text, hidden }],
//     (bullet and line text may contain **bold** markup)
//     text: "",
//   }],
// }

let counter = 0;
export const uid = (p) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const clone = (o) => JSON.parse(JSON.stringify(o));

export function emptyResume() {
  return {
    basics: { name: "", email: "", phone: "", location: "", links: [], contactOrder: ["phone", "email", "location", "links"] },
    summary: "",
    sections: [],
  };
}

export function newSection(kind = "entries", title = "New Section") {
  return { id: uid("s"), title, kind, layout: "heading", order: "org-first", datesOn: "top", entries: [], lines: [], text: "" };
}

export function newEntry() {
  return { id: uid("e"), title: "", subtitle: "", location: "", dates: "", linkLabel: "", url: "", orgLink: false, hidden: false, bullets: [newBullet()] };
}

export function newBullet(text = "") {
  return { id: uid("b"), text, hidden: false };
}

export function newLine() {
  return { id: uid("l"), label: "", text: "", hidden: false };
}

// Turn the AI's parse output (no ids) into the stored model (with ids).
export function fromParsed(p) {
  const r = emptyResume();
  const b = p.basics || {};
  r.basics = {
    name: b.name || "",
    email: b.email || "",
    phone: b.phone || "",
    location: b.location || "",
    links: (b.links || []).filter((l) => l.url).map((l) => ({ label: l.label || "", url: l.url })),
    contactOrder: b.contact_order?.length ? [...new Set(b.contact_order)] : ["phone", "email", "location", "links"],
  };
  r.summary = p.summary || "";
  r.sections = (p.sections || []).map((s) => ({
    id: uid("s"),
    title: s.title || "",
    kind: ["entries", "lines", "text"].includes(s.kind) ? s.kind : "entries",
    layout: ["heading", "inline", "row"].includes(s.layout) ? s.layout : "heading",
    order: s.heading_order === "role-first" ? "role-first" : "org-first",
    datesOn: s.dates_position === "bottom" ? "bottom" : "top",
    entries: (s.entries || []).map((e) => ({
      id: uid("e"),
      title: e.title || "",
      subtitle: e.subtitle || "",
      location: e.location || "",
      dates: e.dates || "",
      linkLabel: e.link_label || "",
      url: e.link_url || "",
      orgLink: !!e.org_is_link,
      hidden: false,
      bullets: (e.bullets || []).map((t) => newBullet(t)),
    })),
    lines: (s.lines || []).map((l) => ({ id: uid("l"), label: l.label || "", text: l.text || "", hidden: false })),
    text: s.text || "",
  }));
  return r;
}

// Profile fields (for autofill) suggested by the AI parse, merged under the
// user's existing profile values (existing non-empty values win).
export function mergeProfile(profile, suggested) {
  const out = { ...profile };
  for (const [k, v] of Object.entries(suggested || {})) {
    if (v && !out[k]) out[k] = v;
  }
  return out;
}

function index(r) {
  const bullets = new Map();
  const lines = new Map();
  const sections = new Map();
  const entries = new Map();
  for (const s of r.sections) {
    sections.set(s.id, s);
    for (const e of s.entries) entries.set(e.id, e);
    for (const e of s.entries) for (const b of e.bullets) bullets.set(b.id, { b, e, s });
    for (const l of s.lines) lines.set(l.id, { l, s });
  }
  return { bullets, lines, sections, entries };
}

export function applyChanges(base, changes) {
  const r = clone(base);
  const { bullets, lines, sections, entries } = index(r);
  for (const c of changes) {
    if (!c.accepted) continue;
    if (c.type === "bullet" && bullets.has(c.target)) bullets.get(c.target).b.text = c.after;
    if (c.type === "line" && lines.has(c.target)) lines.get(c.target).l.text = c.after;
    if (c.type === "hide" && bullets.has(c.target)) bullets.get(c.target).b.hidden = true;
    if (c.type === "summary") r.summary = c.after;
    if (c.type === "grad" && entries.has(c.target)) entries.get(c.target)[c.field] = c.after;
    if (c.type === "order" && sections.has(c.target)) {
      const s = sections.get(c.target);
      s.entries = c.order.map((id) => s.entries.find((e) => e.id === id)).filter(Boolean);
    }
  }
  return r;
}

export function splitName(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts[parts.length - 1] };
}

export function fileNameFor(pattern, resume, profile, company, role) {
  const { first, last } = splitName(resume?.basics?.name);
  const safe = (s) => (s || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  let name = (pattern || "{First}_{Last}_Resume_{Company}")
    .replace("{First}", safe(profile.firstName || first))
    .replace("{Last}", safe(profile.lastName || last))
    .replace("{Company}", safe(company))
    .replace("{Role}", safe(role));
  name = name.replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "Resume";
  return `${name}.pdf`;
}
