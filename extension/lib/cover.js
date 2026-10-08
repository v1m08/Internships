// Cover letters you write once; JobPilot only swaps parts per job.
//
// Why this shape (career-center guidance, plus surveys of hiring managers):
// a letter should be under a page, customized for every application, tie
// specific experiences to the posting, give a specific reason for this
// employer, and match the resume's header and fonts. Generic or obviously
// AI-written letters are what get marked down. So the writing stays yours:
//   - opening, "why this company" and closing paragraphs you write, with
//     {Company} and {Role} filled in automatically
//   - a bank of short experience paragraphs you write; each job gets the
//     ones that best match its posting (no AI needed)
//   - optionally, Claude adds ONE sentence about something specific in the
//     posting where you put {Hook}, and may lightly reword your chosen
//     paragraphs toward the posting's terms. Both are changes you can untick,
//     checked like resume rewrites (no new numbers, tools or skills).
import * as K from "./keywords.js";

export const DEFAULT_COVER = {
  greeting: "Dear Hiring Manager,",
  opening: "",
  stories: [], // [{ id, title, text }]
  perLetter: 2,
  why: "",
  hookFallback: "",
  closing: "",
  signoff: "Sincerely,",
};

export function coverReady(c) {
  return !!(c && c.opening.trim() && c.closing.trim() && c.stories.some((s) => s.text.trim()));
}

// Plain words two texts share ("simulation", "embedded"), for postings whose
// skills aren't in the keyword list.
const STOP = new Set("about after their there these those which while would could should other where being have with from that this your will into than then them they what when also more most such very work team role intern internship students student experience".split(" "));
const words = (t) => new Set((String(t).toLowerCase().match(/[a-z][a-z-]{4,}/g) || []).map((w) => w.replace(/(ing|ion|ions|s|ed)$/, "")).filter((w) => w.length >= 4 && !STOP.has(w)));

// Your experience paragraphs, best match for this posting first.
export function pickStories(c, postingText) {
  const stories = c.stories.filter((s) => s.text.trim());
  const { weights } = K.analyze(postingText || "", "");
  const postWords = words(postingText || "");
  const scored = stories.map((s, i) => {
    const terms = K.extractTerms(s.text).filter((x) => weights[x.term]);
    const shared = [...words(s.text)].filter((w) => postWords.has(w));
    return {
      s,
      i,
      score: terms.reduce((a, x) => a + 3 * weights[x.term], 0) + shared.length,
      matched: [...terms.map((x) => x.term), ...shared].slice(0, 4),
    };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, Math.max(1, c.perLetter || 2));
}

const fillIn = (text, vars) =>
  String(text || "")
    .replace(/\{(Company|Role|Hook)\}/g, (_, k) => vars[k] || "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

// Answer bank: common application questions you answer once. Claude matches
// differently-worded questions to these; your text is used as written.
export const DEFAULT_BANK = [
  "Why do you want to work at {Company}?",
  "Why are you interested in this role?",
  "Tell us about a project you're proud of.",
  "Describe a challenge you faced and how you handled it.",
  "Tell us about yourself.",
  "What do you hope to learn from this internship?",
  "What are your career goals?",
].map((prompt, i) => ({ id: `bank${i}`, prompt, text: "" }));

// {Company}/{Role} in any text you wrote (answer bank uses this too).
export const fillVars = (text, { company, role }) => fillIn(text, { Company: company || "your company", Role: role || "this role", Hook: "" });

// -> { paragraphs: [greeting, ...body], signoff } for one job.
// picks: story ids in order; hook: Claude's sentence or ""; edits: { storyId: text }
export function buildLetter(c, { company, role, picks, hook = "", edits = {} }) {
  const vars = { Company: company || "your company", Role: role || "this role", Hook: hook || c.hookFallback || "" };
  const byId = Object.fromEntries(c.stories.map((s) => [s.id, s]));
  const body = [
    fillIn(c.opening, vars),
    ...picks.map((id) => byId[id]).filter(Boolean).map((s) => fillIn(edits[s.id] || s.text, vars)),
    fillIn(c.why, vars),
    fillIn(c.closing, vars),
  ].filter(Boolean);
  return { greeting: fillIn(c.greeting, vars), paragraphs: body, signoff: c.signoff || "Sincerely," };
}

export function letterText(letter, name) {
  return [letter.greeting, ...letter.paragraphs, `${letter.signoff}\n${name || ""}`.trim()].join("\n\n");
}

// Claude's hook may only use words from the posting and your own letter.
export function validHook(hook, postingText, c) {
  const h = (hook || "").trim();
  if (!h || h.length > 260 || /\{|\}/.test(h)) return false;
  const known = K.termsOf(`${postingText}\n${c.opening}\n${c.why}\n${c.stories.map((s) => s.text).join("\n")}`);
  for (const t of K.termsOf(h)) if (!known.has(t)) return false;
  const nums = (s) => (s.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/,/g, ""));
  const postNums = new Set(nums(postingText));
  return nums(h).every((n) => postNums.has(n));
}

// Tailoring changes for the letter (shown in the review with the resume's).
export function coverChanges(c, postingText, uid) {
  if (!coverReady(c)) return [];
  return pickStories(c, postingText).map((p) => ({
    id: uid("c"),
    type: "cover",
    sub: "story",
    target: p.s.id,
    where: "paragraph",
    before: "",
    after: `Include your paragraph "${p.s.title || p.s.text.slice(0, 40)}"`,
    reason: p.matched.length ? `Matches the posting: ${p.matched.join(", ")}` : "Your first paragraph (nothing in the posting matched more)",
    accepted: true,
  }));
}

// The letter a set of accepted changes describes.
export function letterFromChanges(c, changes, { company, role }) {
  const on = changes.filter((x) => x.accepted && x.type === "cover");
  const picks = on.filter((x) => x.sub === "story").map((x) => x.target);
  if (!picks.length) return null;
  const hook = on.find((x) => x.sub === "hook")?.after || "";
  const edits = Object.fromEntries(on.filter((x) => x.sub === "edit").map((x) => [x.target, x.after]));
  return buildLetter(c, { company, role, picks, hook, edits });
}
