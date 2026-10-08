// Per-job pipeline shared by the Apply tab and Autopilot:
//   deterministic: keywords, skills/project order, standard answers, page fit
//   AI (one call):  bullet rewrites + answers to the remaining questions
import * as K from "./keywords.js";
import * as A from "./answers.js";
import * as R from "./resume.js";
import * as G from "./grad.js";
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

  // Flexible graduation: the date in your window this posting asks for.
  let grad = G.gradForJob(profile, text, job.title);
  let jobProfile = G.profileWithGrad(profile, grad?.date);

  // Standard questions without AI.
  const answers = [];
  const pending = [];
  for (const q of questions) {
    const det = A.answerDeterministically(q, jobProfile, savedAnswers);
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
      profile: jobProfile,
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
    // The posting's eligibility in words the patterns missed ("rising seniors…").
    const aiWindow = G.windowFromAI(out.graduation_window);
    if (grad && !grad.shifted && !grad.outside && aiWindow && !G.postingWindow(text, job.title)) {
      grad = G.gradForJob(profile, text, job.title, aiWindow);
      jobProfile = G.profileWithGrad(profile, grad.date);
      for (const a of answers) {
        if (a.source !== "rule") continue;
        const det = A.answerDeterministically(a, jobProfile, savedAnswers);
        if (det) a.answer = det.answer;
      }
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

  if (grad?.shifted) {
    const c = G.gradChange(base, profile, grad.date);
    const reason = grad.why ? `Posting: "${grad.why}"` : "Fits the posting's graduation window";
    if (c) changes.unshift({ id: R.uid("c"), type: "grad", ...c, reason, accepted: true });
    // No date on the resume to change: still use it in the application.
    else changes.unshift({ id: R.uid("c"), type: "grad", target: "", field: "", where: "Application", before: G.formatDate(G.profileWindow(profile).def), after: G.formatDate(grad.date), reason, accepted: true });
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
    grad: grad?.shifted ? grad.date : null,
    gradNote: grad?.outside ? `This posting looks for graduates outside your window ("${grad.why}").` : "",
  };
}

// The graduation date a saved tailored version uses (only if you kept that change).
export function gradIfAccepted(prep, accepted) {
  return prep.grad !== null && prep.grad !== undefined && accepted.some((c) => c.type === "grad") ? prep.grad : null;
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
    grad: gradIfAccepted(prep, accepted),
    createdAt: Date.now(),
  };
}
