// Built-in PDF renderer for Jake's Resume style, with jsPDF and Computer
// Modern (CMU Serif) fonts. Used when no LaTeX engine is available through
// the Claude Code bridge (see render.js). Positions come from layout.js, the
// same numbers latex.js uses, so both renderers fit the same content on a page.
import { METRICS as M, entryLines, richRuns, contactItems, sectionLayout, plain } from "./layout.js";

const PAGE_W = M.page.w;
const PAGE_H = M.page.h;
const SIDE = M.page.side;
const TEXT_R = PAGE_W - SIDE; // right edge of the text block
const LIST_X = SIDE + M.indent;
const ROW_R = LIST_X + M.rowWidth * (PAGE_W - 2 * SIDE);

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
function clean(s, keepEdges = false) {
  const out = String(s ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/→/g, "->")
    .replace(/[^\x20-\x7e -ſ–—•…]/gu, "")
    .replace(/\s+/g, " ");
  return keepEdges ? out : out.trim();
}

const visible = (arr) => (arr || []).filter((x) => !x.hidden);

function layout(resume, k) {
  const { doc, family } = newDoc();
  const S = M.size;
  const G = M.gap;
  const pt = (n) => n * k;
  const bottomY = PAGE_H - M.page.bottom;
  let y = M.page.top;
  let pages = 1;

  const font = (style, size) => {
    doc.setFont(family, style === "bolditalic" ? "bold" : style);
    doc.setFontSize(size);
  };
  const width = (t) => doc.getTextWidth(t);
  // Move down to the next baseline, starting a new page when needed.
  const down = (g) => {
    y += pt(g);
    if (y > bottomY) {
      doc.addPage();
      pages++;
      y = M.page.top + pt(G.bullet);
    }
  };

  // \scshape: capitals at full size, lowercase as smaller capitals.
  const smallCaps = (text, size) => {
    let x = SIDE;
    for (const m of text.matchAll(/([^a-z]+)|([a-z]+)/g)) {
      const t = m[1] || m[2].toUpperCase();
      font("normal", m[1] ? size : size * 0.8);
      doc.text(t, x, y);
      x += width(t);
    }
  };

  // Styled runs -> words, so lines can wrap mid-run. `space` = a space before it.
  const words = (runs) => {
    const out = [];
    let space = false;
    for (const r of runs) {
      for (const tok of clean(r.t, true).split(/(\s+)/)) {
        if (!tok) continue;
        if (/^\s/.test(tok)) space = true;
        else {
          out.push({ t: tok, r, space });
          space = false;
        }
      }
    }
    return out;
  };
  const wordW = (w, size) => (font(w.r.style, size), width(w.t));
  const spaceW = (size) => (font("normal", size), width(" "));

  // Draw runs from x, wrapping at maxX; later lines start at x too.
  const drawRuns = (runs, x, maxX, size, lineGap = G.bullet) => {
    let cx = x;
    let lineStart = true;
    for (const w of words(runs)) {
      const ww = wordW(w, size);
      const sp = lineStart ? 0 : w.space ? spaceW(size) : 0;
      if (!lineStart && cx + sp + ww > maxX) {
        down(lineGap);
        cx = x;
      } else cx += sp;
      font(w.r.style, size);
      doc.text(w.t, cx, y);
      if (w.r.u) {
        doc.setLineWidth(0.4);
        doc.line(cx, y + pt(1.6), cx + ww, y + pt(1.6));
      }
      if (w.r.url) doc.link(cx, y - size * 0.8, ww, size, { url: w.r.url });
      cx += ww;
      lineStart = false;
    }
  };
  const runsWidth = (runs, size) => words(runs).reduce((a, w, i) => a + wordW(w, size) + (i && w.space ? spaceW(size) : 0), 0);

  const row = (left, right, ls, rs) => {
    const rw = right.length ? runsWidth(right, rs) : 0;
    if (rw) drawRuns(right, ROW_R - rw, ROW_R + 1, rs);
    drawRuns(left, LIST_X, rw ? ROW_R - rw - 8 : ROW_R, ls);
  };

  // ---- Header
  const b = resume.basics || {};
  let started = false;
  if (b.name) {
    y += pt(27.2);
    font("bold", pt(S.name));
    doc.text(clean(b.name), PAGE_W / 2, y, { align: "center" });
    started = true;
  }
  const contact = contactItems(b).map((c) => ({ ...c, t: clean(c.t) }));
  if (contact.length) {
    if (started) down(G.nameToContact);
    else y += pt(27.2);
    font("normal", pt(S.contact));
    const sep = " | ";
    const rows = [[]];
    let rw = 0;
    for (const c of contact) {
      const w = width(c.t) + (rows[rows.length - 1].length ? width(sep) : 0);
      if (rw + w > TEXT_R - SIDE && rows[rows.length - 1].length) {
        rows.push([c]);
        rw = width(c.t);
      } else {
        rows[rows.length - 1].push(c);
        rw += w;
      }
    }
    rows.forEach((items, ri) => {
      if (ri) down(G.bullet);
      const total = items.reduce((a, c, i) => a + width(c.t) + (i ? width(sep) : 0), 0);
      let x = (PAGE_W - total) / 2;
      items.forEach((c, i) => {
        if (i) {
          doc.text(sep, x, y);
          x += width(sep);
        }
        const w = width(c.t);
        doc.text(c.t, x, y);
        if (c.url) {
          doc.setLineWidth(0.4);
          doc.line(x, y + pt(1.6), x + w, y + pt(1.6));
          doc.link(x, y - pt(7), w, pt(9), { url: c.url });
        }
        x += w;
      });
    });
  }

  let prev = "contact";
  const section = (title) => {
    down(prev === "contact" ? G.contactToSection : prev === "line" ? G.linesToSection : G.toSection);
    smallCaps(clean(title), pt(S.section));
    doc.setLineWidth(0.4);
    doc.line(SIDE, y + pt(G.ruleBelowTitle) - 0.2, TEXT_R, y + pt(G.ruleBelowTitle) - 0.2);
    prev = "title";
  };

  const bulletList = (bullets) => {
    const items = visible(bullets).filter((x) => (x.text || "").trim());
    items.forEach((it, i) => {
      down(i === 0 ? G.headingToBullet : G.bullet);
      doc.circle(SIDE + M.bulletX + pt(1.2), y - pt(3.1), pt(1.15), "F");
      drawRuns(richRuns(it.text), SIDE + M.bulletTextX, TEXT_R, pt(S.bullet));
    });
    if (items.length) prev = "bullet";
  };

  const textLines = (items) => {
    items.forEach((l, i) => {
      down(i === 0 ? G.sectionToLines : G.line);
      const runs = l.label ? [{ t: l.label, style: "bold" }, { t: ": ", style: "normal" }, ...richRuns(l.text)] : richRuns(l.text);
      drawRuns(runs, LIST_X, TEXT_R, pt(S.line), G.line);
    });
    prev = "line";
  };

  if ((resume.summary || "").trim()) {
    section("Summary");
    textLines([{ label: "", text: resume.summary }]);
  }

  for (const s of resume.sections || []) {
    const entries = visible(s.entries);
    const lines = visible(s.lines).filter((l) => l.label || l.text);
    const has = s.kind === "entries" ? entries.length : s.kind === "lines" ? lines.length : (s.text || "").trim();
    if (!has) continue;
    section(s.title || "");

    if (s.kind === "entries") {
      const { layout: look } = sectionLayout(s);
      for (const e of entries) {
        for (const line of entryLines(s, e)) {
          if (line.kind === "bottom") down(G.topToBottom);
          else if (prev === "title") down(look === "inline" ? G.sectionToInline : look === "row" ? G.sectionToRow : G.sectionToHeading);
          else if (prev === "row") down(G.afterRowToRow);
          else down(look === "inline" ? G.afterBulletsToInline : G.afterBulletsToHeading);
          const ls = { top: S.top, bottom: S.bottom, inline: S.inline, row: S.row }[line.kind];
          const rs = { top: S.topRight, bottom: S.bottom, inline: S.inlineRight, row: S.row }[line.kind];
          row(line.left, line.right, pt(ls), pt(rs));
          prev = line.kind === "row" ? "row" : "heading";
        }
        bulletList(e.bullets);
      }
    } else textLines(s.kind === "lines" ? lines : [{ label: "", text: s.text }]);
  }
  return { doc, pages };
}

const MIN_SCALE = 0.85;
const STEP = 0.025;
// Tailoring hides bullets rather than shrink text below this.
export const TAILOR_MIN_SCALE = 0.925;

// Largest scale (≤ 100% of the template's sizes, in 2.5% steps) that fits on
// one page: full size first (the usual case), then a binary search. latex.js
// takes the same scale.
export function renderResume(resume) {
  const full = layout(resume, 1);
  if (full.pages === 1) return { ...full, scale: 1 };
  const smallest = layout(resume, MIN_SCALE);
  if (smallest.pages > 1) return { ...smallest, scale: MIN_SCALE };
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
  return { ...best, scale: Math.round((MIN_SCALE + lo * STEP) * 1000) / 1000 };
}

export const MIN_FIT_SCALE = MIN_SCALE;
export const FIT_STEP = STEP;

// Used while tailoring: does it fit without shrinking text below `scale`?
export function fitsOnePage(resume, scale = TAILOR_MIN_SCALE) {
  return layout(resume, scale).pages === 1;
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
        for (const bl of e.bullets.filter((x) => !x.hidden)) out.push(`• ${plain(bl.text)}`);
      }
    } else if (s.kind === "lines") {
      for (const l of s.lines.filter((x) => !x.hidden)) out.push(l.label ? `${l.label}: ${plain(l.text)}` : plain(l.text));
    } else out.push(s.text);
  }
  return out.filter((x) => x !== undefined).join("\n");
}
