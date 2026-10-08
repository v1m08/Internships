// Built-in PDF renderer that reproduces Jake's Resume (LaTeX) layout with
// jsPDF and Computer Modern (CMU Serif) fonts. Used when no LaTeX engine is
// available through the Claude Code bridge (see render.js). Geometry follows
// the template: 0.5in margins, 11pt body, \small (10pt) details, small-caps
// \large section titles with a rule, 0.15in list indent.

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 36; // 0.5in
const TEXT_W = PAGE_W - 2 * MARGIN; // 540pt
const LIST_X = MARGIN + 10.8; // leftmargin=0.15in
const ROW_R = LIST_X + 0.97 * TEXT_W; // tabular* {0.97\textwidth}

const FONT_FILES = { normal: "cmu-serif-regular.ttf", bold: "cmu-serif-bold.ttf", italic: "cmu-serif-italic.ttf" };
let fontData = null; // { normal: base64, ... } once loaded

// Load Computer Modern once (call before rendering; falls back to Times).
export async function loadFonts() {
  if (fontData) return true;
  try {
    const entries = await Promise.all(
      Object.entries(FONT_FILES).map(async ([style, file]) => {
        const buf = new Uint8Array(await (await fetch(chrome.runtime.getURL(`fonts/${file}`))).arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return [style, btoa(bin)];
      })
    );
    fontData = Object.fromEntries(entries);
    return true;
  } catch (e) {
    console.warn("JobPilot: couldn't load CMU fonts, using Times", e);
    return false;
  }
}

function newDoc() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  let family = "times";
  if (fontData) {
    for (const [style, data] of Object.entries(fontData)) {
      doc.addFileToVFS(FONT_FILES[style], data);
      doc.addFont(FONT_FILES[style], "CMU", style);
    }
    family = "CMU";
  }
  return { doc, family };
}

// CM fonts lack some glyphs; normalize to ones they have.
function clean(s) {
  return String(s ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/→/g, "->")
    .replace(/[^\x20-\x7e -ſ–—•…]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const displayUrl = (u) => String(u || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
const visible = (arr) => (arr || []).filter((x) => !x.hidden);

function sectionStyle(title) {
  const t = (title || "").toLowerCase();
  if (/project/.test(t)) return "project";
  if (/experience|employment|work|leadership|activities|involvement|research/.test(t)) return "experience";
  return "education";
}

function layout(resume, k) {
  const { doc, family } = newDoc();
  const pt = (n) => n * k; // scaled size
  let y = MARGIN;
  let pages = 1;

  const font = (style, size) => {
    doc.setFont(family, style);
    doc.setFontSize(size);
  };
  const width = (t) => doc.getTextWidth(t);
  const ensure = (h) => {
    if (y + h > PAGE_H - MARGIN) {
      doc.addPage();
      pages++;
      y = MARGIN;
    }
  };

  // \scshape: capitals at full size, lowercase as smaller capitals.
  const smallCaps = (text, size, style) => {
    const parts = [];
    for (const m of text.matchAll(/([^a-z]+)|([a-z]+)/g)) parts.push(m[1] ? { t: m[1], s: size } : { t: m[2].toUpperCase(), s: size * 0.8 });
    let w = 0;
    for (const p of parts) {
      font(style, p.s);
      w += width(p.t);
    }
    return { parts, w, draw: (x, by) => parts.reduce((cx, p) => (font(style, p.s), doc.text(p.t, cx, by), cx + width(p.t)), x) };
  };

  const wrapWords = (text, firstW, restW) => {
    const words = text.split(" ").filter(Boolean);
    const lines = [];
    let line = "";
    let w = firstW;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (width(test) > w && line) {
        lines.push(line);
        line = word;
        w = restW;
      } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  };

  // ---- Header
  const b = resume.basics || {};
  if (b.name) {
    // \textbf{\Huge \scshape ...}: CM has no bold small caps, so LaTeX shows plain bold.
    font("bold", pt(24.88));
    y += pt(24.88) * 0.72;
    doc.text(clean(b.name), PAGE_W / 2, y, { align: "center" });
  }
  const contact = [];
  if (b.phone) contact.push({ t: clean(b.phone) });
  if (b.email) contact.push({ t: clean(b.email), url: `mailto:${b.email}`, u: true });
  if (b.location) contact.push({ t: clean(b.location) });
  for (const l of b.links || []) if (l.url) contact.push({ t: clean(displayUrl(l.url)), url: /^https?:/.test(l.url) ? l.url : `https://${l.url}`, u: true });
  if (contact.length) {
    font("normal", pt(10));
    const sep = " | ";
    const rows = [[]];
    let rw = 0;
    for (const c of contact) {
      const w = width(c.t) + (rows[rows.length - 1].length ? width(sep) : 0);
      if (rw + w > TEXT_W && rows[rows.length - 1].length) {
        rows.push([c]);
        rw = width(c.t);
      } else {
        rows[rows.length - 1].push(c);
        rw += w;
      }
    }
    for (const row of rows) {
      y += pt(12.5);
      const total = row.reduce((a, c, i) => a + width(c.t) + (i ? width(sep) : 0), 0);
      let x = (PAGE_W - total) / 2;
      row.forEach((c, i) => {
        if (i) {
          doc.text(sep, x, y);
          x += width(sep);
        }
        const w = width(c.t);
        doc.text(c.t, x, y);
        if (c.u) {
          doc.setLineWidth(0.4);
          doc.line(x, y + pt(1.6), x + w, y + pt(1.6));
        }
        if (c.url) doc.link(x, y - pt(8), w, pt(10), { url: c.url });
        x += w;
      });
    }
  }
  y += pt(8);

  // ---- Sections
  const section = (title) => {
    ensure(pt(40));
    y += pt(22);
    const sc = smallCaps(clean(title), pt(12), "normal");
    sc.draw(MARGIN, y);
    doc.setLineWidth(0.4);
    doc.line(MARGIN, y + pt(3.2), PAGE_W - MARGIN, y + pt(3.2));
    y += pt(3);
  };

  const row = (left, right, size, leftStyle, rightStyle) => {
    if (Array.isArray(left)) {
      let x = LIST_X;
      for (const [t, st] of left) {
        font(st, size);
        doc.text(t, x, y);
        x += width(t);
      }
    } else {
      font(leftStyle, size);
      doc.text(left, LIST_X, y);
    }
    if (right) {
      font(rightStyle, size === pt(10) && rightStyle === "normal" ? pt(11) : size);
      doc.text(right, ROW_R, y, { align: "right" });
    }
  };

  const bulletList = (bullets) => {
    const items = visible(bullets).filter((x) => (x.text || "").trim());
    if (!items.length) return;
    const textX = LIST_X + pt(24.2);
    font("normal", pt(10));
    y += pt(0.5);
    for (const it of items) {
      const lines = doc.splitTextToSize(clean(it.text), PAGE_W - MARGIN - textX);
      lines.forEach((line, i) => {
        ensure(pt(12));
        y += pt(i === 0 ? 14 : 12);
        if (i === 0) doc.circle(textX - pt(8.6), y - pt(3.1), pt(1.15), "F");
        doc.text(line, textX, y);
      });
    }
    y += pt(2);
  };

  if ((resume.summary || "").trim()) {
    section("Summary");
    font("normal", pt(10));
    for (const line of doc.splitTextToSize(clean(resume.summary), ROW_R - LIST_X)) {
      ensure(pt(12));
      y += pt(12);
      doc.text(line, LIST_X, y);
    }
  }

  for (const s of resume.sections || []) {
    const entries = visible(s.entries);
    const lines = visible(s.lines).filter((l) => l.label || l.text);
    const has = s.kind === "entries" ? entries.length : s.kind === "lines" ? lines.length : (s.text || "").trim();
    if (!has) continue;
    section(s.title || "");
    const style = sectionStyle(s.title);

    if (s.kind === "entries") {
      entries.forEach((e, i) => {
        ensure(pt(28));
        y += pt(i === 0 ? 12.5 : 17);
        if (style === "project") {
          const left = [[clean(e.title), "bold"]];
          if (e.subtitle) left.push([" | ", "normal"], [clean(e.subtitle), "italic"]);
          row(left, clean(e.dates), pt(10), null, "normal");
        } else {
          const exp = style === "experience";
          const top = exp ? clean(e.subtitle || e.title) : clean(e.title);
          const topR = exp ? clean(e.dates) : clean(e.location);
          const bot = exp ? (e.subtitle ? clean(e.title) : "") : clean(e.subtitle);
          const botR = exp ? clean(e.location) : clean(e.dates);
          row(top, topR, pt(11), "bold", "normal");
          if (bot || botR) {
            y += pt(14);
            row(bot, botR, pt(10), "italic", "italic");
          }
        }
        bulletList(e.bullets);
      });
    } else {
      const items = s.kind === "lines" ? lines : [{ label: "", text: s.text }];
      y += pt(1.5);
      for (const l of items) {
        const label = l.label ? clean(l.label) : "";
        font("bold", pt(10));
        const labelW = label ? width(label) : 0;
        font("normal", pt(10));
        const text = `${label ? ": " : ""}${clean(l.text)}`;
        const wrapped = wrapWords(text, ROW_R - LIST_X - labelW, ROW_R - LIST_X);
        wrapped.forEach((line, i) => {
          ensure(pt(12));
          y += pt(12);
          if (i === 0 && label) {
            font("bold", pt(10));
            doc.text(label, LIST_X, y);
            font("normal", pt(10));
            doc.text(line, LIST_X + labelW, y);
          } else doc.text(line, LIST_X, y);
        });
      }
    }
  }
  return { doc, pages };
}

const MIN_SCALE = 0.85;
const STEP = 0.025;

// Largest scale (≤ 100% of the template's sizes, in 2.5% steps) that fits on
// one page: full size first (the usual case), then a binary search.
export function renderResume(resume) {
  const full = layout(resume, 1);
  if (full.pages === 1) return { ...full, size: 11 };
  const smallest = layout(resume, MIN_SCALE);
  if (smallest.pages > 1) return { ...smallest, size: Math.round(11 * MIN_SCALE * 10) / 10 };
  let lo = 0; // steps above MIN_SCALE known to fit
  let hi = Math.round((1 - MIN_SCALE) / STEP); // known not to fit
  let best = smallest;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const r = layout(resume, MIN_SCALE + mid * STEP);
    if (r.pages === 1) {
      lo = mid;
      best = r;
    } else hi = mid;
  }
  return { ...best, size: Math.round(11 * (MIN_SCALE + lo * STEP) * 10) / 10 };
}

// Cheap check used while tailoring: does it fit at the smallest allowed size?
export function fitsOnePage(resume) {
  return layout(resume, MIN_SCALE).pages === 1;
}

export function resumeToBase64(resume) {
  const { doc, pages } = renderResume(resume);
  const dataUri = doc.output("datauristring");
  return { base64: dataUri.slice(dataUri.indexOf(",") + 1), pages };
}

export function resumeToBlobUrl(resume) {
  const { doc } = renderResume(resume);
  return URL.createObjectURL(doc.output("blob"));
}

// Plain text version for AI prompts.
export function resumeToText(resume) {
  const out = [];
  const b = resume.basics || {};
  out.push(b.name, [b.email, b.phone, b.location, ...(b.links || []).map((l) => l.url)].filter(Boolean).join(" | "));
  if (resume.summary) out.push("", resume.summary);
  for (const s of resume.sections || []) {
    out.push("", (s.title || "").toUpperCase());
    if (s.kind === "entries") {
      for (const e of s.entries.filter((x) => !x.hidden)) {
        out.push([e.title, e.subtitle, e.location, e.dates].filter(Boolean).join(" — "));
        for (const bl of e.bullets.filter((x) => !x.hidden)) out.push(`• ${bl.text}`);
      }
    } else if (s.kind === "lines") {
      for (const l of s.lines.filter((x) => !x.hidden)) out.push(l.label ? `${l.label}: ${l.text}` : l.text);
    } else out.push(s.text);
  }
  return out.filter((x) => x !== undefined).join("\n");
}
