// Preview's element picker (PM-311): a small script the preview proxies add to HTML pages. It is
// inert until the ProjectManager window that frames the page asks it to start; then hovering
// outlines an element and a click (or tap) reports that element's details to the app with
// postMessage, and picking stops. It never runs in a nested frame, never touches the page's own
// handlers while idle, and reports only what the page itself shows (the app treats it as
// untrusted data).

/** Where the own-origin proxy serves the script (a path no dev server uses). */
export const PICKER_PATH = '/__pm-picker.js';

export const PICKER_JS = String.raw`(() => {
  if (window.parent === window || window.parent !== window.top || window.__pmPicker) return;
  window.__pmPicker = true;
  var MAX_HTML = 2000, MAX_TEXT = 300;
  var box = null, label = null, current = null, active = false;
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

  function describe(el) {
    var rect = el.getBoundingClientRect();
    var computed = getComputedStyle(el);
    var styles = {};
    STYLE_KEYS.forEach(function (k) { styles[k] = computed.getPropertyValue(k); });
    var inner = scrollParent(el);
    return {
      url: location.href,
      title: document.title,
      tag: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      html: clip(el.outerHTML, MAX_HTML),
      text: clip(el.innerText || el.textContent, MAX_TEXT),
      role: el.getAttribute('role') || ROLES[el.tagName.toLowerCase()] || null,
      name: clip(nameOf(el), 160),
      focusable: el.tabIndex >= 0,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      scroll: { x: scrollX, y: scrollY, inner: inner ? { selector: selectorOf(inner), top: inner.scrollTop, left: inner.scrollLeft } : null },
      styles: styles,
      react: reactOf(el),
    };
  }

  function show(el) {
    var r = el.getBoundingClientRect();
    box.style.transform = 'translate(' + r.x + 'px,' + r.y + 'px)';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    var id = el.id ? '#' + el.id : el.classList.length ? '.' + el.classList[0] : '';
    label.textContent = el.tagName.toLowerCase() + id + '  ' + Math.round(r.width) + ' × ' + Math.round(r.height);
    label.style.transform = 'translate(' + Math.max(0, r.x) + 'px,' + Math.max(0, r.y - 22) + 'px)';
  }

  function onMove(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === label || el === current) return;
    current = el;
    show(el);
  }
  function onPick(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = document.elementFromPoint(e.clientX, e.clientY) || current;
    if (!el) return;
    var data = describe(el);
    stop();
    send({ type: 'picked', element: data });
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    stop();
    send({ type: 'cancelled' });
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
    else if (e.data.type === 'stop') stop();
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
