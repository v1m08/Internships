// Autopilot: apply to one job end to end in a background tab.
//
//   open posting → reach the form → read posting + questions → prepare
//   (deterministic tailoring + standard answers, one AI call for the rest)
//   → autofill + attach → fill answers → check blockers → submit or stop.
//
// Submission rule (your setting): submit automatically only when no answer
// had to be written (every text field came from your profile or saved
// answers). If any typed answer was AI-drafted or is missing, the tab is
// left open as "review" for you to read and submit.
//
// Returns { status, note, tabId?, tailored? }. Statuses:
//   applied    submitted and the site confirmed it (tab closed)
//   review     filled, but has AI-written answers → you review + submit
//   needs-you  blocker (CAPTCHA, login, missing required field, no confirmation)
//   manual     site needs an account (Workday etc.); not opened
//   failed     error
import * as G from "./grad.js";
import { resolveStuck } from "./resolve.js";
import { resumeToText } from "./pdf.js";
import * as Page from "./page.js";
import { prepareJob, tailoredEntry } from "./tailor.js";

const ACCOUNT_SITES = /myworkdayjobs\.com|workday\.com|icims\.com|taleo\.net|successfactors|oraclecloud\.com|brassring|amazon\.jobs|careers\.microsoft\.com|metacareers\.com|google\.com\/about\/careers|careers\.google\.com/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTyped = (q) => q.kind === "short_text" || q.kind === "long_text";

// ctx: { settings, profile, base, savedAnswers, tailoredFor(job), saveTailored(job, entry),
//        resumeFileFor(job, tailored) → Promise<{name, base64}>, step(text) }
export async function runJob(job, ctx) {
  const step = ctx.step || (() => {});
  if (ACCOUNT_SITES.test(job.url)) return { status: "manual", note: "Needs an account on this site. Open it and click Autofill on each page." };

  step("Opening");
  let tab = await chrome.tabs.create({ url: job.url, active: false });
  try {
    let size = await Page.waitForForm(tab);
    let posting = null;
    try {
      posting = await Page.readJobPosting(await chrome.tabs.get(tab.id));
    } catch {}

    // Reach the application form (click "Apply" up to twice).
    for (let i = 0; i < 2 && size.controls < 3; i++) {
      const hit = (await Page.callAll(tab, "clickApply")).find((c) => c.clicked);
      if (!hit) break;
      step("Opening application form");
      await sleep(600);
      size = await Page.waitForForm(tab);
    }
    tab = await chrome.tabs.get(tab.id);
    if (size.controls < 3) return { status: "needs-you", note: "Couldn't find the application form (login or unusual Apply button?).", tabId: tab.id };

    if (!posting) posting = await Page.readJobPosting(tab).catch(() => ({ text: "" }));
    if (!job.company || !job.title) {
      const meta = (await Page.callAll(tab, "jobMeta")).find((m) => m.company || m.role) || {};
      job = { ...job, company: job.company || meta.company, title: job.title || meta.role };
    }

    // This job's graduation date (flexible window), then profile fields first
    // so only real questions remain.
    const existing = ctx.tailoredFor(job);
    const profile = G.profileWithGrad(ctx.profile, existing ? existing.grad : G.gradForJob(ctx.profile, posting?.text, job.title)?.date);
    step("Filling");
    const firstPass = await Page.autofill(tab, { profile, resumeFile: null });
    // Fields the rules couldn't fill: one short Claude pass (options and facts
    // only; anything needing your own words stays for the steps below).
    try {
      const r = await resolveStuck(tab, { settings: ctx.settings, profile, resumeText: resumeToText(ctx.base), posting: posting?.text || "" });
      firstPass.filled.push(...r.filled, ...r.drafted);
    } catch {}
    const questions = await Page.collectQuestions(tab);

    // Tailor + answer (deterministic first, one AI call for the rest).
    step(questions.length ? `Preparing resume + ${questions.length} answer${questions.length === 1 ? "" : "s"}` : "Preparing resume");
    let tailored = ctx.tailoredFor(job);
    const prep = await prepareJob({
      settings: ctx.settings,
      base: ctx.base,
      posting,
      job,
      profile: ctx.profile,
      savedAnswers: ctx.savedAnswers,
      questions,
      useAI: true,
      autopilot: true,
    });
    if (!tailored && ctx.settings.autopilot.tailor) {
      tailored = tailoredEntry(ctx.base, prep, job.url);
      await ctx.saveTailored(job, tailored);
    }

    // Attach the resume (second pass also catches fields that appeared late).
    const file = await ctx.resumeFileFor(job, tailored);
    const report = await Page.autofill(tab, { profile: G.profileWithGrad(ctx.profile, tailored ? tailored.grad : prep.grad), resumeFile: file });
    const toFill = prep.answers.filter((a) => a.answer);
    if (toFill.length) await Page.fillAnswers(tab, toFill);
    const attested = (await Page.callAll(tab, "checkAttestations")).reduce((a, b) => a + b, 0);

    const filledCount = firstPass.filled.length + toFill.length + attested;
    const aiTyped = prep.answers.filter((a) => isTyped(a) && a.source === "ai");
    const unanswered = prep.answers.filter((a) => a.required && !a.answer);
    const missing = (await Page.callAll(tab, "missingRequired")).flat();
    const captcha = (await Page.callAll(tab, "detectCaptcha")).some(Boolean);

    const blockers = [];
    if (!report.attached && size.files) blockers.push("resume upload");
    if (unanswered.length) blockers.push(`unanswered: ${unanswered.slice(0, 3).map((q) => q.question.slice(0, 40)).join("; ")}`);
    else if (missing.length) blockers.push(`required: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`);
    if (captcha) blockers.push("CAPTCHA");
    if (blockers.length) return { status: "needs-you", note: `Filled ${filledCount}. Needs you: ${blockers.join("; ")}.`, tabId: tab.id, tailored };

    if (aiTyped.length || !ctx.settings.autopilot.autoSubmit) {
      return {
        status: "review",
        note: aiTyped.length ? `Filled ${filledCount}; ${aiTyped.length} AI-written answer${aiTyped.length === 1 ? "" : "s"} (purple) to review, then Submit.` : `Filled ${filledCount}. Auto-submit is off: review and Submit.`,
        tabId: tab.id,
        tailored,
      };
    }

    // Submit and wait for the site's confirmation.
    step("Submitting");
    const clicked = (await Page.callAll(tab, "submit")).find((c) => c.clicked);
    if (!clicked) return { status: "needs-you", note: "Filled everything but couldn't find the Submit button.", tabId: tab.id, tailored };
    for (let i = 0; i < 20; i++) {
      await sleep(750);
      let states;
      try {
        states = await Page.callAll(tab, "submissionState");
      } catch {
        continue; // page navigating
      }
      if (states.some((s) => s.confirmed)) {
        await chrome.tabs.remove(tab.id).catch(() => {});
        return { status: "applied", note: `Submitted (${filledCount} fields${prep.aiUsed ? ", AI-picked options" : ""}).`, tailored };
      }
      const errors = states.flatMap((s) => s.errors);
      if (i >= 4 && errors.length) return { status: "needs-you", note: `Submit showed: ${errors.slice(0, 2).join(" / ")}`, tabId: tab.id, tailored };
    }
    return { status: "needs-you", note: "Clicked Submit but saw no confirmation. Check the tab.", tabId: tab.id, tailored };
  } catch (e) {
    return { status: "failed", note: e.message || String(e), tabId: tab.id };
  }
}

// Run a queue with limited concurrency. items: [{ job, status }]
// onUpdate(item) after each change; shouldStop() checked between jobs.
export async function runQueue(items, ctx, { concurrency = 2, onUpdate, shouldStop }) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !shouldStop()) {
      const item = items[next++];
      if (item.status !== "queued") continue;
      item.status = "running";
      item.note = "";
      onUpdate(item);
      const res = await runJob(item.job, { ...ctx, step: (s) => ((item.note = s), onUpdate(item)) });
      Object.assign(item, res, { finishedAt: Date.now() });
      onUpdate(item);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
