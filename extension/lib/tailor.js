// Per-job pipeline shared by the Apply tab and Autopilot:
//   deterministic: keywords, skills/project order, standard answers, page fit
//   AI (one call):  bullet rewrites + answers to the remaining questions
import * as K from "./keywords.js";
import * as A from "./answers.js";
import * as R from "./resume.js";
import * as G from "./grad.js";
import * as C from "./cover.js";
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
 *         savedAnswers, questions = [], useAI = true, autopilot = false, cover }
 *   cover: your cover letter template (cover.js), if you've written one
 *   bank: your answer bank [{ id, prompt, text }] — answers you wrote once,
 *         reused when Claude says a question asks the same thing
 *   answersOnly: later pages of a multi-page form (no resume/letter work)
 *   instructions / feedback: your standing instructions, and what you said
 *         was wrong with the last attempt for this job
 * Returns { company, role, keywords, missing, changes, answers, aiUsed }
 *   answers: [{ qid, answer, source: "rule"|"saved"|"ai", kind, required }]
 */
export async function prepareJob(opts) {
  const { settings, base, posting, job = {}, profile, savedAnswers = {}, questions = [], useAI = true, autopilot = false, cover = null, bank = [], answersOnly = false, instructions = "", feedback = "" } = opts;
  const coverOn = !answersOnly && C.coverReady(cover);
  const bankReady = bank.filter((b) => (b.text || "").trim());
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
  const coverBoxes = [];
  for (const q of questions) {
    // A "cover letter" text box gets your letter, not an AI essay.
    if (coverOn && q.kind === "long_text" && /cover letter/i.test(q.question)) {
      coverBoxes.push(q);
      continue;
    }
    const det = A.answerDeterministically(q, jobProfile, savedAnswers);
    if (det) answers.push({ ...q, answer: det.answer, source: det.source });
    else if (autopilot && !q.required && /text/.test(q.kind)) answers.push({ ...q, answer: "", source: "skipped" }); // optional essays: leave blank
    else pending.push(q);
  }

  // One AI call: bullet rewrites (only if the posting shares skills with the resume) + remaining questions.
  let aiUsed = false;
  const bullets = keywords.length && !answersOnly ? rewriteCandidates(base).map(({ id, text }) => ({ id, text })) : [];
  // Cover letter: your paragraphs that fit this posting; Claude may add one
  // sentence where you put {Hook} and polish those paragraphs. Not in
  // Autopilot, which submits without your review.
  const coverPicks = coverOn ? C.coverChanges(cover, text, R.uid) : [];
  const coverAsk =
    coverOn && !autopilot
      ? { why: /\{Hook\}/.test(cover.why) ? cover.why : "", stories: coverPicks.map((c) => ({ id: c.target, text: cover.stories.find((s) => s.id === c.target).text })) }
      : null;
  if (useAI && (bullets.length || pending.length || coverAsk)) {
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
      cover: coverAsk,
      bank: pending.some((q) => /text/.test(q.kind)) ? bankReady : [],
      draftText: !autopilot,
      instructions,
      feedback,
    });
    // Your own answers from the bank, for questions Claude says they fit.
    const bankById = Object.fromEntries(bankReady.map((b) => [b.id, b]));
    const banked = {};
    for (const m of out.bank_matches || []) if (bankById[m.bank_id]) banked[m.qid] = C.fillVars(bankById[m.bank_id].text, { company: job.company, role: job.title });
    if (coverAsk) {
      const hook = (out.cover_hook || "").trim();
      if (coverAsk.why && C.validHook(hook, text, cover)) {
        coverPicks.push({ id: R.uid("c"), type: "cover", sub: "hook", target: "", where: "{Hook} sentence", before: cover.hookFallback || "(left out)", after: hook, reason: "One sentence about this posting, in your why paragraph", accepted: true });
      }
      const storyTerms = new Set([...K.termsOf(resumeText), ...K.termsOf(cover.stories.map((s) => s.text).join("\n"))]);
      for (const ed of out.cover_edits || []) {
        const s = coverAsk.stories.find((x) => x.id === ed.id);
        const after = (ed.text || "").trim();
        if (!s || !K.validRewrite(s.text, after, storyTerms)) continue;
        coverPicks.push({ id: R.uid("c"), type: "cover", sub: "edit", target: s.id, where: "reworded paragraph", before: s.text, after, reason: "Uses the posting's wording", accepted: true });
      }
    }
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
      if (banked[q.qid] && /text/.test(q.kind)) {
        answers.push({ ...q, answer: banked[q.qid], source: "bank", mark: "filled", note: "your answer from Settings → Your answers" });
        continue;
      }
      // Autopilot never submits Claude's writing: text answers come only from
      // your profile, saved answers or answer bank.
      if (autopilot && /text/.test(q.kind)) {
        answers.push({ ...q, answer: "", source: "needs-words" });
        continue;
      }
      let ans = (aiAnswers[q.qid] || "").trim();
      if (q.options?.length) ans = A.matchOption(q.options, ans) || "";
      answers.push({ ...q, answer: ans, source: ans ? "ai" : "none" });
    }
  } else {
    for (const q of pending) answers.push({ ...q, answer: "", source: "none" });
  }

  changes.push(...coverPicks);
  if (coverBoxes.length) {
    const letter = C.letterFromChanges(cover, changes, { company: job.company, role: job.title });
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
    for (const q of coverBoxes) answers.push({ ...q, answer: letter ? C.letterText(letter, name) : "", source: letter ? "cover" : "none" });
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
  if (answersOnly) return { company: job.company || "", role: job.title || "", keywords, missing: [], changes: [], answers, aiUsed, grad: null, coverTemplate: null };
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
    coverTemplate: coverOn ? cover : null,
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
    cover: prep.coverTemplate ? C.letterFromChanges(prep.coverTemplate, accepted, { company: prep.company, role: prep.role }) : null,
    createdAt: Date.now(),
  };
}
