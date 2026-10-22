// TV Home launcher service, adapted from zzeppieri/webos-custom-home (MIT).
// A registered webOS service inside the TV Home package, so applicationManager/launch is allowed.
// Reads the remote's key events without grabbing them, and opens TV Home:
//   --boot   at startup (retries until the app manager is ready)
//   --watch  whenever HOME is pressed; also after waking from standby
var Service = require('webos-service');
var fs = require('fs');

// With as-home.sh, TV Home *is* com.webos.app.home. Native apps like Netflix don't hand the Home key to the
// system, so we still watch the remote and open the home app ourselves.
var TAKEOVER = fs.existsSync('/usr/palm/applications/com.webos.app.home/index.html');
var APP_ID = TAKEOVER ? 'com.webos.app.home' : 'com.boring.tvhome';
var HOME_CODE = 773; // HOME on LG Magic Remotes (confirmed on the 55UR8040)
var EV_KEY = 1, EVENT_SIZE = 16; // 32-bit struct input_event
var LOG = '/tmp/tvhome-svc.log';
var ARGS = process.argv.slice(2);
function log(msg) { try { fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch (e) { /* ignore */ } }

// webos-service exits after ~5s idle unless timeouts are disabled.
if (process.argv.indexOf('--disable-timeouts') === -1) process.argv.push('--disable-timeouts');
var service = new Service('com.boring.tvhome.service');
try { fs.writeFileSync('/tmp/tvhome-svc.pid', String(process.pid)); } catch (e) { /* ignore */ }
log('start pid=' + process.pid + ' args=' + ARGS.join(' ') + ' app=' + APP_ID);
service.register('status', function (m) { m.respond({returnValue: true, running: true, pid: process.pid}); });

// ---- Privileged helpers for the TV Home page. The page's own app id isn't allowed these calls, but this
// service runs as root, and root's luna-send is. A fixed list of methods, never a pass-through.
var cp = require('child_process');
var screenIsOff = false; // set by screenOff; the next key press turns the screen back on (see watchAll)
function lunaRoot(uri, params) {
  return new Promise(function (ok) {
    cp.execFile('luna-send', ['-n', '1', '-w', '5000', uri, JSON.stringify(params || {})], {timeout: 8000, maxBuffer: 4 << 20}, function (e, out) {
      try { ok(JSON.parse(out)); } catch (x) { ok({returnValue: false, errorText: String(e ? e.message : out).slice(0, 200)}); }
    });
  });
}
var iconCache = {};
function iconData(path) { // launch-point icons live in other apps' folders the page can't read
  if (!path) return '';
  if (iconCache[path] === undefined) {
    try { iconCache[path] = 'data:image/png;base64,' + fs.readFileSync(path).toString('base64'); } catch (e) { iconCache[path] = ''; }
  }
  return iconCache[path];
}
var SKIP_APPS = ['com.webos.app.home', 'com.boring.tvhome'];
// app id -> icon file, filled by getApps; getIcon only serves these (no arbitrary file reads).
// The biggest icon the TV offers is used (extraLargeIcon is 192 px on webOS 25, the others 80-130 px): the tiles are drawn at ~150 px.
var iconPath = {};
var api = {
  getApps: function () {
    return lunaRoot('luna://com.webos.applicationManager/listLaunchPoints').then(function (r) {
      return {returnValue: !!r.launchPoints, apps: (r.launchPoints || []).filter(function (p) { return !p.hidden && SKIP_APPS.indexOf(p.id) < 0; })
        .map(function (p) { iconPath[p.id] = p.extraLargeIcon || p.largeIcon || p.mediumLargeIcon || p.icon; return {id: p.id, title: p.title, color: p.bgColor || p.iconColor}; })};
    });
  },
  getIcon: function (p) { return Promise.resolve({returnValue: true, icon: iconData(iconPath[p.id])}); },
  getInputs: function () {
    return lunaRoot('luna://com.webos.service.eim/getAllInputStatus').then(function (r) {
      return {returnValue: !!r.devices, inputs: (r.devices || []).map(function (d) { return {id: d.appId, label: d.label, connected: d.connected, active: d.activate}; })};
    });
  },
  getAv: function () {
    return Promise.all([
      lunaRoot('luna://com.webos.settingsservice/getSystemSettings', {category: 'picture', keys: ['pictureMode', 'backlight']}),
      lunaRoot('luna://com.webos.settingsservice/getSystemSettings', {category: 'sound', keys: ['soundMode']})
    ]).then(function (r) { return {returnValue: true, picture: r[0].settings || {}, sound: r[1].settings || {}}; });
  },
  setPicture: function (p) { // {pictureMode} or {backlight}
    var s = {};
    if (p.pictureMode) s.pictureMode = String(p.pictureMode);
    if (p.backlight != null) s.backlight = String(Math.max(0, Math.min(100, +p.backlight)));
    return lunaRoot('luna://com.webos.settingsservice/setSystemSettings', {category: 'picture', settings: s});
  },
  setSound: function (p) { return lunaRoot('luna://com.webos.settingsservice/setSystemSettings', {category: 'sound', settings: {soundMode: String(p.soundMode)}}); },
  screenOff: function () { return lunaRoot('luna://com.webos.service.tvpower/power/turnOffScreen', {}).then(function (r) { screenIsOff = r.returnValue !== false; return r; }); },
  // Prime Video deep links need Amazon's title id ("GTI"). Look it up on Prime's search page by exact title:
  // the first GTI near that title. The page can't fetch primevideo.com itself (CORS), so the service does.
  primeGti: function (p) {
    var title = String(p.title || '').trim();
    if (!title) return Promise.resolve({returnValue: false});
    return new Promise(function (ok) {
      require('https').get('https://www.primevideo.com/search/?phrase=' + encodeURIComponent(title), {
        headers: {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept-Language': 'en-IN'}, timeout: 6000
      }, function (res) {
        var html = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { html += c; });
        res.on('end', function () {
          var esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\\\"');
          var m = new RegExp('"title":"' + esc + '"', 'i').exec(html), gti = null;
          if (m) {
            var near = html.slice(Math.max(0, m.index - 1500), m.index + 1500).match(/amzn1\.dv\.gti\.[0-9a-f-]{36}/);
            gti = near && near[0];
          }
          log('primeGti ' + title + ' -> ' + gti);
          ok({returnValue: !!gti, gti: gti});
        });
      }).on('error', function () { ok({returnValue: false}); }).on('timeout', function () { this.destroy(); });
    });
  },
  // A service's own title id from JustWatch (the data behind TMDB's "where to watch"): search by title,
  // keep the result with the same TMDB id, and take the id from that service's offer URL.
  // {title, tmdbId, provider: 'hotstar'} -> {id}
  justwatchId: function (p) {
    var q = 'query($c:Country!,$l:Language!,$q:String!){popularTitles(country:$c,first:5,filter:{searchQuery:$q}){edges{node{... on MovieOrShow{' +
      'content(country:$c,language:$l){externalIds{tmdbId}} offers(country:$c,platform:WEB){standardWebURL}}}}}}';
    var body = JSON.stringify({query: q, variables: {c: 'IN', l: 'en', q: String(p.title || '')}});
    return new Promise(function (ok) {
      var req = require('https').request('https://apis.justwatch.com/graphql', {method: 'POST', timeout: 6000,
        headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}}, function (res) {
        var out = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { out += c; });
        res.on('end', function () {
          var id = null;
          try {
            JSON.parse(out).data.popularTitles.edges.some(function (e) {
              if (String(e.node.content.externalIds.tmdbId) !== String(p.tmdbId)) return false;
              return e.node.offers.some(function (o) {
                var m = o.standardWebURL && o.standardWebURL.indexOf(p.provider) >= 0 && o.standardWebURL.match(/\/(\d{6,})(?:[/?]|$)/);
                if (m) id = m[1];
                return !!m;
              });
            });
          } catch (e) { /* unexpected reply: no id */ }
          log('justwatchId ' + p.provider + ' ' + p.title + ' -> ' + id);
          ok({returnValue: !!id, id: id});
        });
      });
      req.on('error', function () { ok({returnValue: false}); }).on('timeout', function () { req.destroy(); });
      req.end(body);
    });
  },
  // JustWatch "popular now" on the given packages (e.g. nfx, prv, jhs) in India, for Top picks.
  // JustWatch sends no CORS header, so the page asks the service. {packages, first} -> {items}
  jwPopular: function (p) {
    var q = 'query($c:Country!,$l:Language!,$p:[String!],$n:Int!){popularTitles(country:$c,first:$n,sortBy:POPULAR,filter:{packages:$p}){edges{node{objectType ... on MovieOrShow{' +
      'content(country:$c,language:$l){title shortDescription originalReleaseYear externalIds{tmdbId} backdrops{backdropUrl} scoring{imdbScore}} offers(country:$c,platform:WEB){package{shortName}}}}}}}';
    var body = JSON.stringify({query: q, variables: {c: 'IN', l: 'en', p: p.packages || [], n: Math.min(+p.first || 30, 60)}});
    return new Promise(function (ok) {
      var req = require('https').request('https://apis.justwatch.com/graphql', {method: 'POST', timeout: 8000,
        headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}}, function (res) {
        var out = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { out += c; });
        res.on('end', function () {
          var items = [];
          try {
            JSON.parse(out).data.popularTitles.edges.forEach(function (e) {
              var n = e.node, c = n.content, b = c.backdrops && c.backdrops[0] && c.backdrops[0].backdropUrl;
              if (!b) return; // no art, no card
              // JustWatch backdrop sizes that exist: s480, s640, s1440, s1920 (others return 400)
              var img = function (size) { return 'https://images.justwatch.com' + b.replace('{profile}', size).replace('{format}', 'webp'); };
              items.push({type: n.objectType === 'MOVIE' ? 'movie' : 'tv', tmdbId: c.externalIds && c.externalIds.tmdbId, title: c.title,
                sub: c.shortDescription, year: c.originalReleaseYear, score: c.scoring && c.scoring.imdbScore,
                img: img('s640'), blur: img('s480'), bg: img('s1440'), packages: (n.offers || []).map(function (o) { return o.package.shortName; })});
            });
          } catch (e) { /* unexpected reply: no items */ }
          log('jwPopular ' + items.length);
          ok({returnValue: items.length > 0, items: items});
        });
      });
      req.on('error', function () { ok({returnValue: false, items: []}); }).on('timeout', function () { req.destroy(); });
      req.end(body);
    });
  },
  screenOn: function () { return lunaRoot('luna://com.webos.service.tvpower/power/turnOnScreen', {}); }
};
Object.keys(api).forEach(function (name) {
  service.register(name, function (m) { api[name](m.payload || {}).then(function (r) { m.respond(r); }); });
});
// Same methods over HTTP on the TV's loopback only: TV Home running as com.webos.app.home isn't in this
// service's luna permission group, but it can fetch() this. POST /<method> with a JSON body.
var API_PORT = 45620;
require('http').createServer(function (req, res) {
  var name = req.url.slice(1).split('?')[0], body = '';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (!api[name]) { res.statusCode = 404; return res.end('{"returnValue":false,"errorText":"unknown method"}'); }
  req.on('data', function (c) { body += c; if (body.length > 1e4) req.destroy(); });
  req.on('end', function () {
    var p = {}; try { p = JSON.parse(body || '{}'); } catch (e) { /* empty params */ }
    api[name](p).then(function (r) { res.end(JSON.stringify(r)); });
  });
}).listen(API_PORT, '127.0.0.1', function () { log('api on 127.0.0.1:' + API_PORT); });

function launch(reason, cb) {
  service.call('luna://com.webos.applicationManager/launch', {id: APP_ID}, function (m) {
    log('launch (' + reason + '): ' + JSON.stringify(m && m.payload));
    if (cb) cb(m && m.payload && m.payload.returnValue === true);
  });
}
// LG's own home still opens on HOME (we only read the key) and finishes animating in after our
// first launch, covering TV Home. So launch again once it has appeared. Tune the delays if needed.
var HOME_DELAYS = TAKEOVER ? [150] : [400, 1300]; // with the takeover there is no LG home to wait for
var busy = false;
function onHome() {
  if (busy) return;
  busy = true; setTimeout(function () { busy = false; }, 1600);
  HOME_DELAYS.forEach(function (ms, i) { setTimeout(function () { launch('home-key #' + (i + 1)); }, ms); });
}

// Boot: the app manager isn't ready straight away, so retry for up to ~60s.
function bootLaunch(n) { launch('boot #' + n, function (ok) { if (!ok && n < 30) setTimeout(function () { bootLaunch(n + 1); }, 2000); }); }

// Poll every input device without blocking (blocking reads would use up libuv's thread pool).
function watchAll() {
  var fds = [];
  try {
    fs.readdirSync('/dev/input').filter(function (f) { return f.indexOf('event') === 0; }).forEach(function (f) {
      try { fds.push(fs.openSync('/dev/input/' + f, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch (e) { /* skip */ }
    });
  } catch (e) { log('readdir /dev/input: ' + e.message); return; }
  log('watching ' + fds.length + ' input devices');
  var buf = Buffer.alloc(EVENT_SIZE * 64);
  setInterval(function () {
    for (var i = 0; i < fds.length; i++) {
      var n = 0;
      try { n = fs.readSync(fds[i], buf, 0, buf.length, null); } catch (e) { continue; } // EAGAIN = nothing waiting
      for (var off = 0; off + EVENT_SIZE <= n; off += EVENT_SIZE) {
        if (buf.readUInt16LE(off + 8) !== EV_KEY || buf.readInt32LE(off + 12) !== 1) continue;
        var code = buf.readUInt16LE(off + 10);
        if (screenIsOff) { screenIsOff = false; api.screenOn(); log('screen on (key ' + code + ')'); continue; }
        if (code === HOME_CODE) { log('HOME key'); onHome(); }
      }
    }
  }, 16);
}

if (ARGS.indexOf('--boot') !== -1) setTimeout(function () { bootLaunch(1); }, 1000);
if (ARGS.indexOf('--watch') !== -1) watchAll();

// Waking from standby doesn't rerun the startup hook, but this process is frozen during standby,
// so a big gap in a 1s heartbeat means the TV just woke: reopen TV Home a few times as the UI returns.
var last = Date.now();
setInterval(function () {
  var now = Date.now(), gap = now - last; last = now;
  if (gap > 10000) {
    log('wake after ~' + Math.round(gap / 1000) + 's');
    var tries = 0, iv = setInterval(function () { launch('wake ' + (++tries)); if (tries >= 4) clearInterval(iv); }, 1500);
  }
}, 1000);
