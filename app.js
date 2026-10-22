// Google-TV-style home for webOS. Works with remote arrow keys AND the Magic Remote pointer.
(function () {
  var C = window.CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var IMG = 'https://image.tmdb.org/t/p/';
  var onTV = typeof window.PalmServiceBridge === 'function';

  // Set by profiles.js (loaded before this file): {prefix, name, color, extraQ, hideApps}.
  var P = window.TV_PROFILE || {};
  function store(k, v) { // per-profile localStorage; store(k) reads JSON, store(k, v) writes
    try {
      if (arguments.length > 1) localStorage[(P.prefix || '') + k] = JSON.stringify(v);
      else return JSON.parse(localStorage[(P.prefix || '') + k] || 'null');
    } catch (e) { return null; }
  }

  // ---------- settings (saved on the TV in localStorage) ----------
  var LANGS = [['hi', 'Hindi'], ['en', 'English'], ['ta', 'Tamil'], ['te', 'Telugu'], ['ml', 'Malayalam'], ['kn', 'Kannada'],
    ['bn', 'Bengali'], ['mr', 'Marathi'], ['pa', 'Punjabi'], ['gu', 'Gujarati'], ['ko', 'Korean'], ['ja', 'Japanese'], ['es', 'Spanish'], ['fr', 'French']];
  var COUNTRIES = [['IN', 'India'], ['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'], ['AU', 'Australia'], ['AE', 'UAE'],
    ['SG', 'Singapore'], ['DE', 'Germany'], ['FR', 'France'], ['JP', 'Japan'], ['KR', 'South Korea'], ['BR', 'Brazil']];
  var S = {region: C.REGION, langs: [], services: C.SERVICES.filter(function (x) { return x.on; }).map(function (x) { return x.name; }),
    youtube: true, autoplay: true, clock24: false};
  Object.assign(S, store('settings') || {});
  C.REGION = S.region;
  var SERVICES = C.SERVICES.filter(function (x) { return S.services.indexOf(x.name) >= 0; });
  function pickLabel() {
    return S.langs.length ? 'Popular in ' + LANGS.filter(function (l) { return S.langs.indexOf(l[0]) >= 0; }).map(function (l) { return l[1]; }).join(', ') : 'Trending today';
  }
  function langQ() { return (S.langs.length ? '&with_original_language=' + S.langs.join('%7C') : '') + (P.extraQ || ''); }

  // ---------- webOS luna bridge ----------
  function luna(uri, params) {
    return new Promise(function (ok, fail) {
      if (!onTV) return fail({errorText: 'not on webOS'});
      var b = new window.PalmServiceBridge(), done = false;
      b.onservicecallback = function (m) { done = true; var d = JSON.parse(m); d.returnValue === false ? fail(d) : ok(d); };
      b.call('luna://' + uri, JSON.stringify(params || {}));
      setTimeout(function () { if (!done) fail({errorText: 'timeout'}); }, 5000);
    });
  }
  function launch(id, params) {
    if (!onTV) return toast('Would open ' + id);
    luna('com.webos.applicationManager/launch', {id: id, params: params || {}})
      .catch(function (e) { toast('Could not open ' + id + ': ' + (e.errorText || e)); });
  }

  // ---------- apps: the TV denies listLaunchPoints to non-system apps, so probe our list ----------
  var apps = [];
  // Root helpers in the TV Home service (service/service.js), reached over the TV's loopback.
  function svc(name, params) {
    return fetch('http://127.0.0.1:45620/' + name, {method: 'POST', body: JSON.stringify(params || {})})
      .then(function (r) { return r.json(); });
  }
  // Icons are cached by app id and never refreshed, so the key carries a version: bump it whenever the icon the service picks
  // changes (e.g. a bigger size), or users keep the old copies for good. The unversioned key of earlier releases is deleted on load.
  var ICON_CACHE = 'appIcons.v2';
  function loadApps() {
    if (!onTV) { apps = C.APPS.slice(); return Promise.resolve(); }
    // Real installed apps and icons when the service is running (rooted TV); otherwise probe config.js's list.
    return svc('getApps').then(function (r) {
      if (!r.apps || !r.apps.length) throw new Error('no apps');
      var icons = {};
      try { icons = JSON.parse(localStorage.getItem(ICON_CACHE) || '{}'); localStorage.removeItem('appIcons'); } catch (e) { /* storage unavailable */ }
      apps = r.apps;
      return Promise.all(apps.map(function (a) {
        if (icons[a.id]) { a.img = icons[a.id]; return null; }
        return svc('getIcon', {id: a.id}).then(function (i) { if (i.icon) a.img = icons[a.id] = i.icon; }, function () {});
      })).then(function () { try { localStorage.setItem(ICON_CACHE, JSON.stringify(icons)); } catch (e) { /* too big or blocked */ } });
    }).catch(probeApps);
  }
  function probeApps() {
    return Promise.all(C.APPS.map(function (a) {
      return luna('com.webos.applicationManager/getAppLoadStatus', {appId: a.id})
        .then(function (r) { return r.exist ? a : null; }, function () { return a; });
    })).then(function (list) { apps = list.filter(Boolean); });
  }
  // Apps row order and removed apps are per profile (store); profile.js's hideApps also applies.
  function visibleApps() {
    var hidden = (P.hideApps || []).concat(store('appHidden') || []), order = store('appOrder') || [];
    var rank = function (a) { var i = order.indexOf(a.id); return i < 0 ? 1e4 + apps.indexOf(a) : i; };
    return apps.filter(function (a) { return hidden.indexOf(a.id) < 0; }).sort(function (a, b) { return rank(a) - rank(b); });
  }
  function svcFor(name) {
    name = name.toLowerCase();
    return C.SERVICES.filter(function (s) { return name.indexOf(s.match) >= 0; })[0];
  }

  // ---------- data ----------
  function get(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function tmdb(path, q) { return get('https://api.themoviedb.org/3/' + path + '?api_key=' + C.TMDB_KEY + '&language=' + C.LANG + (q || '')); }
  function fromTmdb(m, svc) {
    var type = m.media_type || (m.title ? 'movie' : 'tv'), date = m.release_date || m.first_air_date || '', pic = m.backdrop_path || m.poster_path; // poster when there's no backdrop
    return {
      title: m.title || m.name, sub: m.overview,
      meta: [date.slice(0, 4), type === 'movie' ? 'Movie' : 'Series', m.vote_average ? '★ ' + m.vote_average.toFixed(1) : ''].filter(Boolean).join('  ·  '),
      img: IMG + 'w500' + pic, bg: IMG + 'w1280' + pic, blur: IMG + 'w300' + pic,
      src: svc ? svc.name : pickLabel(), svc: svc, tmdb: {type: type, id: m.id}
    };
  }
  function mix(a, b) { var out = []; for (var i = 0; i < 20; i++) [a[i], b[i]].forEach(function (m) { if (m && m.backdrop_path) out.push(m); }); return out; }
  function trending() {
    if (S.langs.length || P.extraQ) { // trending has no language/certification filter, so use popular-and-streamable in the chosen languages
      var q = '&watch_region=' + C.REGION + '&with_watch_monetization_types=flatrate%7Cfree%7Cads&sort_by=popularity.desc&vote_count.gte=5' + langQ();
      return Promise.all([tmdb('discover/movie', q), tmdb('discover/tv', q)])
        .then(function (rs) { return mix(rs[0].results, rs[1].results).map(function (m) { return fromTmdb(m); }); });
    }
    return tmdb('trending/all/day').then(function (r) {
      return r.results.filter(function (m) { return m.backdrop_path && m.media_type !== 'person'; }).map(function (m) { return fromTmdb(m); });
    });
  }
  function serviceRow(svc, providers) {
    var name = function (x) { return x.provider_name.toLowerCase(); };
    var p = providers.filter(function (x) { return name(x) === svc.match; })[0] ||
      providers.filter(function (x) { return name(x).indexOf(svc.match) >= 0; })[0];
    if (!p) return Promise.resolve(null);
    var q = '&watch_region=' + C.REGION + '&with_watch_providers=' + p.provider_id + '&sort_by=popularity.desc' + langQ();
    return Promise.all([tmdb('discover/tv', q), tmdb('discover/movie', q)]).then(function (rs) {
      return {title: 'Popular on ' + svc.name, items: mix(rs[0].results, rs[1].results).map(function (m) { return fromTmdb(m, svc); })};
    });
  }
  // JustWatch "popular now" on your services (rooted TV: fetched by the service). Each title already says
  // which of your services has it, so its card opens the right app straight away.
  function jwPicks() {
    var codes = SERVICES.map(function (s) { return s.jw; }).filter(Boolean);
    if (!codes.length) return Promise.resolve([]);
    return svc('jwPopular', {packages: codes, first: 40}).then(function (r) {
      return (r.items || []).map(function (m) {
        var svc = SERVICES.filter(function (s) { return m.packages.indexOf(s.jw) >= 0; })[0];
        return {title: m.title, sub: m.sub, img: m.img, bg: m.bg, blur: m.blur || m.img,
          meta: [m.year, m.type === 'movie' ? 'Movie' : 'Series', m.score ? 'IMDb ' + m.score.toFixed(1) : ''].filter(Boolean).join('  ·  '),
          src: svc ? 'Popular on ' + svc.name : 'Popular now', svc: svc, tmdb: m.tmdbId ? {type: m.type, id: +m.tmdbId} : null};
      });
    });
  }
  // Alternate the two feeds, dropping repeats (same TMDB title, or same name when JustWatch has no TMDB id).
  function mergePicks(a, b) {
    var seen = {}, out = [];
    for (var i = 0; i < Math.max(a.length, b.length); i++) [a[i], b[i]].forEach(function (it) {
      if (!it) return;
      var k = it.tmdb ? it.tmdb.type + ':' + it.tmdb.id : it.title.toLowerCase();
      if (!seen[k] && !seen[it.title.toLowerCase()]) { seen[k] = seen[it.title.toLowerCase()] = 1; out.push(it); }
    });
    return out;
  }
  function youtube() {
    return get('https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&maxResults=20&regionCode=' + C.REGION + '&key=' + C.YT_KEY)
      .then(function (r) {
        return {title: 'Trending on YouTube', items: r.items.map(function (v) {
          var t = v.snippet.thumbnails, img = t.medium.url, big = (t.maxres || t.standard || t.high).url;
          var views = +(v.statistics && v.statistics.viewCount) || 0;
          return {title: v.snippet.title, sub: v.snippet.description, img: img, bg: big, blur: t.default.url, src: 'YouTube',
            meta: v.snippet.channelTitle + (views ? '  ·  ' + (views >= 1e6 ? (views / 1e6).toFixed(1) + 'M' : Math.round(views / 1e3) + 'K') + ' views' : ''),
            svc: {name: 'YouTube', app: 'youtube.leanback.v4'}, params: {contentTarget: 'https://www.youtube.com/tv?v=' + v.id}};
        })};
      });
  }

  // Continue watching: titles opened from this home screen (other apps don't share their history).
  var recent = [];
  recent = store('recent') || [];
  function remember(it) {
    var keep = {title: it.title, sub: it.sub, meta: it.meta, img: it.img, bg: it.bg, blur: it.blur, src: it.src, svc: it.svc, params: it.params, tmdb: it.tmdb, at: Date.now()};
    recent = [keep].concat(recent.filter(function (x) { return x.title !== it.title; })).slice(0, 12);
    store('recent', recent);
    buildRows();
  }
  function ago(t) {
    var m = Math.round((Date.now() - t) / 60000);
    return m < 60 ? (m || 1) + ' min ago' : m < 1440 ? Math.round(m / 60) + ' hr ago' : Math.round(m / 1440) + ' days ago';
  }

  // OK on a title → open the service that streams it.
  // Deep links: Wikidata maps TMDB ids to a service's own title id (Netflix: P1874). Cached per title;
  // falls back to just opening the app when there's no match or Wikidata is slow.
  var DEEP = {
    netflix: {prop: 'P1874', params: function (id) { return {contentTarget: 'm=https://www.netflix.com/title/' + id + '&source_type=4'}; }},
    // JioHotstar: same link LG's voice search sends, minus /watch (that one needs an episode, this opens the show).
    hotstar: {prop: 'P11049', wait: 5000,
      lookup: function (it) { // JustWatch first (via the service), Wikidata if that finds nothing
        return svc('justwatchId', {title: it.title, tmdbId: it.tmdb.id, provider: 'hotstar'})
          .then(function (r) { return r.id || wikidataId(it, 'P11049'); }, function () { return wikidataId(it, 'P11049'); });
      },
      params: function (id) { return {contentTarget: 'https://livingroom.hotstar.com/' + id + '?utm_source=lgtv&utm_medium=partner_homepage'}; }},
    // Prime takes Amazon's title id (as LG's own voice search sends it); the service finds it by title.
    amazon: {wait: 5000, lookup: function (it) { return svc('primeGti', {title: it.title}).then(function (r) { return r.gti || null; }); },
      params: function (gti) { return {contentTarget: gti}; }}
  };
  function wikidataId(it, prop) {
    var q = 'SELECT ?v WHERE { ?i wdt:' + (it.tmdb.type === 'movie' ? 'P4947' : 'P4983') + ' "' + it.tmdb.id + '" ; wdt:' + prop + ' ?v } LIMIT 1';
    return get('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q))
      .then(function (r) { var b = r.results.bindings[0]; return b ? b.v.value : null; });
  }
  function deepParams(it, app) {
    var d = DEEP[app];
    if (!d || !it.tmdb) return Promise.resolve(null);
    var key = 'v2:' + app + ':' + it.tmdb.type + ':' + it.tmdb.id, cache = {}; // v2: JustWatch added, retry old misses
    try { cache = JSON.parse(localStorage.deepIds || '{}'); } catch (e) { /* storage unavailable */ }
    if (key in cache) return Promise.resolve(cache[key] && d.params(cache[key]));
    var find = d.lookup ? d.lookup(it) : wikidataId(it, d.prop);
    var lookup = find.then(function (id) {
      cache[key] = id;
      try { localStorage.deepIds = JSON.stringify(cache); } catch (e) { /* storage unavailable */ }
      return id && d.params(id);
    });
    var timeout = new Promise(function (ok) { setTimeout(function () { ok(null); }, d.wait || 2500); });
    return Promise.race([lookup, timeout]).catch(function () { return null; });
  }
  function launchTitle(it, svc) {
    if (it.params) return launch(svc.app, it.params);
    deepParams(it, svc.app).then(function (params) { launch(svc.app, params || undefined); });
  }
  function openItem(it) {
    if (it.svc) { remember(it); return launchTitle(it, it.svc); }
    tmdb(it.tmdb.type + '/' + it.tmdb.id + '/watch/providers').then(function (r) {
      var reg = r.results[C.REGION] || {}, list = (reg.flatrate || []).concat(reg.ads || [], reg.free || []), svc;
      for (var i = 0; i < list.length && !svc; i++) { svc = svcFor(list[i].provider_name); if (svc && S.services.indexOf(svc.name) < 0) svc = null; }
      svc ? (remember(Object.assign({}, it, {svc: svc})), launchTitle(it, svc)) : toast('“' + it.title + '” isn’t on your services in ' + C.REGION);
    }).catch(function () { toast('Could not look up where to watch'); });
  }

  // ---------- render ----------
  var rowsData = [], heroItems = [], base = [], rowProviders = [];
  function buildRows() {
    var extra = rowProviders.map(function (fn) { return fn(); }).filter(Boolean);
    rowsData = base.slice(0, 2).concat([{title: 'Continue watching', items: recent}], extra, base.slice(2))
      .filter(function (x) { return (x.apps || x.items).length; });
    if (base.length) render();
  }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; }
  function esc(s) { return String(s || '').replace(/[&<>"]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }

  function appTile(a) {
    var t = el('div', 'app f');
    t.innerHTML = '<div class="disc" style="background:' + a.color + '">' +
      (a.img || a.icon ? '<img src="' + (a.img || 'icons/' + a.icon) + '" alt="" decoding="async">' : '<span class="txt">' + esc(a.title) + '</span>') + '</div><div class="cap">' + esc(a.title) + '</div>';
    t.onok = function () { editing ? openAppMenu(a) : launch(a.id); };
    t.app = a;
    return t;
  }
  // Edit mode for the app lists: OK on an app opens Move / Remove instead of launching it.
  var editing = false;
  var PENCIL = '<svg viewBox="0 0 24 24" style="width:46px;height:46px"><path fill="currentColor" d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
  var CHECK = '<svg viewBox="0 0 24 24" style="width:50px;height:50px"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
  function editTile() {
    var t = el('div', 'app f edit-tile', '<div class="disc">' + (editing ? CHECK : PENCIL) + '</div><div class="cap">' + (editing ? 'Done' : 'Edit apps') + '</div>');
    t.onok = function () {
      editing = !editing;
      document.body.classList.toggle('editing', editing);
      if (!editing) endMove();
      var keep = view; render(); if (keep !== view) setView(keep);
      var tiles = document.querySelectorAll('.edit-tile'); for (var i = 0; i < tiles.length; i++) if (!tiles[i].offsetParent) continue; else { focusEl(tiles[i]); break; }
      toast(editing ? 'Edit mode: OK on an app to move or remove it' : 'Done');
    };
    return t;
  }
  function focusEl(e) { for (var r = 0; r < nav.length; r++) { var c = nav[r].indexOf(e); if (c >= 0) { pos.r = r; pos.c = c; focus(); return; } } }
  function card(it) {
    var c = el('div', 'card f', '<div class="pic"><img src="' + it.img + '" alt="" loading="lazy" decoding="async">' +
      (it.src === 'YouTube' ? '' : '<b class="ttl">' + esc(it.title) + '</b>') + '</div>' +
      '<div class="cap">' + esc(it.at ? it.svc.name + '  ·  opened ' + ago(it.at) : it.src === 'YouTube' ? it.title : it.meta) + '</div>');
    c.item = it; c.onok = function () { TV.itemOk(it); };
    return c;
  }
  function render() {
    var root = $('rows'); root.innerHTML = '';
    rowsData.forEach(function (row) {
      var r = el('section', 'row' + (row.apps ? ' apps-row' : '')), s = el('div', 'strip');
      r.appendChild(el('h3', '', esc(row.title)));
      (row.apps || row.items).forEach(function (x) { s.appendChild(row.apps ? appTile(x) : card(x)); });
      if (row.apps) s.appendChild(editTile());
      r.appendChild(s); root.appendChild(r);
    });
    var g = $('grid'); g.innerHTML = '';
    visibleApps().forEach(function (a) { g.appendChild(appTile(a)); });
    g.appendChild(editTile());
    buildNav();
  }

  var SROWS = [
    {key: 'region', title: 'Country', hint: 'Where to look up what’s streaming', opts: COUNTRIES},
    {key: 'langs', title: 'Recommendation languages', hint: 'Pick any. None = trending in every language', many: true, opts: LANGS},
    {key: 'services', title: 'Your streaming services', hint: 'Each gets a “Popular on …” row', many: true, opts: C.SERVICES.map(function (x) { return [x.name, x.name]; })},
    {key: 'youtube', title: 'Trending on YouTube row', opts: [[true, 'On'], [false, 'Off']]},
    {key: 'autoplay', title: 'Rotate featured titles', opts: [[true, 'On'], [false, 'Off']]},
    {key: 'clock24', title: 'Clock', opts: [[false, '12-hour'], [true, '24-hour']]},
    {key: 'weatherCity', title: 'Weather city', hint: 'Auto finds your city from your internet connection', opts: [['auto', 'Auto'],
      ['Mumbai', 'Mumbai'], ['Delhi', 'Delhi'], ['Bengaluru', 'Bengaluru'], ['Hyderabad', 'Hyderabad'], ['Chennai', 'Chennai'],
      ['Kolkata', 'Kolkata'], ['Pune', 'Pune'], ['Ahmedabad', 'Ahmedabad'], ['Jaipur', 'Jaipur'], ['Lucknow', 'Lucknow'],
      ['Chandigarh', 'Chandigarh'], ['Kochi', 'Kochi'], ['off', 'Off']]},
    {key: 'unhide', title: 'Your apps', hint: 'Hold OK on an app to move or remove it', opts: [['unhide', 'Show hidden apps']]},
    {key: 'clear', title: 'Continue watching', opts: [['clear', 'Clear history']]}
  ];
  var draft, dirty;
  function renderSettings() {
    $('settings').innerHTML = '<div class="shead"><h2>Settings</h2><span id="sclose" class="f" title="Close">&#10005;</span></div>' + SROWS.map(function (row, r) {
      return '<section class="srow"><h4>' + row.title + '</h4>' + (row.hint ? '<p>' + row.hint + '</p>' : '') + '<div class="strip">' +
        row.opts.map(function (o, i) {
          var v = draft[row.key], sel = row.many ? v.indexOf(o[0]) >= 0 : v === o[0];
          return '<span class="chip f' + (sel ? ' sel' : '') + '" data-r="' + r + '" data-i="' + i + '">' + (sel && row.many ? '✓ ' : '') + o[1] + '</span>';
        }).join('') + '</div></section>';
    }).join('');
  }
  function openSettings() {
    draft = JSON.parse(JSON.stringify(S)); dirty = false; prevView = view;
    renderSettings(); $('spanel').hidden = $('sdim').hidden = false; pos.r = 1; pos.c = 0; mem = {}; view = 'settings'; buildNav();
  }
  function closeSettings() {
    if (dirty) { store('settings', draft); store('homeCache', null); location.reload(); return; }
    $('spanel').hidden = $('sdim').hidden = true; pos.r = 0; setView(prevView);
  }
  function choose(e) {
    var row = SROWS[+e.dataset.r], o = row.opts[+e.dataset.i], v = draft[row.key];
    if (row.key === 'unhide') { store('appHidden', []); refreshApps(); return toast('Hidden apps are back'); }
    if (row.key === 'clear') { recent = []; store('recent', []); buildRows(); return toast('Continue watching cleared'); }
    if (row.many) { var i = v.indexOf(o[0]); i >= 0 ? v.splice(i, 1) : v.push(o[0]); } else draft[row.key] = o[0];
    dirty = true;
    var r = pos.r, c = pos.c; renderSettings(); buildNav(); pos.r = r; pos.c = c; focus();
  }

  // ---------- quick settings side panel ----------
  var OUTPUTS = {tv_speaker: 'TV speaker', bt_soundbar: 'Bluetooth soundbar', external_arc: 'HDMI ARC', external_optical: 'Optical',
    headphone: 'Headphones', tv_external_speaker: 'TV + external', lineout: 'Line out'};
  function setText(id, t) { $(id).textContent = t; }
  function refreshQuick() {
    var d = new Date();
    setText('qdate', d.toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric'}));
    setText('qtime', $('clock').textContent + (S.clock24 ? '' : d.getHours() < 12 ? ' AM' : ' PM'));
    if (!onTV) { setText('qwifi', 'Home Wi-Fi'); setText('qaudio', 'TV speaker'); setText('qbt', 'On'); setText('qvol', '37'); return; }
    luna('com.webos.service.connectionmanager/getStatus').then(function (r) {
      setText('qwifi', r.wifi && r.wifi.state === 'connected' ? r.wifi.displayName || r.wifi.ssid || 'Connected' : r.wired && r.wired.state === 'connected' ? 'Ethernet' : 'Not connected');
    }, function () { setText('qwifi', ''); });
    luna('com.webos.service.audio/getSoundOutput').then(function (r) { setText('qaudio', OUTPUTS[r.soundOutput] || r.soundOutput); }, function () {});
    luna('com.webos.service.bluetooth2/adapter/getStatus').then(function (r) { setText('qbt', r.adapters && r.adapters[0] && r.adapters[0].powered ? 'On' : 'Off'); }, function () {});
    luna('com.webos.audio/getVolume').then(function (r) { setText('qvol', r.muteStatus ? 'Muted' : r.volume); }, function () {});
    svc('getAv').then(function (r) {
      av.pic = r.picture.pictureMode; av.snd = r.sound.soundMode; av.bl = +r.picture.backlight;
      setText('qpic', label(PICS, av.pic)); setText('qsnd', label(SOUNDS, av.snd)); setText('qbl', isNaN(av.bl) ? '–' : av.bl);
    }, function () { setText('qpic', 'Needs root'); setText('qsnd', 'Needs root'); });
    svc('getInputs').then(function (r) {
      $('qinputs').innerHTML = r.inputs.filter(function (i) { return i.connected || /hdmi/i.test(i.id); }).map(function (i) {
        return '<span class="chip f' + (i.active ? ' sel' : '') + '" data-q="input" data-id="' + esc(i.id) + '">' + esc(i.label) + (i.connected ? '' : ' ·') + '</span>';
      }).join('');
      if (view === 'quick') buildNav();
    }, function () { $('qinputs').innerHTML = '<span class="chip f" data-q="inputs">Inputs</span>'; if (view === 'quick') buildNav(); });
  }
  // Picture / sound modes this TV offers (an unsupported one is skipped with a toast).
  var PICS = [['vivid', 'Vivid'], ['normal', 'Standard'], ['eco', 'Eco'], ['cinema', 'Cinema'], ['sports', 'Sports'], ['game', 'Game'], ['filmMaker', 'Filmmaker']];
  var SOUNDS = [['aiSoundPlus', 'AI Sound Pro'], ['standard', 'Standard'], ['movie', 'Cinema'], ['news', 'Clear Voice'], ['music', 'Music'], ['game', 'Game']];
  var av = {};
  function label(list, v) { for (var i = 0; i < list.length; i++) if (list[i][0] === v) return list[i][1]; return v || ''; }
  function next(list, v) { for (var i = 0; i < list.length; i++) if (list[i][0] === v) return list[(i + 1) % list.length][0]; return list[0][0]; }
  function setAv(method, params, ok) {
    svc(method, params).then(function (r) { r.returnValue === false ? toast('Not supported on this TV') : ok(); }, function () { toast('Needs the TV Home service (rooted TV)'); });
  }
  function openQuick() {
    prevView = view; refreshQuick();
    $('qpanel').hidden = $('qdim').hidden = false;
    view = 'quick'; pos.r = 1; pos.c = 0; mem = {}; buildNav();
  }
  function closeQuick() { $('qpanel').hidden = $('qdim').hidden = true; pos.r = 0; setView(prevView); }
  function volume(dir) {
    luna('com.webos.service.audio/master/' + dir).then(function (r) { setText('qvol', r.volume); }, function (e) { toast('Volume: ' + (e.errorText || e)); });
  }
  function quickAct(q, btn) {
    var tvSettings = function (target) { launch('com.palm.app.settings', {target: target}); };
    ({
      settings: function () { closeQuick(); openSettings(); },
      tip: function () { closeQuick(); openSettings(); },
      close: closeQuick,
      screensaver: function () { launch('com.webos.app.screensaver'); },
      inputs: function () { launch('com.webos.app.inputcommon'); },
      wifi: function () { tvSettings('network'); },
      a11y: function () { tvSettings('accessibility'); },
      audio: function () { tvSettings('sound'); },
      bluetooth: function () { tvSettings('bluetooth'); },
      picture: function () { var m = next(PICS, av.pic); setAv('setPicture', {pictureMode: m}, function () { av.pic = m; setText('qpic', label(PICS, m)); }); },
      sound: function () { var m = next(SOUNDS, av.snd); setAv('setSound', {soundMode: m}, function () { av.snd = m; setText('qsnd', label(SOUNDS, m)); }); },
      bldown: function () { var b = Math.max(0, (av.bl || 0) - 10); setAv('setPicture', {backlight: b}, function () { av.bl = b; setText('qbl', b); }); },
      blup: function () { var b = Math.min(100, (av.bl || 0) + 10); setAv('setPicture', {backlight: b}, function () { av.bl = b; setText('qbl', b); }); },
      screenoff: function () { closeQuick(); svc('screenOff').then(function () {}, function () { toast('Needs the TV Home service (rooted TV)'); }); },
      input: function () { closeQuick(); launch(btn.dataset.id); },
      voldown: function () { volume('volumeDown'); },
      volup: function () { volume('volumeUp'); }
    })[q]();
  }

  // ---------- hero / background ----------
  var heroIdx = 0, bgFlip = false, lastBg, lastBlur, bgTimer;
  function setBlur(src) { if (src && src !== lastBlur) { lastBlur = src; $('bgBlur').src = src; } }
  // Swap backgrounds only once focus rests, so holding an arrow key doesn't decode/blur every card.
  function bgFor(it, scrolled) {
    clearTimeout(bgTimer);
    bgTimer = setTimeout(function () {
      if (scrolled) setBlur(it && it.blur); else setBg(it ? it.bg : heroItems[heroIdx] && heroItems[heroIdx].bg);
    }, 300);
  }
  function setBg(src) {
    if (!src || src === lastBg) return; lastBg = src;
    var on = bgFlip ? $('bgA') : $('bgB'), off = bgFlip ? $('bgB') : $('bgA');
    bgFlip = !bgFlip;
    on.onload = function () { on.className = 'on'; off.className = ''; };
    on.src = src;
  }
  function showHero() {
    var it = heroItems[heroIdx]; if (!it) return;
    $('heroSrc').textContent = it.src;
    $('heroTitle').textContent = it.title;
    $('heroMeta').textContent = it.meta || '';
    $('heroSub').textContent = it.sub || '';
    $('heroBtn').textContent = it.svc ? 'Open in ' + it.svc.name : 'Where to watch';
    $('dots').innerHTML = heroItems.map(function (_, i) { return '<i' + (i === heroIdx ? ' class="on"' : '') + '></i>'; }).join('');
    setBg(it.bg);
  }
  function stepHero(d) { heroIdx = (heroIdx + d + heroItems.length) % heroItems.length; showHero(); }
  var idleSince = Date.now();
  setInterval(function () { if (S.autoplay && view === 'home' && pos.r <= 1 && Date.now() - idleSince > 7000) stepHero(1); }, 8000);

  // ---------- navigation (keys + pointer) ----------
  var nav = [], pos = {r: 0, c: 0}, mem = {}, view = 'home', prevView = 'home';
  function all(sel) { return [].slice.call(document.querySelectorAll(sel)); }
  function buildNav() {
    var top = all('#top .f');
    if (views[view]) {
      nav = views[view].nav();
    } else if (view === 'quick') {
      nav = all('#quick .qrow').map(function (r) { return [].slice.call(r.querySelectorAll('.f')); });
    } else if (view === 'settings') {
      nav = [[$('sclose')]].concat(all('#settings .strip').map(function (s) { return [].slice.call(s.children); }));
    } else if (view === 'home') {
      nav = [top, [$('heroBtn')]].concat(all('#rows .strip').map(function (s) { return [].slice.call(s.children); }));
    } else {
      var tiles = all('#grid .app'), cols = 9;
      nav = [top];
      for (var i = 0; i < tiles.length; i += cols) nav.push(tiles.slice(i, i + cols));
    }
    nav = nav.filter(function (r) { return r.length; });
    pos.r = Math.min(pos.r, nav.length - 1);
    focus();
  }
  function focus(fromPointer) {
    var cur = document.querySelector('.focus'); if (cur) cur.classList.remove('focus');
    if (!nav.length) return;
    var row = nav[pos.r]; pos.c = Math.max(0, Math.min(pos.c, row.length - 1));
    var e = row[pos.c]; e.classList.add('focus'); mem[pos.r] = pos.c;
    if (fromPointer) return; // don't scroll content out from under the pointer
    var strip = e.parentNode;
    if (views[view]) { if (views[view].onFocus) views[view].onFocus(e, pos); return; }
    if (view === 'quick') return;
    if (strip.classList.contains('strip')) strip.style.transform = 'translateX(' + -Math.max(0, e.offsetLeft - (pos.c ? 40 : 0)) + 'px)';
    var section = e.closest('.row, .srow');
    var rowTop = pos.r === 0 ? 0 : section ? section.offsetTop : e.offsetTop;
    var dy = view === 'home' ? (section && section.previousElementSibling ? rowTop - 90 : 0) : Math.max(0, rowTop - 400);
    if (view === 'home') dy = Math.max(0, Math.min(dy, $('home').scrollHeight - 1080 + 40)); // stop at the last row
    $(view).style.transform = 'translateY(' + -dy + 'px)';
    if (view === 'settings') return;
    document.body.classList.toggle('scrolled', dy > 0);
    bgFor(e.item, dy > 0);
  }
  function setView(v) {
    view = v; $('home').hidden = v !== 'home'; $('apps').hidden = v !== 'apps';
    all('.tab').forEach(function (t) { t.classList.toggle('cur', t.dataset.tab === v); });
    $('bg').style.opacity = v === 'home' ? 1 : 0;
    $('bgBlur').style.visibility = v === 'home' || v === 'settings' || v === 'quick' ? '' : 'hidden';
    document.body.classList.toggle('scrolled', v !== 'home');
    buildNav();
  }
  function activate(e) {
    if (e.dataset.tab) return setView(e.dataset.tab);
    if (e.dataset.view) return openView(e.dataset.view);
    if (e.dataset.act === 'live') return launch('com.webos.app.livetv');
    if (e.id === 'avatar') return TV.onAvatar();
    if (e.dataset.act === 'settings') return openQuick();
    if (e.dataset.act === 'weather') return openView('weather');
    if (e.dataset.q) return quickAct(e.dataset.q, e);
    if (e.dataset.r) return choose(e);
    if (e.id === 'sclose') return closeSettings();
    if (e.id === 'heroBtn') return TV.itemOk(heroItems[heroIdx]);
    if (e.onok) e.onok();
  }
  var holdTimer = 0, holdFired = false, moving = null;
  document.addEventListener('keyup', function (ev) {
    if (ev.keyCode !== 13) return;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; var cur = nav[pos.r] && nav[pos.r][pos.c]; if (cur && cur.onok) cur.onok(); }
    holdFired = false;
  });
  document.addEventListener('keydown', function (ev) {
    if (moving && (ev.keyCode === 37 || ev.keyCode === 39)) { ev.preventDefault(); return moveApp(ev.keyCode === 39 ? 1 : -1); }
    if (moving && (ev.keyCode === 461 || ev.keyCode === 27 || ev.keyCode === 8)) { ev.preventDefault(); return endMove(); }
    var k = ev.keyCode, onHero = view === 'home' && pos.r === 1;
    idleSince = Date.now();
    if (views[view] && views[view].keydown && views[view].keydown(ev)) { ev.preventDefault(); return; } // view handled it
    if (k === 37) { if (onHero) stepHero(-1); else pos.c--; }
    else if (k === 39) { if (onHero) stepHero(1); else pos.c++; }
    else if (k === 38) { if (pos.r > 0) { pos.r--; pos.c = mem[pos.r] || 0; } }
    else if (k === 40) { if (pos.r < nav.length - 1) { pos.r++; pos.c = mem[pos.r] || 0; } }
    else if (k === 13) {
      ev.preventDefault();
      var cur = nav[pos.r][pos.c];
      if (moving) return endMove();
      if (cur && cur.app && view !== 'appmenu' && !editing) { // app tile: launch on release, menu if held
        if (!ev.repeat && !holdTimer) holdTimer = setTimeout(function () { holdTimer = 0; holdFired = true; openAppMenu(cur.app); }, 550);
        return;
      }
      return activate(cur);
    }
    else if (k === 461 || k === 27 || k === 8) { if (views[view]) return views[view].back ? views[view].back() : closeView(); if (view === 'settings') return closeSettings(); if (view === 'quick') return closeQuick(); if (view !== 'home') setView('home'); else { pos.r = 1; pos.c = 0; } }
    else return;
    ev.preventDefault();
    focus();
  });
  // Magic Remote scroll wheel: one notch = one row (sideways wheel/trackpad = one item).
  var wheelAt = 0;
  document.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    if (Date.now() - wheelAt < 180) return;
    var dy = ev.deltaY, dx = ev.deltaX;
    if (Math.abs(dy) < 4 && Math.abs(dx) < 4) return;
    wheelAt = Date.now(); idleSince = wheelAt;
    if (Math.abs(dx) > Math.abs(dy)) { if (view === 'home' && pos.r === 1) stepHero(dx > 0 ? 1 : -1); else pos.c += dx > 0 ? 1 : -1; }
    else if (dy > 0 && pos.r < nav.length - 1) { pos.r++; pos.c = mem[pos.r] || 0; }
    else if (dy < 0 && pos.r > 0) { pos.r--; pos.c = mem[pos.r] || 0; }
    focus();
  }, {passive: false});
  // Magic Remote pointer: hover moves focus, OK/click activates.
  function locate(target) {
    var e = target.closest && target.closest('.f');
    if (!e) return null;
    for (var r = 0; r < nav.length; r++) { var c = nav[r].indexOf(e); if (c >= 0) return {r: r, c: c, e: e}; }
    return null;
  }
  document.addEventListener('mouseover', function (ev) {
    var p = locate(ev.target); idleSince = Date.now();
    if (p && (p.r !== pos.r || p.c !== pos.c)) { pos.r = p.r; pos.c = p.c; focus(true); if (p.e.item) bgFor(p.e.item, document.body.classList.contains('scrolled')); }
  });
  document.addEventListener('click', function (ev) {
    var p = locate(ev.target);
    if (p) { pos.r = p.r; pos.c = p.c; focus(true); activate(p.e); }
  });

  // ---------- misc ----------
  var toastT;
  function toast(m) { var t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = 'none'; }, 3500); }
  function tick() { var d = new Date(), h = d.getHours(); $('clock').textContent = (S.clock24 ? ('0' + h).slice(-2) : h % 12 || 12) + ':' + ('0' + d.getMinutes()).slice(-2); }
  setInterval(tick, 10000); tick();

  // ---------- weather (Open-Meteo, no key) ----------
  var WX = { // 24px stroke icons
    sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    cloud: '<path d="M7 18h10.5a4 4 0 0 0 .3-8A6 6 0 0 0 6.2 10.4 3.8 3.8 0 0 0 7 18z"/>',
    rain: '<path d="M7 15h10.5a4 4 0 0 0 .3-8A6 6 0 0 0 6.2 7.4 3.8 3.8 0 0 0 7 15zM9 18l-1 3M13 18l-1 3M17 18l-1 3"/>',
    snow: '<path d="M7 15h10.5a4 4 0 0 0 .3-8A6 6 0 0 0 6.2 7.4 3.8 3.8 0 0 0 7 15zM8.5 19h.01M12 21h.01M15.5 19h.01"/>',
    storm: '<path d="M7 15h10.5a4 4 0 0 0 .3-8A6 6 0 0 0 6.2 7.4 3.8 3.8 0 0 0 7 15zM13 15l-2.5 4h3L11 23"/>',
    fog: '<path d="M4 9h16M6 13h12M4 17h16"/>'
  };
  function wxIcon(code, day) {
    return code <= 1 ? (day ? 'sun' : 'moon') : code <= 3 ? 'cloud' : code <= 48 ? 'fog' :
      (code >= 71 && code <= 77) || code === 85 || code === 86 ? 'snow' : code >= 95 ? 'storm' : 'rain';
  }
  function wxSvg(code, day) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + WX[wxIcon(code, day)] + '</svg>';
  }
  function weatherLoc() {
    var city = S.weatherCity || 'auto', saved = store('weatherLoc');
    if (saved && saved.city === city) return Promise.resolve(saved);
    var find = city === 'auto'
      ? get('https://ipapi.co/json/').then(function (r) { return {lat: r.latitude, lon: r.longitude, name: r.city}; })
      : get('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(city))
        .then(function (r) { var g = r.results[0]; return {lat: g.latitude, lon: g.longitude, name: g.name}; });
    return find.then(function (l) { l.city = city; store('weatherLoc', l); return l; });
  }
  function weather() {
    if (S.weatherCity === 'off') return;
    weatherLoc().then(function (l) {
      return get('https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code,is_day&latitude=' + l.lat + '&longitude=' + l.lon)
        .then(function (r) {
          var c = r.current, w = $('weather');
          w.innerHTML = wxSvg(c.weather_code, c.is_day) + Math.round(c.temperature_2m) + '°';
          w.title = l.name; w.hidden = false;
        });
    }).catch(function (e) { console.warn('weather', e); });
  }
  weather(); setInterval(weather, 15 * 60 * 1000);
  $('avatar').textContent = C.NAME;
  document.querySelector('.qav').textContent = C.NAME;
  $('qdim').onclick = function () { closeQuick(); };
  $('sdim').onclick = function () { closeSettings(); };

  // ---------- move / remove apps ----------
  function refreshApps() {
    base.forEach(function (row) { if (row.apps) row.apps = visibleApps(); });
    buildRows();
  }
  function focusApp(id) { // put focus back on an app tile after re-rendering
    for (var r = 0; r < nav.length; r++) for (var c = 0; c < nav[r].length; c++) if (nav[r][c].app && nav[r][c].app.id === id) { pos.r = r; pos.c = c; focus(); return; }
  }
  var menu = el('div', '', ''); menu.id = 'appmenu'; menu.hidden = true; document.body.appendChild(menu);
  function openAppMenu(a) {
    menu.innerHTML = '<h4>' + esc(a.title) + '</h4><span class="chip f" data-m="move">Move</span><span class="chip f" data-m="remove">Remove from home</span><span class="chip f" data-m="cancel">Cancel</span>';
    [].forEach.call(menu.querySelectorAll('.chip'), function (c) {
      c.onok = function () {
        closeView();
        if (c.dataset.m === 'move') { moving = a.id; focusApp(a.id); var t = document.querySelector('.focus'); if (t) t.classList.add('moving'); toast('Left / right to move, OK when done'); }
        if (c.dataset.m === 'remove') {
          store('appHidden', (store('appHidden') || []).concat(a.id)); refreshApps();
          toast(a.title + ' removed. Settings → Show hidden apps brings it back');
        }
      };
    });
    openView('appmenu');
  }
  function moveApp(d) {
    var list = visibleApps().map(function (a) { return a.id; }), i = list.indexOf(moving), j = i + d;
    if (i < 0 || j < 0 || j >= list.length) return;
    list[i] = list[j]; list[j] = moving;
    store('appOrder', list); refreshApps(); focusApp(moving);
    var t = document.querySelector('.focus'); if (t) t.classList.add('moving');
  }
  function endMove() { if (!moving) return; moving = null; var t = document.querySelector('.moving'); if (t) t.classList.remove('moving'); toast('Saved'); }

  // ---------- plugin API (details.js, search.js, ambient.js, profiles.js) ----------
  // A view = {nav() -> rows of focusable elements, show(arg), hide(), onFocus(el, pos)?, back()?, keydown(ev)?}.
  var views = {}, stack = [];
  function openView(name, arg) {
    stack.push({view: view, r: pos.r, c: pos.c, mem: mem});
    view = name; pos.r = 0; pos.c = 0; mem = {};
    views[name].show(arg); buildNav();
  }
  function closeView() {
    if (views[view] && views[view].hide) views[view].hide();
    var prev = stack.pop() || {view: 'home', r: 1, c: 0, mem: {}};
    view = prev.view; mem = prev.mem; pos.r = prev.r; pos.c = prev.c;
    buildNav();
  }
  var TV = window.TV = {
    C: C, S: S, P: P, LANGS: LANGS, IMG: IMG, onTV: onTV,
    luna: luna, launch: launch, get: get, tmdb: tmdb, fromTmdb: fromTmdb, svcFor: svcFor, store: store,
    openItem: openItem,            // default OK on a title: open its service
    itemOk: openItem,              // override to intercept OK on any title card / hero
    onAvatar: openQuick,           // override to change what the avatar does
    card: card, esc: esc, el: el, toast: toast, setBg: setBg, setBlur: setBlur,
    heroItems: function () { return heroItems; },
    view: function () { return view; },
    idleSince: function () { return idleSince; },
    addView: function (name, def) { views[name] = def; },
    openView: openView, closeView: closeView,
    rebuild: function (r, c) { if (r != null) { pos.r = r; pos.c = c || 0; } buildNav(); },
    addRow: function (fn) { rowProviders.push(fn); },   // fn() -> {title, items} | null, shown after Continue watching
    refresh: function () { buildRows(); },
    addTab: function (label, viewName) {
      var t = el('span', 'tab f', esc(label)); t.dataset.view = viewName;
      document.querySelector('#top .pill').insertBefore(t, document.querySelector('[data-tab=apps]'));
      buildNav();
    },
    addSetting: function (row, def) { if (S[row.key] === undefined) S[row.key] = def; SROWS.splice(SROWS.length - 1, 0, row); }
  };
  if (P.name) { $('avatar').textContent = document.querySelector('.qav').textContent = P.name.charAt(0).toUpperCase(); }
  if (P.color) $('avatar').style.background = P.color;
  // ---------- weather side panel ----------
  var WXTEXT = {0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle',
    55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow',
    73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy showers', 85: 'Snow showers',
    86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail'};
  var wxPanel = el('div', '', ''), wxDim = el('div', '', '');
  wxPanel.id = 'wxpanel'; wxDim.id = 'wxdim'; wxPanel.hidden = wxDim.hidden = true;
  document.body.appendChild(wxDim); document.body.appendChild(wxPanel);
  wxDim.onclick = function () { closeView(); };
  function hhmm(iso) { var h = +iso.slice(11, 13), m = iso.slice(14, 16); return S.clock24 ? iso.slice(11, 16) : (h % 12 || 12) + ':' + m + (h < 12 ? ' AM' : ' PM'); }
  function renderWx(l, r) {
    var c = r.current, d = r.daily, h = r.hourly, now = c.time.slice(0, 13), start = 0;
    while (start < h.time.length - 1 && h.time[start].slice(0, 13) < now) start++;
    var hours = '', days = '';
    for (var i = start; i < start + 12 && i < h.time.length; i++) {
      hours += '<div class="wxh"><span>' + (i === start ? 'Now' : hhmm(h.time[i]).replace(':00', '')) + '</span>' + wxSvg(h.weather_code[i], h.is_day[i]) + '<b>' + Math.round(h.temperature_2m[i]) + '°</b></div>';
    }
    for (var j = 0; j < d.time.length; j++) {
      var name = j === 0 ? 'Today' : new Date(d.time[j] + 'T12:00').toLocaleDateString('en-US', {weekday: 'short'});
      days += '<div class="wxd"><span>' + name + '</span>' + wxSvg(d.weather_code[j], 1) + '<i>' + (d.precipitation_probability_max[j] ? d.precipitation_probability_max[j] + '%' : '') +
        '</i><b>' + Math.round(d.temperature_2m_max[j]) + '°</b><em>' + Math.round(d.temperature_2m_min[j]) + '°</em></div>';
    }
    wxPanel.innerHTML = '<div class="wxtop"><div><div class="wxcity">' + esc(l.name) + '</div><div class="wxnow">' + wxSvg(c.weather_code, c.is_day) +
      '<span>' + Math.round(c.temperature_2m) + '°</span></div><div class="wxcond">' + (WXTEXT[c.weather_code] || '') + '  ·  H ' + Math.round(d.temperature_2m_max[0]) +
      '°  L ' + Math.round(d.temperature_2m_min[0]) + '°</div></div><span class="wxbtn f" data-wx="close">&#10005;</span></div>' +
      '<div class="wxstats"><div><small>Feels like</small>' + Math.round(c.apparent_temperature) + '°</div><div><small>Humidity</small>' + c.relative_humidity_2m +
      '%</div><div><small>Wind</small>' + Math.round(c.wind_speed_10m) + ' km/h</div><div><small>Sunrise</small>' + hhmm(d.sunrise[0]) + '</div><div><small>Sunset</small>' + hhmm(d.sunset[0]) + '</div></div>' +
      '<h4>Next 12 hours</h4><div class="wxhours">' + hours + '</div><h4>Next ' + d.time.length + ' days</h4><div class="wxdays">' + days + '</div>' +
      '<div class="wxfoot"><span class="wxbtn wide f" data-wx="city">Change city</span><small>Open-Meteo</small></div>';
    wxPanel.querySelector('[data-wx=close]').onok = closeView;
    wxPanel.querySelector('[data-wx=city]').onok = function () { closeView(); openSettings(); };
    buildNav();
  }
  views.weather = {
    nav: function () { return [].slice.call(wxPanel.querySelectorAll('.f')).map(function (e) { return [e]; }); },
    show: function () {
      wxPanel.hidden = wxDim.hidden = false;
      wxPanel.innerHTML = '<div class="wxtop"><div class="wxload">Loading weather…</div><span class="wxbtn f" data-wx="close">&#10005;</span></div>';
      wxPanel.querySelector('[data-wx=close]').onok = closeView;
      weatherLoc().then(function (l) {
        return get('https://api.open-meteo.com/v1/forecast?timezone=auto&forecast_days=6&latitude=' + l.lat + '&longitude=' + l.lon +
          '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day' +
          '&hourly=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max')
          .then(function (r) { if (TV.view() === 'weather') renderWx(l, r); });
      }).catch(function () { wxPanel.querySelector('.wxload').textContent = 'Couldn’t load the weather. Check the connection.'; });
    },
    hide: function () { wxPanel.hidden = wxDim.hidden = true; }
  };

  views.appmenu = {
    nav: function () { return [[].slice.call(menu.querySelectorAll('.chip'))]; },
    show: function () { menu.hidden = false; }, hide: function () { menu.hidden = true; }
  };
  window.dispatchEvent(new Event('tvready'));

  // Relaunch (Home button, or opening TV Home again): appinfo's handlesRelaunch keeps the page alive
  // instead of reloading it behind a splash, so bring ourselves forward and go back to the top of For you.
  document.addEventListener('webOSRelaunch', function () {
    try { window.PalmSystem.activate(); } catch (e) { /* not on webOS */ }
    if (!$('qpanel').hidden) closeQuick();
    if (!$('spanel').hidden) { $('spanel').hidden = $('sdim').hidden = true; }
    while (views[view]) closeView();
    if (view !== 'home') setView('home');
    pos.r = 1; pos.c = 0; buildNav();
  });

  // ---------- boot ----------
  // Draw the last home screen straight away (webOS often kills us in the background, so most
  // opens are cold starts), then replace it with fresh data. Kept per profile via store().
  function booted() { // fade the loading screen once the (non-blocking) stylesheets have loaded too
    if (document.readyState !== 'complete') return window.addEventListener('load', booted, {once: true});
    var b = $('boot'); if (b) { b.classList.add('gone'); setTimeout(function () { b.remove(); }, 700); }
  }
  var cached = store('homeCache');
  if (cached && cached.base && cached.base.length) {
    heroItems = cached.hero; base = cached.base;
    buildRows(); showHero(); pos.r = 1; focus(); booted();
  }
  var tries = 0;
  function loadHome() { return loadApps().then(function () {
    var safe = function (p) { return p.catch(function (e) { console.warn(e); return null; }); };
    return Promise.all([
      safe(trending()),
      safe(jwPicks()),
      safe(tmdb('watch/providers/tv', '&watch_region=' + C.REGION).then(function (r) {
        return Promise.all(SERVICES.map(function (s) { return safe(serviceRow(s, r.results)); }));
      })),
      S.youtube ? safe(youtube()) : null
    ]).then(function (r) {
      var picks = mergePicks(r[1] || [], r[0] || []); // JustWatch first, then TMDB
      if (!picks.length && !(r[2] || []).filter(Boolean).length) { // nothing yet (early boot, network not up): retry
        if (++tries < 40) { if (!cached) setText('bootmsg', 'Waiting for the internet…'); setTimeout(loadHome, 5000); }
        return;
      }
      r.splice(1, 1); // keep the indexes below as they were
      heroItems = picks.slice(0, 6);
      base = [{title: 'Top picks for you', items: picks.slice(6)}, {title: 'Your apps', apps: visibleApps()}]
        .concat((r[1] || []).filter(Boolean), r[2] ? [r[2]] : []);
      store('homeCache', {hero: heroItems, base: base});
      var fresh = !cached; // keep the user's place if they already started moving around the cached screen
      buildRows(); showHero(); booted();
      if (fresh) { pos.r = 1; focus(); }
    });
  }); }
  loadHome();
})();
