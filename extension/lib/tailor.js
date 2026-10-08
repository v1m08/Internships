// Per-job pipeline shared by the Apply tab and Autopilot:
//   deterministic: keywords, skills/project order, standard answers, page fit
//   AI (one call):  bullet rewrites + answers to the remaining questions
import * as K from "./keywords.js";
import * as A from "./answers.js";
import * as R from "./resume.js";
import { rewriteAndAnswer } from "./ai.js";
import { fitsOnePage, resumeToText, loadFonts } from "./pdf.js";

const REWRITE_SECTIONS = /experience|project|research|leadership|work|employment/i;

function rewriteCandidates(resume) {
  const out = [];
  for (const s of resume.sections || []) {
    if (s.kind !== "entries" || !REWRITE_SECTIONS.test(s.title || "")) continue;
    for (const e of s.entries) {
      if (e.hidden) continue;
      for (const b of e.bullets) if (!b.hidden && b.text.trim()) out.push({ id: b.id, text: b.text, where: e.title || s.title });
    }
  }
  return out;
}

// Hide least-relevant bullets until the resume fits on one page.
function fitOnePage(resume, weights) {
  const hidden = [];
  let r = resume;
  for (const cand of K.hideCandidates(resume, weights)) {
    if (fitsOnePage(r)) break;
    const left = r.sections.flatMap((s) => s.entries || []).find((e) => e.id === cand.entry)?.bullets.filter((b) => !b.hidden).length || 0;
    if (left <= 2) continue;
    r = R.applyChanges(r, [{ type: "hide", target: cand.id, accepted: true }]);
    hidden.push(cand.id);
  }
  return hidden;
}

/**
 * opts: { settings, base, posting: {text,url}, job: {company,title}, profile,
 *         savedAnswers, questions = [], useAI = true, autopilot = false }
 * Returns { company, role, keywords, missing, changes, answers, aiUsed }
 *   answers: [{ qid, answer, source: "rule"|"saved"|"ai", kind, required }]
 */
export async function prepareJob(opts) {
  const { settings, base, posting, job = {}, profile, savedAnswers = {}, questions = [], useAI = true, autopilot = false } = opts;
  const text = posting?.text || "";
  await loadFonts(); // page-fit checks need the real font metrics
  const resumeText = resumeToText(base);
  const { keywords, missing, weights } = K.analyze(text, resumeText);
  const changes = K.deterministicChanges(base, weights, R.uid);

  // Standard questions without AI.
  const answers = [];
  const pending = [];
  for (const q of questions) {
    const det = A.answerDeterministically(q, profile, savedAnswers);
    if (det) answers.push({ ...q, answer: det.answer, source: det.source });
    else if (autopilot && !q.required && /text/.test(q.kind)) answers.push({ ...q, answer: "", source: "skipped" }); // optional essays: leave blank
    else pending.push(q);
  }

  // One AI call: bullet rewrites (only if the posting shares skills with the resume) + remaining questions.
  let aiUsed = false;
  const bullets = keywords.length ? rewriteCandidates(base).map(({ id, text }) => ({ id, text })) : [];
  if (useAI && (bullets.length || pending.length)) {
    aiUsed = true;
    const out = await rewriteAndAnswer(settings, {
      bullets,
      keywords,
      posting: K.trimPosting(text),
      questions: pending,
      resumeText,
      profile,
      company: job.company,
      role: job.title,
    });
    const resumeTerms = K.termsOf(resumeText);
    const byId = Object.fromEntries(rewriteCandidates(base).map((b) => [b.id, b]));
    for (const ed of out.bullet_edits || []) {
      const b = byId[ed.id];
      const after = (ed.text || "").trim();
      if (!b || !K.validRewrite(b.text, after, resumeTerms)) continue;
      const added = [...K.termsOf(after)].filter((t) => !K.termsOf(b.text).has(t) && keywords.includes(t));
      changes.push({ id: R.uid("c"), type: "bullet", target: b.id, where: b.where, before: b.text, after, reason: added.length ? `Adds posting terms: ${added.join(", ")}` : "Matches the posting's wording", accepted: true });
    }
    const aiAnswers = Object.fromEntries((out.answers || []).map((a) => [a.qid, a.answer]));
    for (const q of pending) {
      let ans = (aiAnswers[q.qid] || "").trim();
      if (q.options?.length) ans = A.matchOption(q.options, ans) || "";
      answers.push({ ...q, answer: ans, source: ans ? "ai" : "none" });
    }
  } else {
    for (const q of pending) answers.push({ ...q, answer: "", source: "none" });
  }

  // Fit to one page deterministically.
  const draft = R.applyChanges(base, changes);
  for (const id of fitOnePage(draft, weights)) {
    const b = rewriteCandidates(base).find((x) => x.id === id) || { text: "", where: "" };
    changes.push({ id: R.uid("c"), type: "hide", target: id, where: b.where, before: b.text, after: "(hidden to fit one page)", reason: "Least related to this posting", accepted: true });
  }

  return {
    company: job.company || "",
    role: job.title || "",
    keywords,
    missing: missing.slice(0, 12),
    changes,
    answers,
    aiUsed,
  };
}

export function tailoredEntry(base, prep, url) {
  const accepted = prep.changes.filter((c) => c.accepted);
  return {
    company: prep.company,
    role: prep.role,
    url,
    resume: R.applyChanges(base, accepted),
    changeCount: accepted.length,
    keywords: prep.keywords,
    missing: prep.missing,
    createdAt: Date.now(),
  };
}
