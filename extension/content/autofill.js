// JobPilot autofill engine. Injected on demand into every frame of the
// active tab (application forms are often inside iframes, e.g. Greenhouse
// embeds). Exposes window.__jobpilot with fill / collectQuestions /
// fillAnswers / clearMarks, called from the side panel via
// chrome.scripting.executeScript.
(() => {
  if (window.__jobpilot) return;

  const MARK_ATTR = "data-jobpilot";
  const QID_ATTR = "data-jobpilot-qid";
  const COLORS = {
    filled: { outline: "#16a34a", bg: "rgba(22,163,74,0.07)" },
    review: { outline: "#f59e0b", bg: "rgba(245,158,11,0.10)" },
    draft: { outline: "#7c3aed", bg: "rgba(124,58,237,0.07)" },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) =>
    (s || "")
      .replace(/\s+/g, " ")
      .replace(/\*/g, "")
      .replace(/\(required\)/gi, "")
      .trim();
  const norm = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[_\-./:*()[\]]+/g, " ")
      .replace(/[^a-z0-9?# ]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  // ---------------------------------------------------------------- labels

  const CONTROL_SEL =
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea';

  function textOf(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("input, select, textarea, option, script, style, svg").forEach((n) => n.remove());
    // Keep a single " *" marker so required-ness survives cleaning.
    const raw = clone.textContent || "";
    const text = clean(raw);
    return text && /[*✱]|\(required\)/i.test(raw) ? `${text} *` : text;
  }

  function distinctControls(root) {
    const seen = new Set();
    let count = 0;
    for (const c of root.querySelectorAll(CONTROL_SEL)) {
      const key = c.type === "radio" || c.type === "checkbox" ? `${c.type}:${c.name}` : c;
      if (c.type === "radio" || c.type === "checkbox") {
        if (c.name && seen.has(key)) continue;
        seen.add(key);
      }
      count++;
    }
    return count;
  }

  // The question/label text describing a control.
  function labelFor(el) {
    const parts = [];
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      for (const id of lb.split(/\s+/)) {
        const n = document.getElementById(id);
        if (n) parts.push(textOf(n));
      }
    }
    if (parts.join("").length) return clean(parts.join(" "));

    if (el.labels && el.labels.length && el.type !== "radio" && el.type !== "checkbox") {
      const t = textOf(el.labels[0]);
      if (t) return t;
    }
    const wrapping = el.closest("label");
    if (wrapping && el.type !== "radio" && el.type !== "checkbox") {
      const t = textOf(wrapping);
      if (t) return t;
    }
    // Group question for radios/checkboxes lives in a fieldset legend or a
    // container label.
    const fs = el.closest("fieldset");
    if (fs) {
      const lg = fs.querySelector("legend");
      if (lg && textOf(lg)) return textOf(lg);
    }
    const isGroup = el.type === "radio" || el.type === "checkbox";
    // A lone checkbox ("I agree to…") is labeled by its own text.
    if (el.type === "checkbox" && (!el.name || document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`).length === 1)) {
      const own = optionLabel(el);
      if (own) return own;
    }
    for (let p = el.parentElement, depth = 0; p && depth < 6; p = p.parentElement, depth++) {
      if (p === document.body) break;
      // Stop once the container holds other fields: its labels belong to them.
      if (distinctControls(p) > 1) break;
      const candidates = p.querySelectorAll(
        'label, legend, [class*="label" i], [class*="question" i], [class*="title" i], [data-automation-id*="label" i]'
      );
      for (const c of candidates) {
        if (c.contains(el)) continue;
        // For radio/checkbox groups, skip the individual option labels.
        if (isGroup && (c.querySelector('input[type="radio"], input[type="checkbox"]') || c.closest("label")?.querySelector('input[type="radio"], input[type="checkbox"]'))) continue;
        const t = textOf(c);
        if (t && t.length < 400) return t;
      }
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    if (el.placeholder) return clean(el.placeholder);
    return "";
  }

  function optionLabel(radio) {
    if (radio.labels && radio.labels.length) return textOf(radio.labels[0]);
    const w = radio.closest("label");
    if (w) return textOf(w);
    if (radio.getAttribute("aria-label")) return clean(radio.getAttribute("aria-label"));
    const sib = radio.nextElementSibling;
    if (sib) return textOf(sib);
    return radio.value || "";
  }

  function descriptor(el, label) {
    return [
      label,
      el.name,
      el.id,
      el.placeholder,
      el.getAttribute("autocomplete"),
      el.getAttribute("aria-label"),
      el.getAttribute("data-automation-id"),
      el.getAttribute("data-qa"),
    ]
      .filter(Boolean)
      .join(" | ");
  }

  function isRequired(el, label) {
    return (
      el.required ||
      el.getAttribute("aria-required") === "true" ||
      /[*✱]/.test(label || "") ||
      !!el.closest('[class*="required" i]')
    );
  }

  function isVisible(el) {
    if (el.type === "file") return true;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  // ------------------------------------------------------------ field map

  // Ordered: first match wins. Each rule tests the label first, then the
  // control's attributes.
  const RULES = [
    { key: "skip", re: /phone (device )?type|phone extension|country code|captcha|password|verification code|middle name/ },
    { key: "preferredName", re: /preferred (first )?name|nickname|name you go by/ },
    { key: "firstName", re: /first name|given name|\bfname\b|firstname|legal first/ },
    { key: "lastName", re: /last name|family name|surname|\blname\b|lastname|legal last/ },
    { key: "email", re: /e ?mail/ },
    { key: "phone", re: /phone|mobile|cell number|telephone/ },
    { key: "linkedin", re: /linked ?in/ },
    { key: "github", re: /git ?hub/ },
    { key: "website", re: /portfolio|personal (web)?site|website|blog|other (link|url)|^url$/ },
    { key: "fullName", re: /^(full |legal |your |candidate )?name$|^full name|^legal name|^name$/ },
    { key: "school", re: /school|university|college|institution/ },
    { key: "major", re: /major|discipline|field of study|area of study|concentration/ },
    { key: "degree", re: /degree|level of (study|education)|education level/ },
    { key: "gpa", re: /\bgpa\b|grade point/ },
    { key: "gradDate", re: /graduat|grad (date|year)|class of|completion date/ },
    { key: "currentCompany", re: /current (company|employer)|^company$|^org$|^organization$|most recent (company|employer)/ },
    { key: "currentTitle", re: /current (title|role|position)/ },
    { key: "workAuth", re: /authori[sz]ed to work|work authori[sz]ation|eligible to work|legally (able|permitted) to work|right to work/ },
    { key: "sponsorship", re: /sponsor|visa status|require.*visa/ },
    { key: "over18", re: /18 years|at least 18|over the age of|age of 18/ },
    { key: "relocate", re: /relocat/ },
    { key: "howHeard", re: /how did you (hear|find|learn)|hear about|where did you (hear|find)|referral source|^source$/ },
    { key: "startDate", re: /start date|available to start|when can you start|earliest (start|availability)/ },
    { key: "pronouns", re: /pronoun/ },
    { key: "hispanic", re: /hispanic|latin[oax]/ },
    { key: "gender", re: /gender|\bsex\b/ },
    { key: "race", re: /\brace\b|ethnic/ },
    { key: "veteran", re: /veteran|military/ },
    { key: "disability", re: /disabilit/ },
    { key: "address", re: /street|address line|^address$|mailing address/ },
    { key: "zip", re: /zip|postal/ },
    { key: "city", re: /^city$|current city|city of residence/ },
    { key: "state", re: /\bstate\b|province/ },
    { key: "country", re: /country/ },
    { key: "location", re: /location|where are you (currently )?(based|located)|city,? state|current residence/ },
  ];

  const ATTR_HINTS = [
    { key: "firstName", re: /given-name|first_?name|firstname/ },
    { key: "lastName", re: /family-name|last_?name|lastname/ },
    { key: "email", re: /\bemail\b/ },
    { key: "phone", re: /\btel\b|phone/ },
    { key: "fullName", re: /^name$|^full_?name$|_systemfield_name|\bname\b/ },
    { key: "currentCompany", re: /^org$/ },
  ];

  // Keys that legitimately appear inside long, sentence-style questions.
  const QUESTION_KEYS = new Set([
    "workAuth", "sponsorship", "over18", "relocate", "howHeard", "startDate", "gradDate",
    "hispanic", "gender", "race", "veteran", "disability", "pronouns", "skip",
  ]);

  function classify(el, label) {
    const l = norm(label);
    if (l) {
      for (const r of RULES) {
        if (l.length > 60 && !QUESTION_KEYS.has(r.key)) continue;
        if (r.re.test(l)) {
          if (el instanceof HTMLTextAreaElement && !["address", "skip"].includes(r.key)) return null;
          return r.key;
        }
      }
    }
    const attrs = [el.name, el.id, el.getAttribute("autocomplete"), el.getAttribute("data-automation-id")]
      .filter(Boolean)
      .map((s) => s.toLowerCase());
    for (const a of attrs) {
      if (/^urls?\[?linkedin/i.test(a)) return "linkedin";
      if (/^urls?\[?github/i.test(a)) return "github";
      if (/^urls?\[?(portfolio|other)/i.test(a)) return "website";
      for (const h of ATTR_HINTS) if (h.re.test(a)) return h.key;
    }
    return null;
  }

  // The value to use for a field key; yes/no keys return "Yes"/"No".
  function valueFor(key, p) {
    const yn = (b) => (b === true || b === "yes" ? "Yes" : b === false || b === "no" ? "No" : "");
    const gd = [p.gradMonth, p.gradYear].filter(Boolean).join(" ");
    const map = {
      firstName: p.firstName,
      lastName: p.lastName,
      preferredName: p.preferredName || p.firstName,
      fullName: [p.firstName, p.lastName].filter(Boolean).join(" "),
      email: p.email,
      phone: p.phone,
      linkedin: p.linkedin,
      github: p.github,
      website: p.website || p.github || p.linkedin,
      school: p.school,
      major: p.major,
      degree: p.degree,
      gpa: p.gpa,
      gradDate: gd,
      currentCompany: p.currentCompany || p.school,
      currentTitle: p.currentTitle,
      workAuth: yn(p.workAuthorized),
      sponsorship: yn(p.needsSponsorship),
      over18: yn(p.over18),
      relocate: yn(p.willingToRelocate),
      howHeard: p.howHeard,
      startDate: p.availableStart,
      pronouns: p.pronouns,
      gender: p.gender,
      race: p.race,
      hispanic: p.hispanic,
      veteran: p.veteran,
      disability: p.disability,
      address: p.address,
      zip: p.zip,
      city: p.city,
      state: p.state,
      country: p.country,
      location: [p.city, p.state].filter(Boolean).join(", ") || p.country,
    };
    return map[key] || "";
  }

  // ---------------------------------------------------------- set values

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const DECLINE_RE = /decline|prefer not|don ?t wish|do not wish|not wish to|choose not|not to (say|answer|disclose|identify)|rather not|not specified/;

  // Pick the option text best matching a desired value.
  function bestOption(options, value, key) {
    const v = norm(value);
    if (!v) return -1;
    const texts = options.map((o) => norm(o));
    const yesNo = v === "yes" || v === "no";
    if (yesNo) {
      let i = texts.findIndex((t) => t === v);
      if (i < 0) i = texts.findIndex((t) => t.startsWith(v + " ") || t.startsWith(v + ","));
      if (i < 0 && key === "workAuth" && v === "yes") i = texts.findIndex((t) => /^(i am|i m) (legally )?authori/.test(t));
      return i;
    }
    if (DECLINE_RE.test(v)) return texts.findIndex((t) => DECLINE_RE.test(t));
    let i = texts.findIndex((t) => t === v);
    if (i < 0) i = texts.findIndex((t) => t.startsWith(v));
    if (i < 0) i = texts.findIndex((t) => t.includes(v));
    if (i < 0 && v.length > 3) i = texts.findIndex((t) => t.length > 2 && v.includes(t));
    if (i < 0 && key === "gradDate") {
      const year = (value.match(/\d{4}/) || [])[0];
      if (year) i = texts.findIndex((t) => t.includes(year));
    }
    return i;
  }

  function mark(el, kind, note) {
    const target = el.type === "radio" || el.type === "checkbox" ? el.closest("fieldset") || el.parentElement : el;
    if (!target) return;
    const c = COLORS[kind];
    target.setAttribute(MARK_ATTR, kind);
    target.style.outline = `2px solid ${c.outline}`;
    target.style.outlineOffset = "2px";
    target.style.backgroundColor = c.bg;
    if (note) target.title = `JobPilot: ${note}`;
  }

  function clearMarks() {
    document.querySelectorAll(`[${MARK_ATTR}]`).forEach((n) => {
      n.style.outline = "";
      n.style.outlineOffset = "";
      n.style.backgroundColor = "";
      n.removeAttribute(MARK_ATTR);
    });
  }

  function isEmpty(el) {
    if (el instanceof HTMLSelectElement) {
      const opt = el.options[el.selectedIndex];
      return !opt || !opt.value || /^(select|choose|please|--)/i.test(clean(opt.textContent));
    }
    return !String(el.value || "").trim();
  }

  function fillSelect(el, value, key) {
    const opts = [...el.options];
    const i = bestOption(opts.map((o) => o.textContent), value, key);
    if (i < 0) return false;
    setNativeValue(el, opts[i].value);
    return true;
  }

  function radioGroup(el) {
    const form = el.form || document;
    if (!el.name) return [el];
    return [...form.querySelectorAll(`input[type="${el.type}"][name="${CSS.escape(el.name)}"]`)];
  }

  function fillRadio(group, value, key) {
    const labels = group.map(optionLabel);
    const i = bestOption(labels, value, key);
    if (i < 0) return false;
    group[i].click();
    if (!group[i].checked) {
      group[i].checked = true;
      group[i].dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }

  function isCombobox(el) {
    return (
      el instanceof HTMLInputElement &&
      (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list" || el.getAttribute("aria-haspopup") === "listbox")
    );
  }

  function visibleOptions() {
    return [...document.querySelectorAll('[role="option"], [id*="-option-"], [data-automation-id="promptOption"]')].filter((o) => {
      const r = o.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  // React-select style dropdowns (new Greenhouse boards, Ashby, Workday).
  async function fillCombobox(el, value, key) {
    el.focus();
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.click();
    await sleep(150);
    let opts = visibleOptions();
    let i = bestOption(opts.map((o) => o.textContent), value, key);
    if (i < 0) {
      const typed = /^(yes|no)$/i.test(value) ? value : value.slice(0, 30);
      setNativeValue(el, typed);
      await sleep(450);
      opts = visibleOptions();
      i = bestOption(opts.map((o) => o.textContent), value, key);
    }
    if (i < 0) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      setNativeValue(el, "");
      el.blur();
      return false;
    }
    opts[i].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    opts[i].click();
    await sleep(100);
    el.blur();
    return true;
  }

  function base64ToFile(file) {
    const bin = atob(file.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], file.name, { type: file.mime || "application/pdf" });
  }

  function attachFile(input, file) {
    const dt = new DataTransfer();
    dt.items.add(base64ToFile(file));
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ----------------------------------------------------------- main fill

  function controls() {
    return [...document.querySelectorAll(CONTROL_SEL)].filter((el) => !el.disabled && !el.readOnly && isVisible(el));
  }

  async function fill({ profile, resumeFile }) {
    clearMarks();
    const report = { url: location.href, filled: [], review: [], attached: null, skippedFilled: 0, controls: 0 };
    const doneGroups = new Set();
    const all = controls();
    report.controls = all.length;

    // Resume upload.
    if (resumeFile) {
      const files = all.filter((el) => el.type === "file");
      const described = files.map((el) => ({ el, d: norm(descriptor(el, labelFor(el))) }));
      let target =
        described.find((f) => /resume|\bcv\b|curriculum/.test(f.d) && !/cover/.test(f.d)) ||
        (described.filter((f) => !/cover|transcript|portfolio|writing sample|other/.test(f.d)).length === 1
          ? described.find((f) => !/cover|transcript|portfolio|writing sample|other/.test(f.d))
          : null);
      if (target) {
        try {
          attachFile(target.el, resumeFile);
          report.attached = resumeFile.name;
          mark(target.el.closest('[class*="upload" i], [class*="file" i], [class*="resume" i]') || target.el.parentElement || target.el, "filled", "resume attached");
        } catch (e) {
          report.review.push({ label: "Resume upload", reason: "Couldn't attach automatically: " + e.message });
        }
      }
    }

    for (const el of all) {
      if (el.type === "file") continue;
      const isGroup = el.type === "radio" || el.type === "checkbox";
      if (isGroup) {
        const gk = `${el.type}:${el.name}`;
        if (doneGroups.has(gk)) continue;
        doneGroups.add(gk);
      }
      const label = labelFor(el);
      const key = classify(el, label);
      if (!key || key === "skip") continue;
      const value = valueFor(key, profile);
      const short = (label || el.name || key).slice(0, 80);

      if (!value) {
        if (isRequired(el, label)) {
          mark(el, "review", "no saved value for this field");
          report.review.push({ label: short, reason: "No saved value (add it in Settings → Profile)" });
        }
        continue;
      }

      try {
        let ok = false;
        if (isGroup) {
          const group = radioGroup(el);
          if (group.some((g) => g.checked)) {
            report.skippedFilled++;
            continue;
          }
          if (el.type === "checkbox" && group.length === 1) continue; // consent boxes: leave to the user
          ok = fillRadio(group, value, key);
        } else if (!isEmpty(el)) {
          report.skippedFilled++;
          continue;
        } else if (el instanceof HTMLSelectElement) {
          ok = fillSelect(el, value, key);
        } else if (isCombobox(el)) {
          ok = await fillCombobox(el, value, key);
        } else {
          setNativeValue(el, value);
          ok = true;
        }
        if (ok) {
          mark(el, "filled", `filled: ${key}`);
          report.filled.push({ label: short, key, value: String(value).slice(0, 60) });
        } else {
          mark(el, "review", `couldn't match "${value}"`);
          report.review.push({ label: short, reason: `No option matched "${value}"` });
        }
      } catch (e) {
        report.review.push({ label: short, reason: e.message });
      }
    }
    return report;
  }

  // ---------------------------------------------------- open questions

  // Unfilled controls that look like real application questions (not
  // profile fields), for the AI to draft answers to.
  function collectQuestions() {
    // Ids restart at 0 each call, so drop old ones to avoid duplicates.
    document.querySelectorAll(`[${QID_ATTR}]`).forEach((n) => n.removeAttribute(QID_ATTR));
    const out = [];
    const doneGroups = new Set();
    let n = 0;
    for (const el of controls()) {
      if (el.type === "file") continue;
      const isGroup = el.type === "radio" || el.type === "checkbox";
      if (isGroup) {
        const gk = `${el.type}:${el.name}`;
        if (doneGroups.has(gk)) continue;
        doneGroups.add(gk);
      }
      const label = labelFor(el);
      if (!label || label.length < 4) continue;
      const key = classify(el, label);
      if (key) continue;
      const required = isRequired(el, label);
      let kind, options;
      if (isGroup) {
        const group = radioGroup(el);
        if (group.some((g) => g.checked)) continue;
        if (el.type === "checkbox" && group.length === 1) continue;
        kind = el.type === "radio" ? "single_choice" : "multi_choice";
        options = group.map(optionLabel).filter(Boolean);
      } else {
        if (!isEmpty(el)) continue;
        if (el instanceof HTMLSelectElement) {
          kind = "single_choice";
          options = [...el.options].map((o) => clean(o.textContent)).filter((t) => t && !/^(select|choose|please|--)/i.test(t));
        } else if (el instanceof HTMLTextAreaElement) {
          kind = "long_text";
        } else if (isCombobox(el)) {
          kind = "dropdown";
        } else {
          if (!/\?/.test(label) && label.length < 25 && !required) continue;
          kind = "short_text";
        }
      }
      // Stable ids (same page → same ids) so cached AI answers can be reused.
      const qid = `${location.host}${location.pathname}#${n++}`;
      el.setAttribute(QID_ATTR, qid);
      out.push({ qid, question: label.slice(0, 500), kind, options: options || [], required });
    }
    return out;
  }

  async function fillAnswers(answers) {
    let count = 0;
    for (const a of answers) {
      const el = document.querySelector(`[${QID_ATTR}="${CSS.escape(a.qid)}"]`);
      if (!el || !a.answer) continue;
      let ok = false;
      try {
        if (el.type === "radio" || el.type === "checkbox") ok = fillRadio(radioGroup(el), a.answer, null);
        else if (el instanceof HTMLSelectElement) ok = fillSelect(el, a.answer, null);
        else if (isCombobox(el)) ok = await fillCombobox(el, a.answer, null);
        else {
          setNativeValue(el, a.answer);
          ok = true;
        }
      } catch {
        ok = false;
      }
      if (ok) {
        mark(el, "draft", "AI draft — review before submitting");
        count++;
      } else {
        mark(el, "review", "AI suggestion didn't fit this field");
      }
    }
    return count;
  }

  // ------------------------------------------------------- autopilot helpers

  const clickableText = (el) => clean(el.innerText || el.value || el.getAttribute("aria-label") || "");

  function visibleEl(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  // How much of an application form is on this page.
  function formStats() {
    const all = controls().filter((el) => !["search", "hidden"].includes(el.type) && !el.closest('[role="search"], header, nav'));
    return {
      controls: all.length,
      fileInputs: all.filter((el) => el.type === "file").length,
      host: location.host,
      url: location.href,
    };
  }

  // Click the posting's "Apply" button to reveal or navigate to the form.
  function clickApply() {
    const re = /^(apply|apply now|apply for this (job|position|role)|apply to this (job|position)|apply here|start application|i'?m interested)$/i;
    const bad = /linkedin|indeed|google|glassdoor|with resume|saved/i;
    const cands = [...document.querySelectorAll('a, button, [role="button"], input[type="button"]')].filter((el) => visibleEl(el) && re.test(clickableText(el)) && !bad.test(clickableText(el)));
    const el = cands[0];
    if (!el) return { clicked: false };
    const href = el.tagName === "A" ? el.href : null;
    el.click();
    return { clicked: true, text: clickableText(el), href };
  }

  // Required fields that are still empty after filling.
  function missingRequired() {
    const out = [];
    const doneGroups = new Set();
    for (const el of controls()) {
      const isGroup = el.type === "radio" || el.type === "checkbox";
      if (isGroup) {
        const gk = `${el.type}:${el.name}`;
        if (doneGroups.has(gk)) continue;
        doneGroups.add(gk);
      }
      const label = labelFor(el);
      if (!isRequired(el, label)) continue;
      let empty;
      if (el.type === "file") empty = !el.files || el.files.length === 0;
      else if (isGroup) empty = !radioGroup(el).some((g) => g.checked);
      else empty = isEmpty(el);
      if (empty) out.push((label || el.name || el.id || "Unlabeled field").slice(0, 80));
    }
    return out;
  }

  function detectCaptcha() {
    const frames = [...document.querySelectorAll("iframe")].filter((f) => /recaptcha\/api2\/anchor|hcaptcha\.com|challenges\.cloudflare\.com/i.test(f.src) && visibleEl(f));
    return frames.length > 0;
  }

  // Company and role from the page, without AI.
  function jobMeta() {
    const title = clean(document.title);
    const og = (p) => clean(document.querySelector(`meta[property="og:${p}"]`)?.content || "");
    const h1 = clean(document.querySelector("h1")?.innerText || "");
    const pathCompany = () => {
      const m = location.pathname.split("/").filter(Boolean);
      if (/greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com/.test(location.host) && m[0]) return m[0].replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      return "";
    };
    let m = title.match(/^Job Application for (.+?) at (.+)$/i);
    if (m) return { role: m[1], company: m[2] };
    m = title.match(/^(.+?) @ (.+)$/);
    if (m) return { role: m[1], company: m[2] };
    if (/lever\.co/.test(location.host) && (m = title.match(/^(.+?) - (.+)$/))) return { company: m[1], role: m[2] };
    m = title.match(/^(.+?) (?:-|–|\|) (.+?)(?: (?:-|–|\|) .*)?$/);
    const company = og("site_name") || pathCompany() || (m ? m[2] : "");
    return { company, role: h1 || (m ? m[1] : title) };
  }

  // Required "I certify / I agree" checkboxes (used only by Autopilot,
  // which you've allowed to submit on your behalf).
  function checkAttestations() {
    let n = 0;
    for (const el of controls()) {
      if (el.type !== "checkbox" || el.checked) continue;
      const group = radioGroup(el);
      if (group.length !== 1) continue;
      const label = norm(optionLabel(el) + " " + labelFor(el));
      if (!isRequired(el, label) && !/\*/.test(optionLabel(el))) continue;
      if (/certify|acknowledge|agree|understand|consent|accurate|attest|confirm|privacy/.test(label) && !/sms|text message|marketing|newsletter/.test(label)) {
        el.click();
        if (!el.checked) {
          el.checked = true;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        mark(el, "filled", "attestation checked by Autopilot");
        n++;
      }
    }
    return n;
  }

  function submit() {
    const re = /^(submit|submit application|submit my application|send application|apply|apply now|finish|complete application)$/i;
    const forms = [...document.querySelectorAll("form")].filter((f) => f.querySelector("input, textarea, select"));
    for (const root of forms.length ? forms : [document]) {
      const btns = [...root.querySelectorAll('button, input[type="submit"], [role="button"]')].filter((b) => visibleEl(b) && !b.disabled);
      const btn = btns.find((b) => b.type === "submit" && re.test(clickableText(b))) || btns.find((b) => re.test(clickableText(b))) || btns.find((b) => b.type === "submit");
      if (btn) {
        btn.click();
        return { clicked: true, text: clickableText(btn) };
      }
    }
    return { clicked: false };
  }

  // After submitting: did the site confirm, or show errors?
  function submissionState() {
    const text = (document.body.innerText || "").slice(0, 20000);
    const confirmed =
      /thank(s| you) for (applying|your (application|interest|submission))|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully (submitted|applied)|your application is (complete|in)/i.test(text) ||
      /confirmation|thank-?you|submitted|success/i.test(location.pathname);
    const errors = [...document.querySelectorAll('[aria-invalid="true"], .error, .field-error, [class*="error" i]')]
      .filter((e) => visibleEl(e) && clean(e.innerText).length > 0 && clean(e.innerText).length < 200)
      .map((e) => clean(e.innerText));
    return { confirmed, errors: [...new Set(errors)].slice(0, 5) };
  }

  window.__jobpilot = {
    fill,
    collectQuestions,
    fillAnswers,
    clearMarks,
    formStats,
    clickApply,
    missingRequired,
    detectCaptcha,
    jobMeta,
    checkAttestations,
    submit,
    submissionState,
    _labelFor: labelFor,
    _classify: classify,
  };
})();
