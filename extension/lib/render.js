// Resume → PDF. Jake's Resume compiled by real LaTeX on your computer
// (through the Claude Code bridge) when a TeX engine is installed;
// otherwise the built-in Computer Modern renderer (pdf.js), which
// reproduces the same layout.
import { resumeToLatex } from "./latex.js";
import { resumeToBase64, renderResume, loadFonts, MIN_FIT_SCALE, FIT_STEP } from "./pdf.js";
import { bridge } from "./ai.js";

const cache = new Map(); // tex -> { base64, engine }
let latexUnavailable = null; // reason, once we know LaTeX can't be used this session

export function latexStatus() {
  return latexUnavailable;
}

export function resetLatexStatus() {
  latexUnavailable = null;
}

const texCache = new Map(); // resume JSON -> tex that fit on one page

// Start at the scale the built-in renderer found (same layout numbers), then
// step down while real LaTeX still spills onto a second page.
async function viaLatex(resume) {
  await loadFonts();
  const key = JSON.stringify(resume);
  let scale = texCache.has(key) ? null : renderResume(resume).scale;
  let tex = texCache.get(key) || resumeToLatex(resume, scale);
  for (;;) {
    let out = cache.get(tex);
    if (!out) {
      const r = await bridge({ type: "latex", tex });
      out = { base64: r.pdfBase64, engine: r.engine, pages: r.pages };
      cache.set(tex, out);
      if (cache.size > 30) cache.delete(cache.keys().next().value);
    }
    if (scale === null || !(out.pages > 1) || scale <= MIN_FIT_SCALE + 1e-9) {
      texCache.set(key, tex);
      if (texCache.size > 30) texCache.delete(texCache.keys().next().value);
      return out;
    }
    scale = Math.max(MIN_FIT_SCALE, Math.round((scale - FIT_STEP) * 1000) / 1000);
    tex = resumeToLatex(resume, scale);
  }
}

// The .tex for downloads / Overleaf: the one that compiled to one page, or
// the built-in renderer's fit if it hasn't been compiled yet.
export async function texFor(resume) {
  const key = JSON.stringify(resume);
  if (texCache.has(key)) return texCache.get(key);
  await loadFonts();
  return resumeToLatex(resume, renderResume(resume).scale);
}

const builtCache = new Map(); // resume JSON -> base64

async function builtIn(resume) {
  await loadFonts();
  const key = JSON.stringify(resume);
  if (!builtCache.has(key)) {
    builtCache.set(key, resumeToBase64(resume).base64);
    if (builtCache.size > 30) builtCache.delete(builtCache.keys().next().value);
  }
  return builtCache.get(key);
}

// Returns { base64, engine: "pdflatex" | "tectonic" | … | "built-in", note? }
export async function buildResumePdf(resume, settings) {
  const wantLatex = settings.renderer !== "built-in" && settings.provider === "claude-code";
  if (wantLatex && !latexUnavailable) {
    try {
      return await viaLatex(resume);
    } catch (e) {
      // No TeX installed / old bridge: remember and fall back. A compile
      // error falls back for this resume only.
      if (e.code === "NO_TEX" || /Unknown request type|isn't installed/i.test(e.message)) latexUnavailable = e.message;
      return { base64: await builtIn(resume), engine: "built-in", note: e.message };
    }
  }
  return { base64: await builtIn(resume), engine: "built-in" };
}

export function pageCount(resume) {
  return renderResume(resume).pages;
}
