// Claude calls: resume parsing (once) and per-job bullet rewrites + answers.
import { Anthropic } from "../vendor/anthropic.js";

export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (fast, recommended)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fastest, cheapest)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best writing, slower)" },
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
  { id: "sonnet", label: "Sonnet (fast, recommended)" },
  { id: "haiku", label: "Haiku (fastest)" },
  { id: "opus", label: "Opus (best writing, slower, uses limits faster)" },
  { id: "default", label: "Your Claude Code default" },
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
  const resp = await bridge({ type: "run", system, prompt, schema, model: settings.ccModel || "sonnet", effort, pdfBase64 });
  return resp.data;
}

export async function pingBridge() {
  return bridge({ type: "ping" });
}

// ------------------------------------------------------------- caching
// Same model + prompt + schema → same stored answer, so repeated work is
// instant and results stay consistent (current models don't accept a
// temperature setting, so caching is how we make them deterministic).

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CACHE_KEY = "aiCache";
const CACHE_MAX = 300;

async function cached(key, fn) {
  const store = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  if (store[key]) return store[key].v;
  const v = await fn();
  const fresh = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  fresh[key] = { v, t: Date.now() };
  const keys = Object.keys(fresh);
  if (keys.length > CACHE_MAX) keys.sort((a, b) => fresh[a].t - fresh[b].t).slice(0, keys.length - CACHE_MAX).forEach((k) => delete fresh[k]);
  await chrome.storage.local.set({ [CACHE_KEY]: fresh });
  return v;
}

function modelFor(settings) {
  return settings.provider === "claude-code" ? `cc:${settings.ccModel || "sonnet"}` : `api:${settings.model}`;
}

async function callJSON(settings, opts) {
  const key = await sha256(JSON.stringify([modelFor(settings), opts.system, opts.content, opts.schema, opts.effort]));
  return cached(key, () => callJSONUncached(settings, opts));
}

async function callJSONUncached(settings, { system, content, schema, effort = "low", maxTokens = 16000 }) {
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

// ------------------------------------------- bullet rewrites + answers
// The only per-job AI step. Keywords, skills order, project order, page fit
// and standard questions are handled deterministically (keywords.js,
// answers.js); this call only rewords bullets and answers what's left, in
// one request to save Claude Code's per-call startup time.

const JOB_SCHEMA = obj({
  bullet_edits: arr(obj({ id: str, text: str })),
  answers: arr(obj({ qid: str, answer: str })),
});

const JOB_SYSTEM = `You help a student apply to one internship. Two tasks; either list may be empty.

1. bullet_edits: reword resume bullets so they use the posting's terminology where the SAME work truthfully fits. Only bullets that clearly improve; at most 6. Keep every number and fact; never add tools, skills, metrics or claims that aren't in the bullet or elsewhere in the resume; keep length similar (≤ ~110 characters); start with a strong past-tense verb. Use the given ids.

2. answers: answer each listed application question as the student, first person, using only facts from the resume and profile. short_text: a few words to one sentence. long_text: 80–150 words unless the question sets a length; connect the student's real experience to this company and role. single_choice / dropdown / multi_choice: reply with exactly one of the given options' text; for preference questions (team, location, interest area, shift) pick the option that best fits the resume and posting. Answer "" only for factual questions the resume and profile don't cover (e.g. a referrer's name, a specific date, an ID number).`;

// bullets: [{ id, text }]; questions: [{ qid, question, kind, options }]
export async function rewriteAndAnswer(settings, { bullets, keywords, posting, questions, resumeText, profile, company, role }) {
  if (!bullets.length && !questions.length) return { bullet_edits: [], answers: [] };
  const content = [
    `<job company="${company || ""}" role="${role || ""}">\n${posting}\n</job>`,
    keywords.length ? `<posting_keywords_the_resume_already_has>${keywords.join(", ")}</posting_keywords_the_resume_already_has>` : "",
    bullets.length ? `<bullets>\n${JSON.stringify(bullets)}\n</bullets>` : "",
    questions.length ? `<resume>\n${resumeText}\n</resume>\n<profile>${JSON.stringify(profile)}</profile>\n<questions>\n${JSON.stringify(questions.map(({ qid, question, kind, options }) => ({ qid, question, kind, options })))}\n</questions>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const effort = questions.some((q) => q.kind === "long_text") ? "medium" : "low";
  return callJSON(settings, { system: JOB_SYSTEM, content, schema: JOB_SCHEMA, effort });
}
