// Resume → PDF. Jake's Resume compiled by real LaTeX on your computer
// (through the Claude Code bridge) when a TeX engine is installed;
// otherwise the built-in Computer Modern renderer (pdf.js), which
// reproduces the same layout.
import { resumeToLatex } from "./latex.js";
import { resumeToBase64, renderResume } from "./pdf.js";
import { bridge } from "./ai.js";

const cache = new Map(); // tex -> { base64, engine }
let latexUnavailable = null; // reason, once we know LaTeX can't be used this session

export function latexStatus() {
  return latexUnavailable;
}

export function resetLatexStatus() {
  latexUnavailable = null;
}

async function viaLatex(resume) {
  const tex = resumeToLatex(resume);
  if (cache.has(tex)) return cache.get(tex);
  const r = await bridge({ type: "latex", tex });
  const out = { base64: r.pdfBase64, engine: r.engine };
  cache.set(tex, out);
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  return out;
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
      const built = resumeToBase64(resume);
      return { base64: built.base64, engine: "built-in", note: e.message };
    }
  }
  return { base64: resumeToBase64(resume).base64, engine: "built-in" };
}

export function pageCount(resume) {
  return renderResume(resume).pages;
}
