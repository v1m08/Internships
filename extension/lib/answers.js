// Deterministic answers for common application questions: no AI. Returns
// null when a question needs a real (AI-drafted or human) answer.

const yn = (v) => (v === "yes" || v === true ? "Yes" : v === "no" || v === false ? "No" : null);

function classStanding(gradYear, gradMonth) {
  const y = Number(gradYear);
  if (!y) return null;
  const now = new Date();
  // Academic year ends in May/June: years until graduation from this point.
  const monthIdx = new Date(`${gradMonth || "May"} 1, 2000`).getMonth();
  const gradDate = new Date(y, isNaN(monthIdx) ? 4 : monthIdx, 15);
  const yearsLeft = (gradDate - now) / (365.25 * 86400000);
  if (yearsLeft > 3) return "Freshman";
  if (yearsLeft > 2) return "Sophomore";
  if (yearsLeft > 1) return "Junior";
  if (yearsLeft > 0) return "Senior";
  return "Graduate";
}

// [pattern, (profile, job) => answer] — first match wins.
const RULES = [
  [/how did you (hear|find|learn)|where did you (hear|find)|referral source|source of (application|referral)/, (p) => p.howHeard || "Job board"],
  [/(previously|ever|currently) (been )?(employed|worked) (by|for|at)|former(ly)? (an )?employee|worked (here|for us) before|prior employment with/, () => "No"],
  [/relatives?|related to (anyone|an employee)|family members? (who )?(work|employed)/, () => "No"],
  [/non-?compete|non-?solicit/, () => "No"],
  [/referred by|referral name|who referred you|employee referral/, () => ""],
  [/text messages?|sms|opt[ -]?in/, () => "No"],
  [/background check|drug (test|screen)/, () => "Yes"],
  [/(willing|able) to (work|commute|come|be) (on-?site|in[- ](the )?office|in[- ]person|hybrid)|(on-?site|in-?office|hybrid) (work|requirement|schedule)/, (p) => yn(p.willingToRelocate) || "Yes"],
  [/currently (enrolled|a student|pursuing)|are you a (current )?student|enrolled in (a|an) (degree|university|college)/, () => "Yes"],
  [/(year|class) (in school|standing|level)|current year of study|what year are you/, (p) => classStanding(p.gradYear, p.gradMonth)],
  [/highest (level of )?(education|degree)|degree (are you )?(pursuing|currently)|level of (study|education)/, (p) => p.degree || null],
  [/(field of study|major|discipline)/, (p) => p.major || null],
  [/(university|school|college) (are you|do you) attend|what school/, (p) => p.school || null],
  [/graduation (date|year|month)|expected (to )?graduat|when (do|will) you graduate/, (p) => [p.gradMonth, p.gradYear].filter(Boolean).join(" ") || null],
  [/\bgpa\b|grade point/, (p) => p.gpa || null],
  [/start date|available to start|earliest (start|availability)|when can you start/, (p) => p.availableStart || null],
  [/(summer|internship) (20\d\d )?(availability|available)|available (for|during) (the )?(summer|internship)|12[- ]week/, () => "Yes"],
  [/full[- ]time|40 hours/, () => "Yes"],
  [/at least 18|18 years|over the age of 18|age of majority/, (p) => yn(p.over18) || "Yes"],
  [/are you an? (u\.?s\.?|united states) citizen(?!s? or)|(u\.?s\.?|united states) citizenship\?/, (p) => (p.workStatus ? yn(p.workStatus === "citizen") : null)],
  [/permanent resident|green card holder/, (p) => (p.workStatus ? yn(p.workStatus === "citizen" || p.workStatus === "pr") : null)],
  [/security clearance/, (p) => yn(p.clearance)],
  [/authori[sz]ed to work|work authori[sz]ation|eligible to work|legally (able|permitted) to work/, (p) => yn(p.workAuthorized)],
  [/require (visa )?sponsorship|need sponsorship|sponsorship (now or in the future|required)|visa sponsorship/, (p) => yn(p.needsSponsorship)],
  [/relocat/, (p) => yn(p.willingToRelocate)],
  [/pronoun/, (p) => p.pronouns || null],
  [/salary|compensation|pay (rate|expectation)|desired (pay|wage)|hourly rate expect/, (p) => p.salaryExpectation || null],
  [/linkedin/, (p) => p.linkedin || null],
  [/github/, (p) => p.github || null],
  [/portfolio|personal website/, (p) => p.website || p.github || null],
  [/phone/, (p) => p.phone || null],
  [/^e-?mail|email address/, (p) => p.email || null],
  [/(current|most recent) (company|employer)/, (p) => p.currentCompany || p.school || null],
  [/^(city|location)$|current location|where are you (currently )?(located|based)/, (p) => [p.city, p.state].filter(Boolean).join(", ") || null],
  [/gender/, (p) => p.gender || null],
  [/hispanic|latin[oax]/, (p) => p.hispanic || null],
  [/\brace\b|ethnic/, (p) => p.race || null],
  [/veteran|military/, (p) => p.veteran || null],
  [/disabilit/, (p) => p.disability || null],
];

const norm = (s) => String(s || "").toLowerCase().replace(/[*✱]/g, " ").replace(/\s+/g, " ").trim();

// Pick the option that best matches a desired answer (same rules as the
// autofill engine). Returns the option text or null.
export function matchOption(options, value) {
  const v = norm(value);
  if (!v || !options?.length) return null;
  const opts = options.map((o) => ({ o, t: norm(o) }));
  const decline = /decline|prefer not|don.?t wish|do not wish|choose not|not to (say|answer|disclose)/;
  if (decline.test(v)) return opts.find((x) => decline.test(x.t))?.o || null;
  if (v === "yes" || v === "no") return opts.find((x) => x.t === v || x.t.startsWith(v + " ") || x.t.startsWith(v + ","))?.o || null;
  return (
    opts.find((x) => x.t === v)?.o ||
    opts.find((x) => x.t.startsWith(v))?.o ||
    opts.find((x) => x.t.includes(v))?.o ||
    opts.find((x) => x.t.length > 2 && v.includes(x.t))?.o ||
    null
  );
}

// q: { question, kind, options, required }. Returns { answer, source } or null.
export function answerDeterministically(q, profile, saved = {}) {
  const text = norm(q.question);
  const key = savedKey(q.question);
  if (saved[key]) {
    const a = q.options?.length ? matchOption(q.options, saved[key]) : saved[key];
    if (a) return { answer: a, source: "saved" };
  }
  for (const [re, fn] of RULES) {
    if (!re.test(text)) continue;
    const value = fn(profile);
    if (value === null || value === undefined) return null;
    if (value === "") return { answer: "", source: "rule" }; // intentionally blank (e.g. referral name)
    if (q.options?.length) {
      const opt = matchOption(q.options, value);
      return opt ? { answer: opt, source: "rule" } : null;
    }
    return { answer: value, source: "rule" };
  }
  return null;
}

// Saved answers are keyed by the normalized question (company names and
// punctuation stripped) so they carry across applications.
export function savedKey(question) {
  return norm(question).replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").slice(0, 160);
}

// Questions whose answer is about this specific company/role: never reused.
export function isCompanySpecific(question, company) {
  const t = norm(question);
  return /\bwhy\b|interest(ed)? in|excite|motivat|this (role|position|company|team)|our (company|mission|product)/.test(t) || (company && t.includes(norm(company)));
}
