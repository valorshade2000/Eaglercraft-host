'use strict';
// The donation message on the players' pages (config donation, src/donation.js; GET /api/donation). On the game page
// (/client/): a small card in the bottom left corner while the game loads, folded after 20 s into a "Support this
// server" button; it opens again when the server lags (at most once per the owner's cooldown). On /donate: the card as
// a page. Nothing shows while the owner has it off. "Copy" puts the wallet address on the clipboard. Its own shadow
// DOM, so the game page's styles and its own do not meet.
(function () {
  var PAGE = !!document.getElementById('donate-page');
  var KEY = 'eaglan.donate';
  var store = { get: function (k) { try { return sessionStorage.getItem(KEY + '.' + k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(KEY + '.' + k, v); } catch (e) {} } };
  var CSS = ':host{all:initial}' +
    '.wrap{position:fixed;left:16px;bottom:16px;z-index:2147483647;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e8eaed;max-width:min(340px,calc(100vw - 32px))}' +
    '.page{position:static;margin:48px auto;max-width:460px;font-size:15px}' +
    '.card{background:rgba(22,24,28,.94);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:14px 16px 16px;box-shadow:0 10px 30px rgba(0,0,0,.45);animation:in .25s ease-out}' +
    '@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
    '.head{display:flex;align-items:center;gap:8px;font-weight:650;font-size:14px;color:#f4c15d}' +
    '.page .head{font-size:18px}' +
    '.heart{color:#ff5a6e}' +
    '.x{margin-left:auto;background:none;border:0;color:#9aa0a6;font-size:18px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px}' +
    '.x:hover{color:#fff;background:rgba(255,255,255,.08)}' +
    '.lag{margin-top:8px;padding:6px 9px;border-radius:8px;background:rgba(255,183,77,.14);color:#ffcc80;font-size:12px}' +
    '.msg{margin:8px 0 0;color:#d7dade;white-space:pre-wrap;overflow-wrap:anywhere}' +
    '.goal{margin-top:10px;font-size:12px;color:#c4c7cc}' +
    '.bar{height:6px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden;margin-top:5px}' +
    '.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#f4c15d,#ff8a65)}' +
    '.to{margin-top:12px;font-size:12px;color:#9aa0a6}' +
    '.addr{display:flex;gap:6px;margin-top:4px;align-items:stretch}' +
    '.addr code{flex:1;min-width:0;padding:7px 9px;border-radius:8px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:#8ee0ff;overflow-wrap:anywhere;user-select:all}' +
    '.copy{flex:none;border:0;border-radius:8px;padding:0 12px;background:#f4c15d;color:#1b1d21;font:600 12px system-ui,sans-serif;cursor:pointer}' +
    '.copy:hover{background:#ffd27a}' +
    '.thanks{margin-top:10px;font-size:11px;color:#80868b}' +
    '.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.14);border-radius:99px;padding:6px 12px;background:rgba(22,24,28,.85);color:#e8eaed;font:600 12px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}' +
    '.pill:hover{background:rgba(40,43,49,.95)}' +
    '.pill.lagging{border-color:rgba(255,183,77,.6)}';
  var host = document.createElement('div');
  var root = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style'); style.textContent = CSS; root.appendChild(style);
  var wrap = document.createElement('div'); wrap.className = PAGE ? 'wrap page' : 'wrap'; root.appendChild(wrap);
  var data = null, open = false, timer = null;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  function copy(text, btn) {
    var done = function (ok) { btn.textContent = ok ? 'Copied!' : 'Select it'; setTimeout(function () { btn.textContent = 'Copy'; }, 1800); };
    var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} ta.remove();
    if (ok) return done(true);
    try { navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); }); } catch (e) { done(false); }
  }
  function render() {
    if (!data || !data.enabled) { wrap.innerHTML = ''; return; }
    if (!PAGE && !open) {
      wrap.innerHTML = '<button class="pill' + (data.lag ? ' lagging' : '') + '" type="button"><span class="heart">&#9829;</span> Support this server</button>';
      wrap.querySelector('.pill').onclick = function () { show(false); };
      return;
    }
    var pct = data.goal > 0 ? Math.max(0, Math.min(100, (data.raised / data.goal) * 100)) : 0;
    wrap.innerHTML = '<div class="card" role="complementary" aria-label="Support this server">' +
      '<div class="head"><span class="heart">&#9829;</span> Support this server' + (PAGE ? '' : '<button class="x" type="button" aria-label="Close">&times;</button>') + '</div>' +
      (data.lag ? '<div class="lag">The server is running slow right now. Your support helps make it faster.</div>' : '') +
      '<p class="msg">' + esc(data.message) + '</p>' +
      (data.goalText ? '<div class="goal">' + esc(data.goalText) + '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>' : '') +
      '<div class="to">Send' + (data.network ? ' <b>' + esc(data.network) + '</b>' : '') + ' to:</div>' +
      '<div class="addr"><code>' + esc(data.address) + '</code><button class="copy" type="button">Copy</button></div>' +
      '<div class="thanks">Thank you! Every bit helps keep the server running.</div></div>';
    wrap.querySelector('.copy').onclick = function (e) { copy(data.address, e.target); };
    var x = wrap.querySelector('.x'); if (x) x.onclick = function () { open = false; store.set('folded', '1'); render(); };
  }
  // open the card (lag: for 30 s, then folded again; first: for 20 s while the game loads)
  function show(auto) {
    open = true; render();
    clearTimeout(timer);
    if (auto && !PAGE) timer = setTimeout(function () { open = false; render(); }, auto === 'lag' ? 30000 : 20000);
  }
  function load() {
    fetch('/api/donation', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      var was = data; data = d;
      if (!d.enabled) { open = false; return render(); }
      if (!was && (PAGE || store.get('folded') !== '1')) return show(PAGE ? false : 'first');
      if (d.lag && !PAGE) {
        var last = +store.get('lagShown') || 0;
        if (Date.now() - last >= (d.cooldownMinutes || 30) * 60000) { store.set('lagShown', String(Date.now())); return show('lag'); }
      }
      render();
    }).catch(function () {});
  }
  (document.body || document.documentElement).appendChild(host);
  load();
  if (!PAGE) setInterval(load, 30000);
})();
