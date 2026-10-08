/* Prototype viewer: hash router (#/screen-id@State), area tabs, screen index,
   device frames (phone 390 / tablet 834 / desktop 1280 / fit), theme toggle. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DEVICES = { phone: { w: 390, label: 'Phone', icon: 'smartphone' }, tablet: { w: 834, label: 'Tablet', icon: 'tablet' }, desktop: { w: 1280, label: 'Desktop', icon: 'monitor' }, fit: { w: 0, label: 'Fit', icon: 'maximize-2' } };
  const store = { get(k, d) { try { return localStorage.getItem('mk-proto-' + k) || d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('mk-proto-' + k, v); } catch (e) { /* storage unavailable */ } } };
  const narrow = () => window.matchMedia('(max-width: 900px)').matches;
  let device = store.get('device', narrow() ? 'fit' : 'desktop');
  let current = { id: 'theme/foundations', state: null };
  let filter = '';

  const order = () => Object.entries(UI.CATALOGUE).flatMap(([area, groups]) => groups.flatMap(([g, ids]) => ids.map((id) => ({ id, area, group: g }))));
  const titleOf = (id) => (UI.screens[id] && UI.screens[id].title) || id;

  function parseHash() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    if (!h) return { id: 'theme/foundations', state: null };
    const [id, state] = h.split('@');
    return { id, state: state || null };
  }

  function renderTop() {
    $('shBrand').innerHTML = `${UI.LOGO_SVG}<span>${UI.BRAND}</span><small>UI prototype</small>`;
    const area = UI.areaOf(current.id);
    const counts = {}; order().forEach((s) => { counts[s.area] = (counts[s.area] || 0) + 1; });
    $('shAreas').innerHTML = UI.AREAS.map((a) => { const first = UI.CATALOGUE[a.id][0][1][0]; return `<a href="${UI.go(first)}" class="${area === a.id ? 'is-active' : ''}">${UI.icon(a.icon)}${a.name}<span class="c">${counts[a.id]}</span></a>`; }).join('');
    $('shDevices').innerHTML = Object.entries(DEVICES).map(([k, d]) => `<button type="button" data-dev="${k}" class="${device === k ? 'is-active' : ''}" aria-pressed="${device === k}" title="${d.label}${d.w ? ' · ' + d.w + ' px' : ''}">${UI.icon(d.icon)}<span>${d.label}</span></button>`).join('');
    const dark = isDark();
    $('shTheme').innerHTML = UI.icon(dark ? 'sun' : 'moon');
  }

  function renderNav() {
    const area = UI.areaOf(current.id);
    const groups = UI.CATALOGUE[area];
    const f = filter.toLowerCase();
    $('shNav').innerHTML = `<label class="find" for="shFind">${UI.icon('search')}<input id="shFind" type="search" placeholder="Find a screen" value="${UI.esc(filter)}"></label>` +
      groups.map(([g, ids]) => {
        const items = ids.filter((id) => !f || titleOf(id).toLowerCase().includes(f) || id.includes(f));
        if (!items.length) return '';
        return `<h3>${g}</h3>` + items.map((id) => `<a href="${UI.go(id)}" class="${id === current.id ? 'is-active' : ''}${UI.screens[id] ? '' : ' is-missing'}"${id === current.id ? ' aria-current="page"' : ''}><span>${UI.esc(titleOf(id))}</span></a>`).join('');
      }).join('');
    const inp = $('shFind');
    inp.addEventListener('input', (e) => { filter = e.target.value; const pos = e.target.selectionStart; renderNav(); const n = $('shFind'); n.focus(); n.setSelectionRange(pos, pos); lucideRun(); });
  }

  function renderMeta() {
    const s = UI.screens[current.id];
    const all = order();
    const idx = all.findIndex((x) => x.id === current.id);
    const meta = all[idx] || { group: '', area: UI.areaOf(current.id) };
    const areaName = (UI.AREAS.find((a) => a.id === meta.area) || {}).name || '';
    const prev = all[idx - 1], next = all[idx + 1];
    const states = (s && s.states) || [];
    const st = current.state || states[0];
    const areaIds = all.filter((x) => x.area === meta.area);
    $('shMeta').innerHTML = `
      <div class="ttl">
        <span class="path">${areaName} ${UI.icon('chevron-right')} ${meta.group} ${s && s.ref ? `<span class="ref">${UI.esc(s.ref)}</span>` : ''}</span>
        <h1>${UI.esc(titleOf(current.id))}</h1>
        ${s && s.notes ? `<p>${s.notes}</p>` : ''}
        <div class="sh-select-wrap"><label class="sr-only" for="shPick">Screen</label><select id="shPick">${areaIds.map((x) => `<option value="${x.id}"${x.id === current.id ? ' selected' : ''}>${UI.esc(x.group)} · ${UI.esc(titleOf(x.id))}</option>`).join('')}</select></div>
      </div>
      <div class="ctl">
        ${states.length > 1 ? `<div class="seg" role="group" aria-label="Screen state">${states.map((x) => `<a href="${UI.go(current.id, x)}" class="${x === st ? 'is-active' : ''}">${UI.esc(x)}</a>`).join('')}</div>` : ''}
        <a class="sh-iconbtn" href="${prev ? UI.go(prev.id) : '#'}" aria-label="Previous screen"${prev ? '' : ' aria-disabled="true"'}>${UI.icon('arrow-left')}</a>
        <a class="sh-iconbtn" href="${next ? UI.go(next.id) : '#'}" aria-label="Next screen"${next ? '' : ' aria-disabled="true"'}>${UI.icon('arrow-right')}</a>
      </div>`;
    const pick = $('shPick');
    if (pick) pick.addEventListener('change', (e) => { location.hash = UI.go(e.target.value); });
  }

  function renderFrame() {
    const s = UI.screens[current.id];
    const frame = $('frame');
    let html;
    if (!s) {
      html = `<div class="sh-missing">${UI.icon('construction', 'ic-2xl')}<h2 class="h2">Not designed yet</h2><p class="muted">${UI.esc(current.id)}</p></div>`;
    } else {
      try { html = s.render(current.state || (s.states && s.states[0]) || null); } catch (err) { console.error('[screen]', current.id, err); html = `<div class="sh-missing"><h2 class="h2">Render error</h2><pre class="mono small">${UI.esc(err.stack || err)}</pre></div>`; }
    }
    frame.innerHTML = html;
    frame.classList.toggle('locked', /class="overlay/.test(html));
    frame.scrollTop = 0;
    // Bring the active item of horizontal nav bars (phone section chips, tabs) into view.
    frame.querySelectorAll('.bo-mnav a.is-active, .tabs .is-active').forEach((a) => { a.parentElement.scrollLeft = Math.max(0, a.offsetLeft - 16); });
    document.title = `${titleOf(current.id)} · ${UI.BRAND} UI Prototype`;
  }

  function lucideRun() {
    if (!window.lucide) return;
    window.lucide.createIcons({ icons: window.lucide.icons, attrs: {} });
    const left = document.querySelectorAll('i[data-lucide]');
    if (left.length) console.warn('[icons] unknown lucide names:', [...new Set([...left].map((n) => n.getAttribute('data-lucide')))].join(', '));
  }

  function layout() {
    const vp = $('shViewport');
    const frame = $('frame');
    const box = $('shBox');
    const cs = getComputedStyle(vp);
    const availW = vp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = vp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const d = DEVICES[device] || DEVICES.desktop;
    const w = d.w || availW;
    const scale = Math.min(1, availW / w);
    const h = availH / scale;
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    frame.style.transform = scale < 1 ? `scale(${scale})` : 'none';
    frame.style.setProperty('--frame-h', (h - 12) + 'px');
    frame.className = 'app sh-frame ' + (d.w && d.w < 1000 ? (d.w < 500 ? 'phone' : 'tablet') : '') + (frame.classList.contains('locked') ? ' locked' : '');
    box.style.width = w * scale + 'px';
    box.style.height = availH + 'px';
  }

  function isDark() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function route() {
    current = parseHash();
    if (!UI.CATALOGUE[UI.areaOf(current.id)]) current = { id: 'theme/foundations', state: null };
    renderTop(); renderNav(); renderMeta(); renderFrame(); layout(); lucideRun();
    const active = document.querySelector('.sh-nav a.is-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  document.addEventListener('click', (e) => {
    const dev = e.target.closest('[data-dev]');
    if (dev) { device = dev.dataset.dev; store.set('device', device); renderTop(); layout(); lucideRun(); return; }
    if (e.target.closest('#shTheme')) {
      document.documentElement.setAttribute('data-theme', isDark() ? 'light' : 'dark');
      renderTop(); lucideRun(); return;
    }
    // Inert links inside screens (javascript:void 0) shouldn't jump.
    const a = e.target.closest('#frame a[href="#"]');
    if (a) e.preventDefault();
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', layout);
  route();
})();
