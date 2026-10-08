// Can you apply? Reads work-authorization requirements from a job listing,
// Simplify's job data, and the posting text, then compares them with your
// U.S. work status (Settings → Application profile).
//
// Verdicts: "no" (✕ can't apply), "maybe" (? check), "yes" (✓ no
// restrictions found). Each comes with reasons and the sentence it's from.

// ------------------------------------------------------------ your status

export const WORK_STATUSES = [
  ["", "Not set"],
  ["citizen", "U.S. citizen"],
  ["pr", "U.S. permanent resident (green card)"],
  ["authorized", "Other work authorization, no sponsorship needed (e.g. EAD)"],
  ["student", "Student visa (F-1): CPT/OPT only, sponsorship needed later"],
  ["none", "Not authorized to work in the U.S."],
];

// The yes/no answers forms ask, for a work status.
export function authAnswersFor(status) {
  return {
    citizen: { workAuthorized: "yes", needsSponsorship: "no" },
    pr: { workAuthorized: "yes", needsSponsorship: "no" },
    authorized: { workAuthorized: "yes", needsSponsorship: "no" },
    student: { workAuthorized: "yes", needsSponsorship: "yes" },
    none: { workAuthorized: "no", needsSponsorship: "yes" },
  }[status];
}

// Profiles from before work status existed: best guess from the yes/no answers.
export function workStatusOf(p) {
  if (p.workStatus) return p.workStatus;
  if (p.workAuthorized === "no") return "none";
  if (p.needsSponsorship === "yes") return "student";
  return "authorized-unknown"; // authorized, but citizenship not stated
}

// -------------------------------------------------------- reading signals

// Tags:
//   citizen        U.S. citizenship required
//   usPerson       citizen / permanent resident / refugee / asylee (ITAR, export control)
//   clearance      security clearance required or must be obtainable
//   anyEmployer    authorized for any employer (CPT/OPT and other student work authorization don't count)
//   noSponsorEver  must work without sponsorship now or in the future
//   workAuth       must be authorized to work in the U.S.
//   noSponsor      the company/role doesn't sponsor visas
//   companyNoH1B   company historically doesn't sponsor H-1B (weaker)
//   offersSponsor  sponsorship available
//   studentOk      CPT/OPT/international students welcome

const US = "(?:u\\.?\\s?s\\.?|united states|american)";
const NEG = "(?:not|no|unable to|cannot|can't|can ?not|won't|will not|do not|does not|don't|doesn't|are not able to|is not able to|not able to|not in a position to)";

const PATTERNS = [
  ["citizen", new RegExp(`${US} citizen(?:ship)?\\s*(?:is\\s*)?(?:required|only)|must (?:be|hold) (?:a |an )?${US} citizen(?!,? (?:or|lawful|permanent|national))|require[sd]?\\s+${US} citizenship|citizenship is required|${US} citizens only`, "i")],
  ["usPerson", new RegExp(`${US} persons?\\b|\\bitar\\b|export[- ]control(?:led)?|${US} citizens?,? (?:or |lawful |permanent |nationals?)|citizens? or (?:lawful )?permanent residents?|green card holders? (?:only|required)|lawfully admitted (?:into the u\\.?s\\.? )?as a refugee`, "i")],
  ["clearance", /(?:security|secret|top secret|ts\/sci|dod|government|public trust) clearance|(?:obtain|maintain|hold|possess|eligib\w* for)(?: and maintain)? (?:a|an|the)? ?(?:active )?(?:security )?clearance|clearance (?:is )?required/i],
  ["anyEmployer", /authori[sz]ed to work (?:in the (?:u\.?s\.?|united states) )?for any employer|(?:cpt|opt|curricular practical training|optional practical training|temporary (?:student )?work authori[sz]ation)[^.]{0,120}(?:not|ineligible|do not qualify|does not qualify|won't|will not|aren't|are not) (?:be )?(?:eligible|accepted|considered|qualify)|(?:not|ineligible|un)\w* [^.]{0,40}(?:cpt|opt|f-?1)\b/i],
  ["noSponsorEver", new RegExp(`(?:now (?:or|and) in the future|now or at any time in the future|currently or in the future)[^.]{0,60}(?:without|not require|no)[^.]{0,20}sponsor|without (?:the need for )?(?:current or future |present or future |future )?(?:visa |employment |work )?sponsorship|(?:not|won't|will not) (?:now or in the future )?require (?:visa |immigration |employment )?sponsorship`, "i")],
  ["workAuth", /(?:legally |currently )?authori[sz]ed to work in the (?:u\.?s\.?|united states)|(?:valid |current )?(?:u\.?s\.? )?work authori[sz]ation (?:is )?required|eligib\w* to work in the (?:u\.?s\.?|united states)|right to work in the (?:u\.?s\.?|united states)|legally (?:able|permitted) to work in the (?:u\.?s\.?|united states)/i],
  ["noSponsor", new RegExp(`${NEG}\\s+(?:\\w+\\s+){0,4}(?:sponsor|sponsorship)\\b|(?:visa |h-?1b |immigration )?sponsorship (?:is |will )?(?:not|n't) (?:be )?(?:available|offered|provided)|no (?:visa |h-?1b |immigration )?sponsorship|not eligible for (?:visa )?sponsorship|does not offer sponsorship`, "i")],
  ["offersSponsor", /(?:we|will|can|able to|happy to|willing to)\s+(?:\w+\s+){0,2}sponsor|sponsorship (?:is )?available|offers? (?:visa |h-?1b )?sponsorship|h-?1b sponsorship available/i],
  ["studentOk", /(?:cpt|opt|f-?1|international students?)[^.]{0,30}(?:welcome|eligible|encouraged|accepted)/i],
];

// Sentences that talk about authorization at all (keeps false hits down).
const TOPIC = /citizen|sponsor|authori[sz]|clearance|visa|permanent resident|green card|itar|export control|u\.?s\.? person|right to work|eligible to work|cpt|opt\b|f-?1/i;

export function signalsFromText(text, source = "posting") {
  const out = [];
  const seen = new Set();
  // Keep "U.S." and "e.g." from ending sentences.
  const t = String(text || "")
    .replace(/\bU\.\s?S\.(?:\s?A\.)?/g, "US")
    .replace(/\b(e\.g|i\.e|etc|Inc|Corp|Ltd|Jr|Sr|Dr|St|No)\./gi, "$1");
  for (const raw of t.split(/(?<=[.!?;])\s+|\n+/)) {
    const s = raw.trim();
    if (s.length < 12 || s.length > 600 || !TOPIC.test(s)) continue;
    // EEO boilerplate mentions citizenship as a protected class, not a requirement.
    if (/without regard to|regardless of|protected (?:veteran|class)|equal opportunity|discriminat/i.test(s)) continue;
    for (const [tag, re] of PATTERNS) {
      if (!re.test(s)) continue;
      // "We sponsor…" wins over the generic negation match only when no negation is present.
      if (tag === "offersSponsor" && new RegExp(NEG, "i").test(s)) continue;
      if (tag === "noSponsor" && /\bno sponsorship (?:is )?(?:required|needed)\b/i.test(s)) continue;
      const key = `${tag}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tag, evidence: s.slice(0, 220), source });
    }
  }
  return out;
}

// Repo listings: Simplify's sponsorship field and README flags (🛂 / 🇺🇸).
export function signalsFromListing(j) {
  const sp = String(j.sponsorship || "");
  if (/citizenship/i.test(sp)) return [{ tag: "citizen", evidence: "Listing: U.S. citizenship required", source: "listing" }];
  if (/does not offer/i.test(sp)) return [{ tag: "noSponsor", evidence: "Listing: does not offer sponsorship", source: "listing" }];
  if (/offers sponsorship/i.test(sp)) return [{ tag: "offersSponsor", evidence: "Listing: offers sponsorship", source: "listing" }];
  return [];
}

// Simplify's job page data (window.__NEXT_DATA__ on simplify.jobs/p/<id>).
export function signalsFromSimplify(jp) {
  const out = [];
  if (jp.sponsors_h1b === false) out.push({ tag: "noSponsor", evidence: "Simplify: no H-1B sponsorship for this role", source: "simplify" });
  if (jp.sponsors_h1b === true) out.push({ tag: "offersSponsor", evidence: "Simplify: H-1B sponsorship available", source: "simplify" });
  const co = jp.job?.company?.sponsors_h1b;
  if (jp.sponsors_h1b == null && co === false) out.push({ tag: "companyNoH1B", evidence: "Simplify: company doesn't provide H-1B sponsorship", source: "simplify" });
  out.push(...signalsFromText((jp.requirements || []).join("\n"), "simplify"));
  return out;
}

// --------------------------------------------------------------- verdict

const LEVEL = { yes: 0, maybe: 1, no: 2 };

// What each requirement means for each status: "ok" | "maybe" | "no".
function judge(tag, status, clearance) {
  const citizenish = status === "citizen";
  const prish = status === "citizen" || status === "pr";
  const authorized = prish || status === "authorized";
  const unknown = status === "authorized-unknown" || status === "";
  switch (tag) {
    case "citizen":
      return citizenish ? "ok" : unknown ? "maybe" : "no";
    case "usPerson":
      return prish ? "ok" : unknown ? "maybe" : "no";
    case "clearance":
      return clearance === "yes" ? "ok" : citizenish ? "maybe" : unknown ? "maybe" : "no";
    case "anyEmployer":
    case "noSponsorEver":
      return authorized ? "ok" : unknown ? "ok" : "no";
    case "workAuth":
      return authorized || unknown ? "ok" : status === "student" ? "maybe" : "no";
    case "noSponsor":
      return authorized || unknown ? "ok" : status === "student" ? "maybe" : "no";
    case "companyNoH1B":
      return authorized || unknown ? "ok" : "maybe";
    default:
      return "ok";
  }
}

const REASON = {
  citizen: "Requires U.S. citizenship",
  usPerson: "Requires U.S. citizen or permanent resident (export control)",
  clearance: "Requires a security clearance",
  anyEmployer: "Requires authorization for any employer (CPT/OPT don't count)",
  noSponsorEver: "Requires no sponsorship now or in the future",
  workAuth: "Requires U.S. work authorization",
  noSponsor: "Doesn't sponsor visas",
  companyNoH1B: "Company usually doesn't sponsor H-1B",
};

// -> { level: "yes"|"maybe"|"no", reasons: [{ text, evidence, level }], positive: [...] }
export function verdict(signals, profile) {
  const status = workStatusOf(profile || {});
  const clearance = profile?.clearance || "no";
  const reasons = [];
  let level = "yes";
  for (const s of signals) {
    if (s.tag === "offersSponsor" || s.tag === "studentOk") continue;
    const j = judge(s.tag, status, clearance);
    if (j === "ok") continue;
    const l = j === "no" ? "no" : "maybe";
    reasons.push({ text: REASON[s.tag] + (status === "authorized-unknown" || status === "" ? " (set your U.S. work status in Settings)" : ""), evidence: s.evidence, level: l });
    if (LEVEL[l] > LEVEL[level]) level = l;
  }
  // A role that says it sponsors softens the weaker "company usually doesn't".
  if (level === "maybe" && signals.some((s) => s.tag === "offersSponsor") && reasons.every((r) => !/citizen|clearance|any employer/i.test(r.text))) level = "yes";
  reasons.sort((a, b) => LEVEL[b.level] - LEVEL[a.level]);
  return { level, reasons, positive: signals.filter((s) => s.tag === "offersSponsor" || s.tag === "studentOk") };
}

export const LABEL = { yes: "✓ Can apply", maybe: "? Check eligibility", no: "✕ Can't apply" };

// ------------------------------------------------- Simplify job data fetch

const SIMPLIFY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const hasSimplifyPage = (j) => SIMPLIFY_ID.test(j.simplifyId || "");

export async function fetchSimplify(id) {
  const res = await fetch(`https://simplify.jobs/p/${id}`, { credentials: "omit" });
  if (!res.ok) throw new Error(`Simplify HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  const jp = JSON.parse(m[1])?.props?.pageProps?.jobPosting;
  return jp ? signalsFromSimplify(jp) : [];
}
