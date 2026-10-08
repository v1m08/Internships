# JobPilot

A Chrome extension that makes applying to internships fast:

1. **Upload your resume once.** Claude turns it into editable boxes (sections, entries, bullets, skills).
2. **Browse jobs** in the side panel. The list is pulled from the SimplifyJobs Summer 2027 internship list, and you can mark jobs as applied.
3. **Tailor per job.** Claude reads the posting and suggests rewording and reordering of your *existing* bullets and skills to match its keywords. You approve each change, and it never invents experience.
4. **Autofill.** On the application page it fills your name, contact info, school, links, work authorization, sponsorship and EEO answers, and attaches the tailored PDF, named like `Alex_Rivera_Resume_Stripe.pdf`.
5. **Answer the real questions.** Claude drafts answers to "Why this company?" style questions. They're highlighted purple so you can review them before you click Submit.

Downloads go to `Downloads/Resumes/` and overwrite files with the same name, so you never end up with `Resume (100).pdf`.

## Resume format: Jake's Resume

Every PDF uses the style of [Jake's Resume](https://github.com/jakegut/resume) LaTeX template (MIT). `extension/lib/latex.js` turns the resume JSON into `.tex` deterministically: the same JSON always gives the same file.

- **Keeps your resume's layout.** When Claude reads your PDF it also records how each section is laid out: organization or role on top, dates on the first or second line, one-line project headings with a GitHub link, single-line award rows, bold labels inside bullets, and the order of your contact line. You can change any of it under **Layout** on each section in the Resume tab. Resumes uploaded before this existed: click **Re-parse**.
- **Always one page.** If a tailored resume runs long, every font size and gap shrinks together (down to 85%) until it fits. Tailoring hides the least relevant bullets before it lets text get smaller than about 92%.

- **Exact LaTeX output:** if you use the Claude Code bridge and have a TeX engine installed (MacTeX on Mac, MiKTeX on Windows, TeX Live, or Tectonic), JobPilot compiles the `.tex` on your computer with `pdflatex`. Run `brew install --cask mactex-no-gui`, or `brew install tectonic` for something smaller.
- **No LaTeX installed:** JobPilot draws the same layout itself in Computer Modern (the LaTeX font), so it looks nearly identical.
- **Resume tab:** *Download .tex* gives you the source, and *Open in Overleaf* opens it as a new Overleaf project.

## Install (about 2 minutes)

1. Clone this repo: `git clone https://github.com/v1m08/Internships.git JobPilot`. (A clone lets JobPilot update itself. **Code → Download ZIP** also works, but then you update by hand.)
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder.
4. Pin the extension (puzzle icon → pin **JobPilot**). Click it, or press **Alt+J**, to open the side panel.

It also works in Brave, Edge and Arc (all Chromium-based).

## Set up

### 1. Connect Claude (pick one)

**Option A: your Claude Pro/Max subscription, via Claude Code (no API key)**

JobPilot can't sign in with your Claude account directly; Anthropic only allows subscription logins inside Claude Code and claude.ai. Instead, a small bridge lets the extension ask **Claude Code on your computer** (`claude -p`) to do the AI work, so it uses your plan's normal usage limits.

1. Install [Claude Code](https://claude.com/claude-code) and [Node.js](https://nodejs.org) if you don't have them. Run `claude` once in a terminal and log in.
2. In a terminal, `cd` into this folder (the one containing `extension/` and `bridge/`) and run:
   ```
   node bridge/install.js
   ```
   Or just ask Claude Code: *"run node bridge/install.js"*.
3. Restart your browser. In JobPilot → **Settings → Connect Claude**, choose **My Claude subscription** and click **Save & test**.

The installer copies the bridge to `~/.jobpilot/bridge` and registers it with Chrome, Brave, Edge, Arc and Chromium (on Windows, under the current user's registry). Only the JobPilot extension can talk to it. To remove it: `node bridge/install.js --uninstall`. If you install or move Claude Code later, re-run the installer.

**Option B: an Anthropic API key (pay-as-you-go)**

Choose **Anthropic API key** in Settings and paste a key from [console.anthropic.com → API Keys](https://console.anthropic.com/settings/keys) (add a few dollars of credit under Billing). Tailoring costs roughly 5–15¢ per job on Opus 5.5, about half that on Sonnet 5.5.

### 2. Upload your resume

**Resume → Upload your resume (PDF).** Check the parsed boxes.

### 3. Check your profile

**Settings → Application profile / Standard answers.** These are pre-filled from your resume; check work authorization, sponsorship and the other standard answers.

**Flexible graduation date (optional).** If you could graduate any time in a range (say Dec 2028 by credits, May 2030 on the normal track), set *Earliest* and *Latest* under **Settings → Application profile → Flexible graduation date**. For each job, JobPilot reads who the posting is for ("graduating between Dec 2028 and Jun 2029", "class of 2029", "first-year students", "rising juniors"…) and picks the date in your range that fits, closest to your usual one. That date goes on that job's tailored resume (shown as a *Graduation* change you can untick) and into that application's graduation and class-year answers. Postings that don't say keep your usual date.

**Cover letter (optional).** In **Resume → Cover letter**, write an opening, a "why this company" paragraph, a closing, and a few short experience paragraphs, all in your own words. For each job, tailoring picks the experience paragraphs that best match the posting and fills in `{Company}` and `{Role}`. If you put `{Hook}` in your why paragraph, Claude writes one sentence there about something specific in the posting, and may lightly reword your chosen paragraphs toward its terms. Those AI parts appear as *Cover letter* changes you can untick, and they're checked like resume rewrites (no new numbers, tools or skills). Autopilot leaves them out. The PDF uses your resume's header and fonts and is attached when a form has a cover letter field (Settings → Files & formatting).

### 4. Updates

JobPilot checks this repo for new commits every few hours and puts a **↑** badge on its icon when there's an update. Set it up in **Settings → Updates**:

- **Install automatically when the browser starts**, **Show a notice** (the default: an *Update now* button in the panel), or **Don't check**.
- **Repo / branch**: defaults to `v1m08/Internships` on `main`. If you fork JobPilot, point this at your fork.

One-click updates need a `git clone` and the Claude Code bridge installed from inside it (`node bridge/install.js`). The bridge runs `git pull --ff-only` in that folder, refreshes its own copy, and the extension reloads. Without the bridge, or with a ZIP download, JobPilot just tells you a newer version is out: run `git pull` (or re-download), then click reload on JobPilot in `chrome://extensions`.

Updates never touch your data. Your resume, profile and settings live in the browser, not in the repo folder.

## Autopilot (auto-apply)

**Jobs → Start Autopilot on the next N matching jobs.** It pulls jobs from every repo in **Settings → Job sources**, applies your **Filters**, and works through them in background tabs. By default it runs in a pinned JobPilot tab, so you can close the side panel; you get a notification when it's done.

For each job:

1. Opens the posting and clicks through to the application form.
2. On each page: fills what it can from your profile and saved answers (no AI), then one short Claude pass for fields that got stuck. Claude only *fills the form*: it picks the option that matches your profile (Degree "Bachelor's Degree"), chooses preference dropdowns, and fixes formats. It never writes answers.
3. Text questions are answered only with **your own words**: saved answers, or **Settings → Your answers**, a bank of answers to common questions you write once. Claude recognizes when a differently-worded question asks the same thing ("What excites you about joining X?" ↔ "Why do you want to work at {Company}?") and uses your answer as written.
4. Tailors your resume (and cover letter, if you wrote one) and attaches them.
5. Clicks **Next/Continue** through multi-page forms (up to 6 pages), then **Submit**. If the site rejects a field ("enter a valid phone number"), Claude fixes the fact or format once and resubmits.
6. Stops and leaves the tab for you when:
   - a question needs **your own words** and none of your answers fit (add one to *Your answers* and it's covered next time),
   - something is blocked (CAPTCHA, login, a missing required field),
   - or the site needs an account (Workday, iCIMS, Taleo, Amazon, Microsoft…): marked **Apply manually**.

Jobs that failed, needed you, or were marked not eligible have a **Try again** button (and **Try all again** for the whole list): it closes the old tab and runs them again right away, re-checking eligibility in case you changed your work status.

Settings → Autopilot: auto-submit on/off, jobs at once, a randomized pause between applications, running in its own tab, and background checks for new jobs.

## Speed and consistency

- AI is only used for rewording bullets, essay answers and preference dropdowns, in one call per job. Everything else (keywords, ordering, page fit, standard answers) is plain code and gives the same result every time.
- AI results are cached by input, so re-running the same job reuses the earlier answer instantly.
- AI rewrites are checked in code: a rewrite is rejected if it changes a number or adds a tool or skill that isn't on your resume.
- "Save for next time" on an AI answer reuses it for the same question on later applications, with no AI call.
- Default model is Sonnet, which is fast. Pick Opus in Settings for the best writing.

## Can you apply? (work authorization)

Set **Settings → Application profile → U.S. work status** (citizen, permanent resident, other authorization, student visa with CPT/OPT, or not authorized) and whether you hold a security clearance. JobPilot then marks every job:

- **✕ Can't apply**: something rules you out, e.g. U.S. citizenship or a clearance required, "must be authorized to work for any employer" (CPT/OPT doesn't count), "without sponsorship now or in the future", or no visa sponsorship when you need it.
- **? Check**: unclear or softer signals (e.g. the company usually doesn't sponsor H-1B).
- **✓ Can apply**: checked and nothing ruled you out.

Hover a badge to see why and the exact sentence. Where it looks:

- **Repo listings**: the 🛂 / 🇺🇸 flags and Simplify's sponsorship field (sparse: most listings say "Other").
- **Simplify's job pages**: for Simplify-sourced listings, JobPilot reads the page's data: H-1B sponsorship for the role and the company, and the posting's requirement sentences. Fetched a few at a time for the jobs you're looking at and cached for a week.
- **The posting itself**: on any job site, the Apply tab reads the page and shows the verdict under the job title.

**Jobs → Filters → Hide jobs I can't apply to** removes ✕ jobs from the list (on by default), and Autopilot checks each job again from its posting and skips it as *Not eligible* without filling anything. The keyword rules ignore equal-opportunity boilerplate ("without regard to … citizenship status") and handle negation ("we sponsor" vs "we do not sponsor").

## Daily flow

**Jobs** tab → click a job → **Apply** tab → **Tailor** → **Autofill this page** (click the site's *Apply* button first if the form is on another page) → **Draft answers** → review → Submit on the site → **Mark as applied**.

Colors on the page: **green** = filled, **amber** = needs you, **purple** = AI draft to review.

## What works where

| Site | Autofill | Resume attach |
|---|---|---|
| Greenhouse (classic and new boards, embedded iframes) | ✓ | ✓ |
| Lever | ✓ | ✓ |
| Ashby | ✓ | ✓ |
| Workday | Partial: one step at a time, so click Autofill on each page | Usually |
| Anything else | Best effort, label-based | Best effort |

Multi-page forms: click **Autofill this page** again on each step.

**When autofill gets stuck.** After filling what it can from your profile, JobPilot sends the leftover fields to one short Claude call. Options that match your profile (Degree "Bachelor's Degree" for "Bachelor of Science") are filled green. Choices your profile doesn't state (which term, which team) are filled purple for you to check. Anything that needs your own words, or a fact Claude doesn't have, is left empty and flagged amber. Searchable dropdowns built with react-select (new Greenhouse boards, Ashby and others) are filled through the component itself, so they work even while the side panel has focus.

## Privacy

Everything (resume, profile, API key, applied list) is stored in `chrome.storage.local` in your browser profile. Data only leaves your machine when you use an AI feature, and then it goes only to Anthropic, either through Claude Code on your computer or through the API.

## Development

```
extension/          the unpacked extension (no build step needed)
  sidepanel/        UI (vanilla JS modules)
  content/          autofill engine injected into job pages
  lib/              sources.js (GitHub repos), keywords.js + answers.js (deterministic),
                    tailor.js (per-job pipeline), autopilot.js, ai.js, latex.js, pdf.js,
                    update.js (self-update from GitHub)
  fonts/            CMU Serif (Computer Modern, SIL OFL) for the built-in renderer
  vendor/           bundled @anthropic-ai/sdk and jsPDF
bridge/             native messaging host that runs Claude Code (`claude -p`), compiles LaTeX, and pulls updates; plus its installer
```

Bump `version` in `extension/manifest.json` when you ship something, so people without the bridge get notified. People with the bridge see every new commit.

Nothing personal belongs in this repo: all user data stays in `chrome.storage.local`, and defaults live in `extension/lib/store.js`.
