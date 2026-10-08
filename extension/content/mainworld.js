// Runs in the page's own JavaScript world (content/autofill.js runs in an
// isolated one and can't see React's internals). Lets the autofill engine
// read and set react-select dropdowns (new Greenhouse boards, Ashby, many
// others) through the component's own props instead of simulated clicks,
// which don't open these menus when the page isn't focused.
//
// Protocol: autofill.js tags the input with data-jobpilot-token and fires
// "jobpilot:react" on document with a JSON detail; we answer with
// "jobpilot:react:result".
(() => {
  if (window.__jobpilotMain) return;
  window.__jobpilotMain = true;

  const fiberOf = (n) => {
    const k = Object.keys(n).find((x) => x.startsWith("__reactFiber"));
    return k ? n[k] : null;
  };
  // Props of every React component from the input up to the form.
  function propsChain(el) {
    const out = [];
    for (let f = fiberOf(el), i = 0; f && i < 40; f = f.return, i++) if (f.memoizedProps) out.push(f.memoizedProps);
    return out;
  }
  const labelOf = (o) => String(o?.label ?? o?.name ?? o?.value ?? "");
  const flatten = (opts) => (opts || []).flatMap((o) => (Array.isArray(o?.options) ? o.options : [o]));

  function parts(el) {
    const chain = propsChain(el);
    const inner = chain.find((p) => typeof p.selectOption === "function" && "options" in p);
    const loader = chain.find((p) => typeof p.loadOptions === "function");
    return { inner, loader };
  }

  function search(loader, query) {
    return Promise.race([
      new Promise((ok) => {
        try {
          const ret = loader.loadOptions(query, ok);
          if (ret && ret.then) ret.then(ok, () => ok([]));
        } catch {
          ok([]);
        }
      }),
      new Promise((ok) => setTimeout(() => ok([]), 8000)),
    ]).then((r) => flatten(Array.isArray(r) ? r : r?.options || []));
  }

  async function run(d) {
    const el = document.querySelector(`[data-jobpilot-token="${CSS.escape(d.token)}"]`);
    if (!el) return { ok: false };
    const { inner, loader } = parts(el);
    if (!inner) return { ok: false };
    const multi = !!inner.isMulti;
    let options = flatten(inner.options);
    if (d.op === "options") return { ok: true, labels: options.map(labelOf), async: !!loader, multi };
    if (d.op === "search") {
      if (loader) options = await search(loader, d.query || "");
      return { ok: true, labels: options.map(labelOf), async: !!loader, multi };
    }
    if (d.op === "select") {
      if (loader && d.query) options = await search(loader, d.query);
      const want = d.labels || [d.label];
      const picks = want.map((l) => options.find((o) => labelOf(o) === l)).filter(Boolean);
      if (!picks.length) return { ok: false };
      for (const p of picks) inner.selectOption(p);
      return { ok: true, selected: picks.map(labelOf) };
    }
    return { ok: false };
  }

  document.addEventListener("jobpilot:react", (e) => {
    let d;
    try {
      d = JSON.parse(e.detail);
    } catch {
      return;
    }
    run(d)
      .catch(() => ({ ok: false }))
      .then((r) => document.dispatchEvent(new CustomEvent("jobpilot:react:result", { detail: JSON.stringify({ id: d.id, ...r }) })));
  });
})();
