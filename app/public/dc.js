/*
 * Minimal runtime for the LedgerLens page outside claude.ai.
 * Renders the same markup (markup.html: {{holes}}, <sc-if>, <sc-for>) with the same engine (engine.js),
 * patching the DOM in place so inputs keep focus while you type.
 */
(function () {
  const BOOL = { checked: 1, disabled: 1, selected: 1, readonly: 1, multiple: 1 };
  const SVG = 'http://www.w3.org/2000/svg';
  const look = (p, sc) => { const ks = p.trim().split('.'); let v = sc[ks[0]]; for (let i = 1; i < ks.length; i++) { if (v == null) return undefined; v = v[ks[i]]; } return v; };
  const whole = (s) => { const m = /^\{\{([^}]+)\}\}$/.exec(s.trim()); return m ? m[1] : null; };
  const sub = (s, sc) => s.replace(/\{\{([^}]+)\}\}/g, (_, p) => { const v = look(p, sc); return v == null ? '' : String(v); });
  const textLike = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|file)$/i.test(el.type || ''));

  function build(n, sc, out, ns) {
    if (n.nodeType === 3) { out.push(document.createTextNode(sub(n.nodeValue, sc))); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase();
    if (tag === 'template') {
      const kind = n.getAttribute('data-sc'); const kids = n.content.childNodes;
      if (kind === 'if') { const p = whole(n.getAttribute('value') || ''); if (p && look(p, sc)) kids.forEach((c) => build(c, sc, out, ns)); return; }
      if (kind === 'for') { const p = whole(n.getAttribute('list') || ''); const as = n.getAttribute('as'); (look(p, sc) || []).forEach((it) => { const s2 = Object.assign({}, sc); s2[as] = it; kids.forEach((c) => build(c, s2, out, ns)); }); return; }
      return;
    }
    if (tag === 'helmet' || tag === 'script') return;
    const isSvg = ns || tag === 'svg';
    const el = isSvg ? document.createElementNS(SVG, n.tagName === 'svg' ? 'svg' : n.localName) : document.createElement(tag);
    el.__h = {}; el.__p = {};
    for (const a of Array.from(n.attributes)) {
      if (/^hint-/.test(a.name)) continue;
      const p = whole(a.value);
      if (/^on/i.test(a.name)) { const f = p ? look(p, sc) : null; if (typeof f === 'function') el.__h[a.name.slice(2).toLowerCase()] = f; continue; }
      if (BOOL[a.name] && p) { const v = look(p, sc); el.__p[a.name] = !!v && v !== 'false'; if (el.__p[a.name]) el.setAttribute(a.name, ''); continue; }
      if (a.name === 'value' && p && !isSvg) { const v = look(p, sc); el.__p.value = v == null ? '' : String(v); el.setAttribute('value', el.__p.value); continue; }
      try { el.setAttribute(a.name, sub(a.value, sc)); } catch (e) {}
    }
    const kids = []; n.childNodes.forEach((c) => build(c, sc, kids, isSvg && tag !== 'foreignobject'));
    kids.forEach((k) => el.appendChild(k));
    applyProps(el);
    out.push(el);
  }
  function applyProps(el) {
    const p = el.__p || {};
    if ('value' in p && el.value !== p.value) { if (el.tagName === 'SELECT') el.value = p.value; else if (!(document.activeElement === el && el.type === 'range')) el.value = p.value; }
    ['checked', 'disabled', 'selected', 'readonly'].forEach((k) => { if (k in p) { const prop = k === 'readonly' ? 'readOnly' : k; if (el[prop] !== p[k]) el[prop] = p[k]; } });
  }
  // patch `old` children to match `fresh` list, keeping nodes where tag matches (so focus/scroll survive)
  function patchChildren(parent, fresh) {
    const old = Array.from(parent.childNodes);
    fresh.forEach((f, i) => {
      const o = old[i];
      if (!o) { parent.appendChild(f); return; }
      if (o.nodeType === 3 && f.nodeType === 3) { if (o.nodeValue !== f.nodeValue) o.nodeValue = f.nodeValue; return; }
      if (o.nodeType === 1 && f.nodeType === 1 && o.tagName === f.tagName && o.namespaceURI === f.namespaceURI && (o.tagName !== 'INPUT' || o.type === f.type)) {
        for (const a of Array.from(o.attributes)) if (!f.hasAttribute(a.name)) o.removeAttribute(a.name);
        for (const a of Array.from(f.attributes)) if (o.getAttribute(a.name) !== a.value && !(a.name === 'value' && textLike(o) && document.activeElement === o)) o.setAttribute(a.name, a.value);
        o.__h = f.__h; o.__p = f.__p;
        patchChildren(o, Array.from(f.childNodes));
        applyProps(o);
        return;
      }
      parent.replaceChild(f, o);
    });
    for (let i = fresh.length; i < old.length; i++) parent.removeChild(old[i]);
  }

  let TPL = null, C = null, root = null, queued = false;
  function draw() {
    queued = false;
    const vals = C.renderVals(); const out = [];
    TPL.forEach((c) => build(c, vals, out, false));
    patchChildren(root, out);
  }
  function schedule() { if (!queued) { queued = true; (window.requestAnimationFrame || setTimeout)(draw); } }

  class DCLogic {
    constructor(props) { this.props = props || {}; }
    setState(s, cb) { Object.assign(this.state, typeof s === 'function' ? s(this.state) : s); schedule(); if (cb) setTimeout(cb, 0); }
  }

  function dispatch(type, e) {
    let el = e.target;
    while (el && el !== root) {
      const h = el.__h;
      if (h) {
        if (type === 'input' && h.change && textLike(el)) { h.change(e); return; }
        if (type === 'change' && h.change && !textLike(el)) { h.change(e); return; }
        if (type === 'click' && h.click) { h.click(e); return; }
        if (type === 'keydown' && h.keydown) { h.keydown(e); return; }
        if (type === 'submit' && h.submit) { e.preventDefault(); h.submit(e); return; }
      }
      el = el.parentNode;
    }
  }

  async function loadScript(src) { await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('could not load ' + src)); document.head.appendChild(s); }); }

  async function boot() {
    root = document.getElementById('app');
    const txt = await (await fetch('/markup.html')).text();
    const prepared = txt
      .replace(/<sc-if\b/g, '<template data-sc="if"').replace(/<\/sc-if>/g, '</template>')
      .replace(/<sc-for\b/g, '<template data-sc="for"').replace(/<\/sc-for>/g, '</template>');
    const d = new DOMParser().parseFromString(prepared, 'text/html');
    d.querySelectorAll('helmet style, helmet link').forEach((n) => document.head.appendChild(document.importNode(n, true)));
    const t = d.querySelector('title'); if (t) document.title = t.textContent;
    for (const s of Array.from(d.head.querySelectorAll('script[src]'))) { const src = s.getAttribute('src'); if (/^\/_blob\//.test(src)) await loadScript(src); }
    TPL = Array.from(d.querySelector('x-dc').childNodes);
    const src = await (await fetch('/engine.js')).text();
    const Component = new Function('DCLogic', src + '\nreturn Component;')(DCLogic);
    C = new Component({}); window.LL = C;
    ['click', 'input', 'change', 'keydown', 'submit'].forEach((ty) => root.addEventListener(ty, (e) => dispatch(ty, e)));
    draw();
    if (C.componentDidMount) C.componentDidMount();
    window.__ready = true;
  }
  boot().catch((e) => { document.body.innerHTML = '<pre style="padding:24px;color:#B42318">LedgerLens failed to start: ' + (e && e.message) + '</pre>'; });
})();
