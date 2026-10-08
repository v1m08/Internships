// Deterministic job-posting analysis: no AI. Extracts known skills from a
// posting, compares them with the resume, reorders skills and projects by
// relevance, picks bullets to hide when the page overflows, and guards AI
// bullet rewrites against invented facts.

// canonical name → aliases (matched case-insensitively on word boundaries)
const LEXICON = {
  Python: [], Java: [], JavaScript: ["js", "ecmascript"], TypeScript: ["ts"], "C++": ["cpp"], C: [], "C#": ["csharp", "c sharp"], Go: ["golang"], Rust: [], Kotlin: [], Swift: [], "Objective-C": [], Ruby: [], PHP: [], Scala: [], R: [], MATLAB: [], Julia: [], Perl: [], Haskell: [], Elixir: [], Dart: [], Lua: [], Bash: ["shell scripting", "shell"], SQL: [], "NoSQL": [], HTML: ["html5"], CSS: ["css3"], Verilog: [], VHDL: [], SystemVerilog: [], Assembly: ["asm"], Solidity: [],
  React: ["react.js", "reactjs"], "React Native": [], "Next.js": ["nextjs"], Vue: ["vue.js", "vuejs"], Angular: ["angularjs"], Svelte: [], "Node.js": ["node", "nodejs"], Express: ["express.js"], Django: [], Flask: [], FastAPI: [], "Spring Boot": ["spring"], Rails: ["ruby on rails"], ".NET": ["dotnet", "asp.net"], GraphQL: [], REST: ["rest api", "rest apis", "restful"], gRPC: [], WebSockets: ["websocket"], Redux: [], Tailwind: ["tailwindcss"], jQuery: [], Flutter: [], SwiftUI: [], "Android": [], iOS: [], Electron: [], Unity: [], "Unreal Engine": ["unreal"],
  PostgreSQL: ["postgres", "psql"], MySQL: [], SQLite: [], MongoDB: ["mongo"], Redis: [], Cassandra: [], DynamoDB: [], Elasticsearch: ["elastic search"], Snowflake: [], BigQuery: [], Redshift: [], Firebase: [], Supabase: [], Kafka: [], RabbitMQ: [], Spark: ["apache spark", "pyspark"], Hadoop: [], Airflow: [], dbt: [], Flink: [], Databricks: [], "Data Pipelines": ["data pipeline", "etl", "elt"], "Data Warehousing": ["data warehouse"],
  AWS: ["amazon web services"], GCP: ["google cloud", "google cloud platform"], Azure: ["microsoft azure"], Docker: ["containers", "containerization"], Kubernetes: ["k8s"], Terraform: [], Ansible: [], Linux: ["unix"], Git: ["github", "gitlab", "version control"], "CI/CD": ["ci cd", "continuous integration", "continuous delivery", "continuous deployment"], Jenkins: [], "GitHub Actions": [], Serverless: ["lambda", "aws lambda"], Nginx: [], Microservices: ["microservice"], "Distributed Systems": ["distributed system", "distributed computing"], "Cloud": ["cloud computing", "cloud infrastructure"], Networking: ["tcp/ip", "networks"], Observability: ["monitoring", "prometheus", "grafana", "datadog"],
  "Machine Learning": ["ml"], "Deep Learning": [], AI: ["artificial intelligence"], "LLMs": ["llm", "large language models", "large language model", "generative ai", "genai"], NLP: ["natural language processing"], "Computer Vision": ["image processing"], "Reinforcement Learning": ["rl"], PyTorch: ["torch"], TensorFlow: [], Keras: [], JAX: [], "scikit-learn": ["sklearn", "scikit learn"], Pandas: [], NumPy: [], SciPy: [], Matplotlib: [], OpenCV: [], "Hugging Face": ["huggingface", "transformers"], LangChain: [], CUDA: [], "Data Analysis": ["data analytics", "analytics"], "Data Visualization": ["tableau", "power bi", "looker"], Statistics: ["statistical", "probability"], "A/B Testing": ["ab testing", "experimentation"], Excel: [],
  ROS: ["robot operating system"], Robotics: ["robot", "robots", "robotic"], "Embedded Systems": ["embedded", "firmware", "microcontroller", "microcontrollers"], FPGA: [], RTOS: [], Arduino: [], "Raspberry Pi": [], "Signal Processing": ["dsp"], "Control Systems": ["controls"], SLAM: [], Simulink: [], CAD: ["solidworks", "autocad", "fusion 360"], PCB: ["altium", "kicad"],
  "Data Structures": [], Algorithms: [], "Object-Oriented Programming": ["oop", "object oriented"], "Systems Design": ["system design"], "Operating Systems": [], Concurrency: ["multithreading", "multithreaded", "parallel programming"], Security: ["cybersecurity", "cyber security", "infosec"], Cryptography: [], "Unit Testing": ["testing", "test automation", "pytest", "junit", "jest"], Agile: ["scrum"], "APIs": ["api"], Backend: ["back-end", "back end", "server-side"], Frontend: ["front-end", "front end", "ui development"], "Full-Stack": ["full stack", "fullstack"], Mobile: ["mobile development"], "Web Development": ["web applications", "web apps"], Blockchain: ["web3"], Compilers: [], Databases: ["database"], Performance: ["optimization", "latency"], Figma: [], Jira: [],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const boundary = (term) => {
  const e = escapeRe(term.toLowerCase());
  // \b doesn't work around symbols like "C++" or ".NET"
  return new RegExp(`(?<![a-z0-9+#.])${e}(?![a-z0-9+#])`, "g");
};

const MATCHERS = Object.entries(LEXICON).map(([canon, aliases]) => ({
  canon,
  // Single letters (C, R, Go) only count when written with their exact casing.
  res: [canon, ...aliases].map((t) => ({ re: boundary(t), caseSensitive: t.length <= 2 || t === "Go", raw: t })),
}));

function countIn(text, lower, m) {
  let n = 0;
  for (const { re, caseSensitive, raw } of m.res) {
    if (caseSensitive) {
      // Short names: exact case, or all caps for aliases ("ml" → "ML").
      for (const v of new Set([raw, raw.toUpperCase()])) {
        const r = new RegExp(`(?<![A-Za-z0-9+#.&])${escapeRe(v)}(?![A-Za-z0-9+#&])`, "g");
        n += (text.match(r) || []).length;
      }
    } else {
      re.lastIndex = 0;
      n += (lower.match(re) || []).length;
    }
  }
  return n;
}

// Known skills mentioned in a text: [{ term, count }] sorted by count desc.
export function extractTerms(text) {
  const t = String(text || "");
  const lower = t.toLowerCase();
  const out = [];
  for (const m of MATCHERS) {
    const count = countIn(t, lower, m);
    if (count) out.push({ term: m.canon, count });
  }
  return out.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

export const termsOf = (text) => new Set(extractTerms(text).map((x) => x.term));

// Keep the parts of a posting that matter (drops EEO/benefits boilerplate)
// so AI prompts are smaller and faster.
export function trimPosting(text, maxChars = 9000) {
  const drop = /equal opportunity|eeo|reasonable accommodation|benefits|401\(k\)|pay transparency|privacy (notice|policy)|cookie|e-verify|disabilit(y|ies) (and|or) veteran|applicants with (arrest|criminal)|background check|we are an equal/i;
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !drop.test(sentence))
        .join(" ")
        .trim()
    )
    .filter(Boolean);
  let out = "";
  for (const line of lines) {
    if (out.length + line.length > maxChars) break;
    out += line + "\n";
  }
  return out.trim();
}

// ------------------------------------------------------------- analysis

export function analyze(postingText, resumeText) {
  const jd = extractTerms(postingText);
  const have = termsOf(resumeText);
  const weights = Object.fromEntries(jd.map((x) => [x.term, x.count]));
  return {
    keywords: jd.filter((x) => have.has(x.term)).map((x) => x.term),
    missing: jd.filter((x) => !have.has(x.term)).map((x) => x.term),
    weights,
  };
}

const scoreText = (text, weights) => extractTerms(text).reduce((s, x) => s + (weights[x.term] ? weights[x.term] + 1 : 0), 0);

// Stable sort: higher score first, original order for ties.
const stableBy = (arr, score) =>
  arr
    .map((x, i) => ({ x, i, s: score(x) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((o) => o.x);

function splitItems(text) {
  const items = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      items.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return items.filter(Boolean);
}

// Deterministic tailoring changes (same shape as resume.changesFromTailoring).
export function deterministicChanges(resume, weights, uid) {
  const changes = [];
  for (const s of resume.sections || []) {
    if (s.kind === "lines") {
      for (const l of s.lines) {
        if (l.hidden || !l.text) continue;
        const items = splitItems(l.text);
        const sorted = stableBy(items, (it) => scoreText(it, weights));
        const after = sorted.join(", ");
        if (after !== items.join(", ")) changes.push({ id: uid("c"), type: "line", target: l.id, where: l.label || s.title, before: l.text, after, reason: "Posting's skills first", accepted: true });
      }
    }
    if (s.kind === "entries" && /project/i.test(s.title || "")) {
      const entryText = (e) => [e.title, e.subtitle, ...e.bullets.map((b) => b.text)].join(" ");
      const current = s.entries.map((e) => e.id);
      const order = stableBy(s.entries, (e) => scoreText(entryText(e), weights)).map((e) => e.id);
      if (order.join() !== current.join()) {
        const name = (id) => s.entries.find((e) => e.id === id).title || "(untitled)";
        changes.push({ id: uid("c"), type: "order", target: s.id, order, where: s.title, before: current.map(name).join(" → "), after: order.map(name).join(" → "), reason: "Most relevant project first", accepted: true });
      }
    }
  }
  return changes;
}

// Bullets to hide (least relevant first) when the resume overflows a page.
export function hideCandidates(resume, weights) {
  const out = [];
  for (const s of resume.sections || []) {
    if (s.kind !== "entries" || /education/i.test(s.title || "")) continue;
    for (const e of s.entries) {
      const vis = e.bullets.filter((b) => !b.hidden && b.text.trim());
      if (vis.length <= 2) continue; // keep at least two bullets per entry
      vis.forEach((b, i) => out.push({ id: b.id, entry: e.id, score: scoreText(b.text, weights), pos: i, keep: vis.length }));
    }
  }
  return out.sort((a, b) => a.score - b.score || b.pos - a.pos);
}

// ------------------------------------------------- AI rewrite guardrails

const numbers = (s) => (String(s).match(/\d+(?:[.,]\d+)?%?|\$\s?\d[\d,.]*[kKmM]?/g) || []).map((n) => n.replace(/[\s,]/g, "")).sort().join("|");

// Broad concepts (not specific tools) a rewrite may name freely.
const GENERIC = new Set(["APIs", "Backend", "Frontend", "Full-Stack", "Web Development", "Databases", "Performance", "Algorithms", "Data Structures", "Unit Testing", "Agile", "Cloud", "Mobile", "Data Analysis", "Data Pipelines", "Systems Design", "Object-Oriented Programming", "Concurrency", "Security", "Microservices"]);

// Accept an AI bullet rewrite only if it keeps every number, adds no specific
// tool/skill that's absent from the whole resume, and stays a similar length.
export function validRewrite(before, after, resumeTerms) {
  if (!after || after === before) return false;
  if (numbers(before) !== numbers(after)) return false;
  for (const t of termsOf(after)) if (!GENERIC.has(t) && !resumeTerms.has(t) && !termsOf(before).has(t)) return false;
  if (after.length > Math.max(before.length * 1.35, before.length + 40)) return false;
  return true;
}
