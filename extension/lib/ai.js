// Claude calls: resume parsing, per-job tailoring, drafting answers.
import { Anthropic } from "../vendor/anthropic.js";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best quality)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fastest, cheapest)" },
];

// Models that accept the server-side refusal fallback.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

// Strict JSON schema helpers: every property required, no extras.
const str = { type: "string" };
const arr = (items) => ({ type: "array", items });
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

function makeClient(settings) {
  if (!settings.apiKey) throw new Error("Add your Anthropic API key in Settings first.");
  return new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error("Your API key was rejected. Check it in Settings.");
  if (err instanceof Anthropic.PermissionDeniedError) return new Error("This API key doesn't have access to that model. Try another model in Settings.");
  if (err instanceof Anthropic.NotFoundError) return new Error("Model not found. Pick a different model in Settings.");
  if (err instanceof Anthropic.RateLimitError) return new Error("Rate limited by the API. Wait a minute and try again.");
  if (err instanceof Anthropic.BadRequestError) {
    const msg = err.error?.error?.message || err.message;
    if (/credit balance/i.test(msg)) return new Error("Your Anthropic account is out of credits. Add credits at console.anthropic.com → Billing.");
    return new Error(`The API rejected the request: ${msg}`);
  }
  if (err instanceof Anthropic.InternalServerError) return new Error("Anthropic's API had a server error. Try again in a moment.");
  if (err instanceof Anthropic.APIConnectionError) return new Error("Couldn't reach the Anthropic API. Check your internet connection.");
  return err;
}

// ------------------------------------------------- Claude Code bridge

export const BRIDGE_HOST = "com.jobpilot.claude_bridge";

export const CC_MODELS = [
  { id: "default", label: "Your Claude Code default" },
  { id: "opus", label: "Opus (best quality, uses limits faster)" },
  { id: "sonnet", label: "Sonnet (good balance)" },
  { id: "haiku", label: "Haiku (fastest)" },
];

export function bridge(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(BRIDGE_HOST, msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        const m = err.message || "";
        if (/not found|forbidden|not allowed/i.test(m)) {
          return reject(new Error("The Claude Code bridge isn't installed yet. Follow the one-time setup in Settings → Connect Claude."));
        }
        if (/exited/i.test(m)) return reject(new Error("The Claude Code bridge stopped unexpectedly. Re-run `node bridge/install.js`, then try again."));
        return reject(new Error(`Bridge error: ${m}`));
      }
      if (!resp) return reject(new Error("No response from the Claude Code bridge."));
      if (!resp.ok) {
        const e = new Error(resp.error || "Claude Code failed.");
        e.code = resp.code;
        return reject(e);
      }
      resolve(resp);
    });
  });
}

async function callViaClaudeCode(settings, { system, content, schema, effort }) {
  let prompt = "";
  let pdfBase64;
  for (const part of typeof content === "string" ? [{ type: "text", text: content }] : content) {
    if (part.type === "document") pdfBase64 = part.source.data;
    if (part.type === "text") prompt += part.text;
  }
  const resp = await bridge({ type: "run", system, prompt, schema, model: settings.ccModel || "default", effort, pdfBase64 });
  return resp.data;
}

export async function pingBridge() {
  return bridge({ type: "ping" });
}

async function callJSON(settings, { system, content, schema, effort = "medium", maxTokens = 16000 }) {
  if (settings.provider === "claude-code") return callViaClaudeCode(settings, { system, content, schema, effort });
  const client = makeClient(settings);
  const params = {
    model: settings.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema } },
  };
  if (!settings.model.startsWith("claude-haiku")) params.output_config.effort = effort;

  let resp;
  try {
    resp = FALLBACK_MODELS.has(settings.model)
      ? await client.beta.messages.create({ ...params, fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] })
      : await client.messages.create(params);
  } catch (e) {
    throw friendly(e);
  }
  if (resp.stop_reason === "refusal") throw new Error("The model declined this request. Try rephrasing or a different model.");
  if (resp.stop_reason === "max_tokens") throw new Error("The response was cut off (too long). Try again.");
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The AI returned malformed data. Try again.");
  }
}

export async function testConnection(settings) {
  if (settings.provider === "claude-code") {
    const ping = await pingBridge();
    const r = await callViaClaudeCode(settings, {
      system: "Reply in the requested JSON format.",
      content: "Reply with ok set to \"OK\".",
      schema: obj({ ok: str }),
      effort: "low",
    });
    return `${r.ok || "OK"} · ${ping.claudeVersion} · ${ping.texEngine ? `LaTeX: ${ping.texEngine}` : ping.bridgeVersion >= "1.1.0" ? "no LaTeX found" : "re-run the bridge installer for LaTeX"}`;
  }
  const client = makeClient(settings);
  try {
    const params = { model: settings.model, max_tokens: 64, messages: [{ role: "user", content: "Reply with just: OK" }] };
    if (!settings.model.startsWith("claude-haiku")) params.output_config = { effort: "low" };
    const resp = await client.messages.create(params);
    return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim() || "OK";
  } catch (e) {
    throw friendly(e);
  }
}

// ------------------------------------------------------------------ parse

const PARSE_SCHEMA = obj({
  basics: obj({ name: str, email: str, phone: str, location: str, links: arr(obj({ label: str, url: str })) }),
  summary: str,
  sections: arr(
    obj({
      title: str,
      kind: { type: "string", enum: ["entries", "lines", "text"] },
      entries: arr(obj({ title: str, subtitle: str, location: str, dates: str, bullets: arr(str) })),
      lines: arr(obj({ label: str, text: str })),
      text: str,
    })
  ),
  profile: obj({
    firstName: str,
    lastName: str,
    email: str,
    phone: str,
    linkedin: str,
    github: str,
    website: str,
    city: str,
    state: str,
    school: str,
    degree: str,
    major: str,
    gpa: str,
    gradMonth: str,
    gradYear: str,
  }),
});

const PARSE_SYSTEM = `You convert resumes into structured data for an editor. Transcribe faithfully: keep every section, entry and bullet in the original order with the original wording. Do not summarize, merge, improve or invent anything.

Section kinds:
- "entries": Education, Experience, Projects, Leadership, etc. title = organization/school/project name; subtitle = role/degree; location; dates exactly as written (e.g. "May 2024 – Aug 2024"); bullets = each bullet point.
- "lines": Skills-style sections made of "Label: items" rows (e.g. label "Languages", text "Python, Java"). If a row has no label, use an empty label.
- "text": a plain paragraph section.
Fill unused fields of a section with empty strings/arrays. summary is the resume's summary/objective paragraph if it has one, otherwise "". For links, use full URLs (add https:// when missing) and short labels like "LinkedIn", "GitHub", "Portfolio".

profile: fields for job application forms, taken only from what the resume states (empty string when not stated). gradMonth is a full month name, gradYear four digits, for the most recent/expected degree. degree like "Bachelor of Science".`;

export async function parseResume(settings, pdfBase64) {
  return callJSON(settings, {
    system: PARSE_SYSTEM,
    content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
      { type: "text", text: "Convert this resume into the structured format." },
    ],
    schema: PARSE_SCHEMA,
    effort: "low",
  });
}

// ----------------------------------------------------------------- tailor

const TAILOR_SCHEMA = obj({
  company: str,
  role: str,
  keywords: arr(str),
  missing_keywords: arr(str),
  bullet_edits: arr(obj({ id: str, text: str, reason: str })),
  line_edits: arr(obj({ id: str, text: str, reason: str })),
  hide_bullet_ids: arr(str),
  entry_orders: arr(obj({ section_id: str, entry_ids: arr(str), reason: str })),
  summary: str,
  summary_reason: str,
});

const TAILOR_SYSTEM = `You tailor a student's resume to one job posting so it passes keyword screens and reads as relevant to a recruiter. You are editing a one-page resume.

Hard rules (never break these):
- Only rephrase, reorder or hide what is already in the resume. Never invent experience, employers, titles, dates, metrics, numbers, technologies, certifications or skills that aren't stated or clearly implied by the existing text.
- Keep every number and fact in a bullet intact. A rewritten bullet must describe the same work.
- Never change dates, titles, employers or schools.
- Keep bullets concise: about the same length as the original (one line, ~110 characters max where possible), starting with a strong past-tense verb (present tense for current roles).

What to do:
- Extract the posting's most important keywords (skills, tools, domains, responsibilities).
- Rewrite bullets where the same truthful content can use the posting's terminology or put the relevant part first. Leave bullets that are already fine unchanged (don't include them).
- In "lines" sections (e.g. Skills), reorder items so the posting's matching skills come first; you may drop clearly irrelevant items from a line but never add skills that don't appear anywhere in the resume.
- Optionally reorder entries within a section (e.g. put the most relevant project first). Don't reorder Education or work experience out of reverse-chronological order.
- Hide at most a few clearly irrelevant bullets if it helps the resume fit and focus.
- If the resume has a summary, you may rewrite it for this role; if it has none, return "".
- missing_keywords: important posting keywords the resume has no truthful evidence for (so the student can decide whether to add them honestly).
- company and role: from the posting, e.g. "Stripe" and "Software Engineering Intern".
Use the exact ids from the resume JSON. Give each edit a short reason (under 12 words).`;

export async function tailorResume(settings, resumeForAI, job) {
  const text = `<job_posting url="${job.url || ""}">\n${job.text}\n</job_posting>\n\n<resume_json>\n${JSON.stringify(resumeForAI)}\n</resume_json>\n\nTailor the resume to this job posting.`;
  return callJSON(settings, { system: TAILOR_SYSTEM, content: text, schema: TAILOR_SCHEMA, effort: "medium" });
}

// ----------------------------------------------------------------- answers

const ANSWER_SCHEMA = obj({ answers: arr(obj({ qid: str, answer: str })) });

const ANSWER_SYSTEM = `You draft answers to job application questions for a student applying to an internship. The student will review every answer before submitting.

- Write in the first person as the student, sincere and specific, drawing only on facts in their resume and profile. Never invent experience.
- Short text: a direct answer (a few words to one sentence). Long text: 80–150 words unless the question asks for a different length; tie the student's real experience to this company and role.
- single_choice / dropdown / multi_choice: answer with exactly one of the given options' text (for multi_choice, the single best option). Use the profile for eligibility/demographic questions; if unknown, choose the option that declines to answer if there is one.
- If a question can't be answered truthfully from the information given (e.g. asks for a referral name, salary expectations, or a fact you don't know), return an empty string for it.
Return one answer per question, using its qid.`;

export async function draftAnswers(settings, { questions, resumeText, profile, job }) {
  const text = `<job_posting>\n${(job?.text || "").slice(0, 30000)}\n</job_posting>\n\n<resume>\n${resumeText}\n</resume>\n\n<profile>\n${JSON.stringify(profile)}\n</profile>\n\n<questions>\n${JSON.stringify(questions)}\n</questions>`;
  const r = await callJSON(settings, { system: ANSWER_SYSTEM, content: text, schema: ANSWER_SCHEMA, effort: "medium" });
  return r.answers || [];
}
