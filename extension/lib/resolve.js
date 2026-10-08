// "Autofill where it can, then ask Claude when it gets stuck."
//
// After the rule-based fill, the fields still empty go to one short Claude
// call (ai.js resolveFields). What happens next depends on what the answer is:
//   fact        -> filled (green): an option or value straight from your profile
//   preference  -> filled as a draft (purple): a choice you should glance at
//   writing     -> skipped (amber): needs your own words; a fully AI-written
//                  answer submitted as yours would look bad
//   unknown     -> skipped (amber)
import * as Page from "./page.js";
import { resolveFields } from "./ai.js";

const isText = (q) => q.kind === "short_text" || q.kind === "long_text";

// -> { filled: [{ label, value }], drafted: [...], skipped: [{ label, reason }] }
export async function resolveStuck(tab, { settings, profile, resumeText, posting = "" }) {
  const fields = await Page.collectQuestions(tab, { stuck: true, profile });
  const result = { filled: [], drafted: [], skipped: [] };
  // Essays never go through this step: they're for "Draft answers" with review.
  const ask = fields.filter((q) => q.kind !== "long_text");
  for (const q of fields) if (q.kind === "long_text" && q.required) result.skipped.push({ label: q.question.slice(0, 80), reason: "Needs your own words (use Draft answers to start one)" });
  if (!ask.length) return result;

  const answers = await resolveFields(settings, { fields: ask, profile, resumeText, posting });
  const byId = Object.fromEntries(ask.map((q) => [q.qid, q]));
  const toFill = [];
  for (const a of answers) {
    const q = byId[a.qid];
    if (!q) continue;
    const values = (a.answer || []).map((v) => String(v).trim()).filter(Boolean);
    const label = q.question.slice(0, 80);
    if (!values.length || a.basis === "writing" || a.basis === "unknown" || (a.basis === "preference" && isText(q))) {
      if (q.required) result.skipped.push({ label, reason: a.basis === "unknown" ? "Claude doesn't have this information" : "Needs your own words" });
      continue;
    }
    const fact = a.basis === "fact";
    toFill.push({ qid: q.qid, answer: q.kind === "multi_choice" || q.kind === "dropdown" ? values : values[0], mark: fact ? "filled" : "draft", note: fact ? "matched by Claude from your profile" : "Claude's pick — check it" });
    (fact ? result.filled : result.drafted).push({ label, value: values.join(", ") });
  }
  if (toFill.length) await Page.fillAnswers(tab, toFill);
  return result;
}

// After Submit: fields the site rejected ("Enter a valid phone number").
// Claude reads the error and the current value and fixes facts or formats;
// it never writes your own-words answers here either. -> number fixed
export async function fixInvalid(tab, { settings, profile, resumeText, posting = "" }) {
  const lists = await Page.callAll(tab, "invalidFields");
  const bad = lists.flat().filter((q) => q.kind !== "long_text");
  if (!bad.length) return 0;
  const fields = bad.map((q) => ({ ...q, question: `${q.question} (the site says: "${q.error}"; current value: "${q.value}")` }));
  const answers = await resolveFields(settings, { fields, profile, resumeText, posting });
  const byId = Object.fromEntries(bad.map((q) => [q.qid, q]));
  const toFill = [];
  for (const a of answers) {
    const q = byId[a.qid];
    const values = (a.answer || []).map((v) => String(v).trim()).filter(Boolean);
    if (!q || !values.length || a.basis === "writing" || a.basis === "unknown") continue;
    toFill.push({ qid: q.qid, answer: q.kind === "dropdown" ? values : values[0], mark: a.basis === "fact" ? "filled" : "draft", note: `fixed after the site said: ${q.error}` });
  }
  return toFill.length ? Page.fillAnswers(tab, toFill) : 0;
}
