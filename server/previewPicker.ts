// Preview's element picker (PM-311): a small script the preview proxies add to HTML pages. It is
// inert until the ProjectManager window that frames the page asks it to start; then hovering
// outlines an element (↑ and ↓ move to its parent and back, Enter picks it) and a click (or tap)
// reports that element's details to the app with postMessage. The picked element stays outlined,
// following the page as it scrolls, while the owner draws marks over it or picks another. It never
// runs in a nested frame, never touches the page's own handlers while idle, never changes the page
// beyond its own outline, and reports only what the page itself shows (the app treats it as
// untrusted data).

/** Where the own-origin proxy serves the script (a path no dev server uses). */
export const PICKER_PATH = '/__pm-picker.js';

export const PICKER_JS = String.raw`(() => {
  if (window.parent === window || window.parent !== window.top || window.__pmPicker) return;
  window.__pmPicker = true;
  var MAX_HTML = 2000, MAX_TEXT = 300;
  var box = null, label = null, current = null, active = false, trail = [];
  var picked = null, pickedBox = null;
  var STYLE_KEYS = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color',
    'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'border',
    'border-radius', 'gap', 'flex-direction', 'justify-content', 'align-items'];
  var ROLES = { a: 'link', button: 'button', h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading', img: 'img', input: 'textbox', textarea: 'textbox',
    select: 'combobox', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    ul: 'list', ol: 'list', li: 'listitem', table: 'table', form: 'form', dialog: 'dialog' };

  function send(message) { window.parent.postMessage(Object.assign({ pmPicker: true }, message), '*'); }
  function clip(text, max) { text = String(text || '').replace(/\s+/g, ' ').trim(); return text.length > max ? text.slice(0, max) + '…' : text; }

  function selectorOf(el) {
    var parts = [];
    for (var node = el; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      var tag = node.tagName.toLowerCase();
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift(tag + '#' + CSS.escape(node.id));
        break;
      }
      var part = tag;
      var classes = Array.prototype.slice.call(node.classList, 0, 2);
      if (classes.length) part += '.' + classes.map(function (c) { return CSS.escape(c); }).join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (tag === 'body') break;
    }
    return parts.join(' > ');
  }

  function nameOf(el) {
    var label = el.getAttribute('aria-label');
    if (label) return label;
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var text = by.split(/\s+/).map(function (id) { var t = document.getElementById(id); return t ? t.textContent : ''; }).join(' ');
      if (text.trim()) return text;
    }
    return el.getAttribute('alt') || el.getAttribute('title') || el.textContent || '';
  }

  function plain(value, depth) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return clip(value, 120);
    if (typeof value === 'function') return undefined;
    if (depth > 1) return undefined;
    if (Array.isArray(value)) return '[' + value.length + ' items]';
    if (typeof value === 'object') {
      if (value.$$typeof) return '<element>';
      var out = {}, n = 0;
      for (var key in value) {
        if (n >= 8) break;
        var v = plain(value[key], depth + 1);
        if (v !== undefined) { out[key] = v; n++; }
      }
      return out;
    }
    return undefined;
  }

  // React keeps its fibre on the DOM node in development builds: the nearest component, its props,
  // and the components around it.
  function reactOf(el) {
    var key = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });
    if (!key) return null;
    var names = [], props = null;
    for (var fiber = el[key]; fiber && names.length < 4; fiber = fiber.return) {
      var type = fiber.type;
      var name = type && typeof type !== 'string' ? (type.displayName || type.name || (type.render && (type.render.displayName || type.render.name))) : null;
      if (!name) continue;
      if (!props) {
        props = {};
        var n = 0;
        for (var k in fiber.memoizedProps || {}) {
          if (k === 'children' || n >= 12) continue;
          var v = plain(fiber.memoizedProps[k], 0);
          if (v !== undefined) { props[k] = v; n++; }
        }
      }
      names.push(name);
    }
    return names.length ? { component: names[0], props: props, owners: names.slice(1) } : null;
  }

  function scrollParent(el) {
    for (var node = el.parentElement; node; node = node.parentElement) {
      var s = getComputedStyle(node);
      if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
  }

  // The page as it looks right now, as static HTML (for the screenshot to show what was on screen,
  // not a fresh load): form values, canvases, scroll positions and script-added styles are written
  // into a copy; scripts and this picker's outlines are left out. Read-only: the live page is
  // untouched. Null when it would be too large to send.
  var MAX_SNAPSHOT = 8 * 1024 * 1024;
  function snapshot() {
    // Both lists start below <html> (document.querySelectorAll would include it), then pair up.
    var live = Array.prototype.slice.call(document.documentElement.querySelectorAll('*'));
    var copy = document.documentElement.cloneNode(true);
    var copies = Array.prototype.slice.call(copy.querySelectorAll('*'));
    copies.unshift(copy);
    live.unshift(document.documentElement);
    var drop = [];
    for (var i = 0; i < live.length && i < copies.length; i++) {
      var a = live[i], b = copies[i], tag = a.tagName;
      if (a.hasAttribute && a.hasAttribute('data-pm-picker')) { drop.push(b); continue; }
      if (tag === 'SCRIPT' || tag === 'NOSCRIPT') { drop.push(b); continue; }
      if (tag === 'INPUT') {
        if (a.type === 'checkbox' || a.type === 'radio') { if (a.checked) b.setAttribute('checked', ''); else b.removeAttribute('checked'); }
        else if (a.type !== 'password' && a.type !== 'file') b.setAttribute('value', a.value);
      } else if (tag === 'TEXTAREA') b.textContent = a.value;
      else if (tag === 'SELECT') {
        Array.prototype.forEach.call(b.options, function (o, k) { if (a.options[k] && a.options[k].selected) o.setAttribute('selected', ''); else o.removeAttribute('selected'); });
      } else if (tag === 'CANVAS') {
        try {
          var img = document.createElement('img');
          img.src = a.toDataURL();
          img.setAttribute('style', (a.getAttribute('style') || '') + ';width:' + a.clientWidth + 'px;height:' + a.clientHeight + 'px');
          img.className = a.className;
          b.replaceWith(img);
        } catch (err) { /* A tainted canvas stays blank. */ }
      } else if (tag === 'IFRAME') {
        b.removeAttribute('src');
        b.removeAttribute('srcdoc');
      }
      if (a.scrollTop || a.scrollLeft) b.setAttribute('data-pm-scroll', a.scrollTop + ',' + a.scrollLeft);
      if (tag === 'DETAILS' && a.open) b.setAttribute('open', '');
    }
    drop.forEach(function (n) { n.remove(); });
    // Styles a script added through the CSSOM (CSS-in-JS) are not in the markup: write them in.
    var head = copy.querySelector('head') || copy;
    var extra = '';
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      try {
        var owner = sheet.ownerNode;
        if (owner && owner.tagName === 'STYLE' && !owner.textContent.trim() && sheet.cssRules.length)
          extra += Array.prototype.map.call(sheet.cssRules, function (rule) { return rule.cssText; }).join('\n');
      } catch (err) { /* Another origin's sheet: it loads by its link anyway. */ }
    });
    (document.adoptedStyleSheets || []).forEach(function (sheet) {
      try { extra += Array.prototype.map.call(sheet.cssRules, function (rule) { return rule.cssText; }).join('\n'); } catch (err) {}
    });
    if (extra) {
      var style = document.createElement('style');
      style.textContent = extra;
      head.appendChild(style);
    }
    var base = document.createElement('base');
    base.href = location.href;
    head.insertBefore(base, head.firstChild);
    var html = '<!doctype html>' + copy.outerHTML;
    return html.length > MAX_SNAPSHOT ? null : html;
  }

  // Where the page is: what a screenshot needs to show the same view.
  function pageOf(el) {
    var inner = el ? scrollParent(el) : null;
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, dark: matchMedia('(prefers-color-scheme: dark)').matches },
      scroll: { x: scrollX, y: scrollY, inner: inner ? { selector: selectorOf(inner), top: inner.scrollTop, left: inner.scrollLeft } : null },
    };
  }

  function describe(el) {
    var rect = el.getBoundingClientRect();
    var computed = getComputedStyle(el);
    var styles = {};
    STYLE_KEYS.forEach(function (k) { styles[k] = computed.getPropertyValue(k); });
    var page = pageOf(el);
    return {
      url: page.url,
      title: page.title,
      tag: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      html: clip(el.outerHTML, MAX_HTML),
      text: clip(el.innerText || el.textContent, MAX_TEXT),
      role: el.getAttribute('role') || ROLES[el.tagName.toLowerCase()] || null,
      name: clip(nameOf(el), 160),
      focusable: el.tabIndex >= 0,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: page.viewport,
      scroll: page.scroll,
      styles: styles,
      react: reactOf(el),
    };
  }

  function place(target, el) {
    var r = el.getBoundingClientRect();
    target.style.transform = 'translate(' + r.x + 'px,' + r.y + 'px)';
    target.style.width = r.width + 'px';
    target.style.height = r.height + 'px';
    return r;
  }
  function show(el) {
    var r = place(box, el);
    var id = el.id ? '#' + el.id : el.classList.length ? '.' + el.classList[0] : '';
    var react = reactOf(el);
    label.textContent = (react ? '<' + react.component + '> ' : '') + el.tagName.toLowerCase() + id + '  ' + Math.round(r.width) + ' × ' + Math.round(r.height);
    label.style.transform = 'translate(' + Math.max(0, r.x) + 'px,' + Math.max(0, r.y - 22) + 'px)';
  }
  function ours(el) { return el && el.hasAttribute && el.hasAttribute('data-pm-picker'); }

  function onMove(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || ours(el) || el === current) return;
    current = el;
    trail = [];
    show(el);
  }
  function pick(el) {
    picked = el;
    if (!pickedBox) {
      pickedBox = document.createElement('div');
      pickedBox.setAttribute('data-pm-picker', '');
      pickedBox.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;outline:2px solid #4c8dff;outline-offset:2px;border-radius:2px';
      document.documentElement.append(pickedBox);
      addEventListener('scroll', follow, true);
      addEventListener('resize', follow);
    }
    place(pickedBox, el);
    send({ type: 'picked', element: describe(el) });
  }
  function follow() { if (picked && pickedBox) place(pickedBox, picked); }
  function clearPicked() {
    picked = null;
    if (pickedBox) pickedBox.remove();
    pickedBox = null;
    removeEventListener('scroll', follow, true);
    removeEventListener('resize', follow);
  }
  function onPick(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (ours(el)) el = current;
    if (el) pick(el);
  }
  // The keyboard alternative: ↑ widens to the parent, ↓ goes back, Enter picks.
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      send({ type: 'cancelled' });
    } else if (e.key === 'ArrowUp' && current && current.parentElement && current !== document.body) {
      e.preventDefault();
      trail.push(current);
      current = current.parentElement;
      show(current);
    } else if (e.key === 'ArrowDown' && trail.length) {
      e.preventDefault();
      current = trail.pop();
      show(current);
    } else if (e.key === 'Enter' && current) {
      e.preventDefault();
      pick(current);
    }
  }
  function swallow(e) { e.preventDefault(); e.stopPropagation(); }

  function start() {
    if (active) return;
    active = true;
    box = document.createElement('div');
    label = document.createElement('div');
    box.setAttribute('data-pm-picker', '');
    label.setAttribute('data-pm-picker', '');
    box.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;outline:2px solid #4c8dff;background:rgba(76,141,255,.15);border-radius:2px;transition:transform 60ms,width 60ms,height 60ms';
    label.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;padding:2px 6px;border-radius:4px;background:#1f2a44;color:#fff;font:12px/18px ui-monospace,Consolas,monospace;white-space:nowrap';
    document.documentElement.append(box, label);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('click', onPick, true);
    ['pointerdown', 'mousedown', 'mouseup', 'pointerup'].forEach(function (t) { document.addEventListener(t, swallow, { capture: true, passive: false }); });
    document.addEventListener('keydown', onKey, true);
    document.documentElement.style.cursor = 'crosshair';
  }
  function stop() {
    if (!active) return;
    active = false;
    current = null;
    trail = [];
    if (box) box.remove();
    if (label) label.remove();
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('click', onPick, true);
    ['pointerdown', 'mousedown', 'mouseup', 'pointerup'].forEach(function (t) { document.removeEventListener(t, swallow, { capture: true }); });
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.style.cursor = '';
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data || e.data.pmPicker !== true) return;
    if (e.data.type === 'start') start();
    else if (e.data.type === 'pause') stop();
    else if (e.data.type === 'stop') { stop(); clearPicked(); }
    else if (e.data.type === 'clear') clearPicked();
    else if (e.data.type === 'state') {
      var html = null, why = null;
      try { html = snapshot(); if (!html) why = 'too large'; } catch (err) { why = String(err && err.message || err).slice(0, 200); }
      send({ type: 'state', page: pageOf(picked), snapshot: html, snapshotError: why });
    }
  });
  send({ type: 'ready' });
})();`;

/** Adds the picker right after `<head>` (streamed pages paint without waiting for `</body>`). */
export function injectPicker(html: string, tag: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
    );
  const doc = /<html(\s[^>]*)?>/i.exec(html);
  if (doc)
    return html.slice(0, doc.index + doc[0].length) + tag + html.slice(doc.index + doc[0].length);
  return tag + html;
}

/** The inline form, for the path mode (whose responses carry no page CSP). */
export const PICKER_INLINE = `<script data-pm-picker>${PICKER_JS}</script>`;
/** The external form, for the own-origin mode (allowed by a page CSP's 'self'). */
export const PICKER_EXTERNAL = `<script src="${PICKER_PATH}" data-pm-picker></script>`;

/** The external form carrying a CSP nonce, for pages whose policy runs nonce'd scripts only. */
export const pickerTag = (nonce: string | null) =>
  nonce && /^[A-Za-z0-9+/=_-]{8,200}$/.test(nonce)
    ? `<script src="${PICKER_PATH}" nonce="${nonce}" data-pm-picker></script>`
    : PICKER_EXTERNAL;

/**
 * Lets the picker run under a page's Content Security Policy (PM-311). A policy with
 * 'strict-dynamic' ignores 'self', so only scripts with its nonce run (Next.js apps set one):
 * the picker reuses the page's own nonce when the policy has one, or else gets a nonce of its own
 * added to script-src. Returns the policy to send and the nonce for the tag (null: none needed).
 */
export function pickerCsp(
  csp: string,
  freshNonce: () => string,
): { csp: string; nonce: string | null } {
  const parts = csp
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const scriptIndex = parts.findIndex((part) => /^script-src(\s|$)/i.test(part));
  const defaultIndex = parts.findIndex((part) => /^default-src(\s|$)/i.test(part));
  const governing =
    scriptIndex >= 0 ? parts[scriptIndex]! : defaultIndex >= 0 ? parts[defaultIndex]! : '';
  if (!/'strict-dynamic'/i.test(governing)) return { csp, nonce: null };
  const pageNonce = /'nonce-([^']+)'/i.exec(governing)?.[1] ?? null;
  if (pageNonce) return { csp, nonce: pageNonce };
  const nonce = freshNonce();
  if (scriptIndex >= 0) parts[scriptIndex] = `${parts[scriptIndex]} 'nonce-${nonce}'`;
  else parts.push(`script-src ${governing.replace(/^default-src/i, '').trim()} 'nonce-${nonce}'`);
  return { csp: parts.join('; '), nonce };
}
