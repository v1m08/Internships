// Resume data model.
//
// {
//   basics: { name, email, phone, location, links: [{ label, url }] },
//   summary: "",
//   sections: [{
//     id, title, kind: "entries" | "lines" | "text",
//     entries: [{ id, title, subtitle, location, dates, hidden, bullets: [{ id, text, hidden }] }],
//     lines:   [{ id, label, text, hidden }],
//     text: "",
//   }],
// }

let counter = 0;
export const uid = (p) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const clone = (o) => JSON.parse(JSON.stringify(o));

export function emptyResume() {
  return {
    basics: { name: "", email: "", phone: "", location: "", links: [] },
    summary: "",
    sections: [],
  };
}

export function newSection(kind = "entries", title = "New Section") {
  return { id: uid("s"), title, kind, entries: [], lines: [], text: "" };
}

export function newEntry() {
  return { id: uid("e"), title: "", subtitle: "", location: "", dates: "", hidden: false, bullets: [newBullet()] };
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
  };
  r.summary = p.summary || "";
  r.sections = (p.sections || []).map((s) => ({
    id: uid("s"),
    title: s.title || "",
    kind: ["entries", "lines", "text"].includes(s.kind) ? s.kind : "entries",
    entries: (s.entries || []).map((e) => ({
      id: uid("e"),
      title: e.title || "",
      subtitle: e.subtitle || "",
      location: e.location || "",
      dates: e.dates || "",
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

// Compact view sent to the AI for tailoring: ids + text only.
export function forAI(r) {
  return {
    summary: r.summary,
    sections: r.sections.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      entries: s.entries.map((e) => ({
        id: e.id,
        title: e.title,
        subtitle: e.subtitle,
        dates: e.dates,
        hidden: e.hidden,
        bullets: e.bullets.map((b) => ({ id: b.id, text: b.text, hidden: b.hidden })),
      })),
      lines: s.lines.map((l) => ({ id: l.id, label: l.label, text: l.text })),
      text: s.text,
    })),
  };
}

function index(r) {
  const bullets = new Map();
  const lines = new Map();
  const sections = new Map();
  for (const s of r.sections) {
    sections.set(s.id, s);
    for (const e of s.entries) for (const b of e.bullets) bullets.set(b.id, { b, e, s });
    for (const l of s.lines) lines.set(l.id, { l, s });
  }
  return { bullets, lines, sections };
}

// Convert the AI's tailoring output into a reviewable list of changes,
// dropping anything that references ids that don't exist.
export function changesFromTailoring(r, t) {
  const { bullets, lines, sections } = index(r);
  const changes = [];
  for (const ed of t.bullet_edits || []) {
    const hit = bullets.get(ed.id);
    if (!hit || !ed.text || ed.text.trim() === hit.b.text.trim()) continue;
    changes.push({ id: uid("c"), type: "bullet", target: ed.id, where: hit.e.title || hit.s.title, before: hit.b.text, after: ed.text.trim(), reason: ed.reason, accepted: true });
  }
  for (const ed of t.line_edits || []) {
    const hit = lines.get(ed.id);
    if (!hit || !ed.text || ed.text.trim() === hit.l.text.trim()) continue;
    changes.push({ id: uid("c"), type: "line", target: ed.id, where: hit.l.label || hit.s.title, before: hit.l.text, after: ed.text.trim(), reason: ed.reason, accepted: true });
  }
  for (const id of t.hide_bullet_ids || []) {
    const hit = bullets.get(id);
    if (!hit || hit.b.hidden) continue;
    changes.push({ id: uid("c"), type: "hide", target: id, where: hit.e.title || hit.s.title, before: hit.b.text, after: "(hidden for this job)", reason: "Less relevant to this role", accepted: true });
  }
  for (const o of t.entry_orders || []) {
    const s = sections.get(o.section_id);
    if (!s || s.kind !== "entries") continue;
    const current = s.entries.map((e) => e.id);
    const proposed = o.entry_ids.filter((id) => current.includes(id));
    for (const id of current) if (!proposed.includes(id)) proposed.push(id);
    if (proposed.join() === current.join()) continue;
    const name = (id) => s.entries.find((e) => e.id === id).title || "(untitled)";
    changes.push({ id: uid("c"), type: "order", target: s.id, order: proposed, where: s.title, before: current.map(name).join(" → "), after: proposed.map(name).join(" → "), reason: o.reason, accepted: true });
  }
  if (t.summary && t.summary.trim() && t.summary.trim() !== (r.summary || "").trim() && (r.summary || "").trim()) {
    changes.push({ id: uid("c"), type: "summary", target: "summary", where: "Summary", before: r.summary, after: t.summary.trim(), reason: t.summary_reason, accepted: true });
  }
  return changes;
}

export function applyChanges(base, changes) {
  const r = clone(base);
  const { bullets, lines, sections } = index(r);
  for (const c of changes) {
    if (!c.accepted) continue;
    if (c.type === "bullet" && bullets.has(c.target)) bullets.get(c.target).b.text = c.after;
    if (c.type === "line" && lines.has(c.target)) lines.get(c.target).l.text = c.after;
    if (c.type === "hide" && bullets.has(c.target)) bullets.get(c.target).b.hidden = true;
    if (c.type === "summary") r.summary = c.after;
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
