(function () {
  'use strict';
  var PORT = 8002, DEF_IP = '192.168.29.2', DEF_LABEL = 'Phone Remote';
  var K = { token: 'tvremote.token', label: 'tvremote.label', ip: 'tvremote.ip', haptic: 'tvremote.haptics', done: 'tvremote.onboarded', scr: 'tvremote.screenOff' };
  var APPS = { youtube: '111299001912', netflix: '3201907018807', prime: '3201910019365', appletv: '3201807016597' };
  var MAX_LOG = 60, QUEUE_MS = 8000, LONG_MS = 900;
  var NOWAKE = { KEY_VOLUP: 1, KEY_VOLDOWN: 1, KEY_MUTE: 1 }; // keys that don't bring the picture back
  var IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  var CERT_HINT = 'Browser probably blocked the TV\'s certificate - redo Trust the TV in Settings.';

  var $ = function (id) { return document.getElementById(id); };
  var visible = function () { return document.visibilityState === 'visible'; };

  // ---- storage (always guarded) ----
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  var ws = null, state = 'disconnected', playing = false;
  var retry = false, attempt = 0, failStreak = 0, retryTimer = null, connectTimer = null, queued = null;
  var tvIp = lsGet(K.ip); if (!tvIp || !IPV4.test(tvIp)) tvIp = DEF_IP;
  var hapticOn = lsGet(K.haptic) !== '0';
  // Power = Picture Off (TV stays on Wi-Fi). The page can't read TV state, so remember it per device.
  var screenOff = lsGet(K.scr) === '1', busy = false, stepT = null;

  // ---- log + hint ----
  var logEl = $('log');
  function log(msg, cls) {
    var d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = new Date().toLocaleTimeString([], { hour12: false }) + '  ' + msg;
    logEl.insertBefore(d, logEl.firstChild);
    while (logEl.children.length > MAX_LOG) logEl.removeChild(logEl.lastChild);
  }
  function setHint(t) { $('hint').textContent = t || ''; }

  // ---- haptics: vibrate on Android; on iOS 18 a hidden switch toggle plays a tap,
  // but only inside a real user gesture (touchend), so iOS taps are fired from there ----
  var canVibrate = typeof navigator.vibrate === 'function';
  function haptic() {
    if (hapticOn && canVibrate) { try { navigator.vibrate(8); } catch (e) {} }
  }
  // Fresh switch inside a hidden label each time (same approach as the ios-haptics library).
  function iosTap() {
    if (!hapticOn || canVibrate) return;
    try {
      var l = document.createElement('label'), i = document.createElement('input');
      l.setAttribute('aria-hidden', 'true'); l.style.display = 'none';
      i.type = 'checkbox'; i.setAttribute('switch', '');
      l.appendChild(i); document.head.appendChild(l);
      l.click(); document.head.removeChild(l);
    } catch (e) {}
  }

  // ---- status ----
  var STAT = { disconnected: 'Offline', connecting: 'Connecting', waiting: 'Allow on TV', connected: 'Connected', error: 'Error' };
  function setState(s) {
    var prev = state; state = s;
    $('dot').className = 'dot ' + s;
    $('stat').textContent = (s === 'connecting' && retry && attempt > 0) ? 'Reconnecting' : STAT[s];
    if (prev === 'connected' && s !== 'connected') { release(); if (busy) abortOff('Connection lost - screen off cancelled. Tap Power to retry.'); }
  }
  function hasToken() { return !!lsGet(K.token); }
  function refreshUi() {
    var paired = hasToken();
    $('onboard').hidden = paired || lsGet(K.done) === '1';
    $('tokState').textContent = paired ? 'Paired (token saved on this device).' : 'Not paired yet.';
  }
  function updateTrust() {
    var u = 'https://' + tvIp + ':' + PORT + '/api/v2/';
    $('trust').href = u; $('obTrust').href = u;
  }

  // ---- connection ----
  function encodeName(label) {
    var s = label || DEF_LABEL;
    try { return encodeURIComponent(btoa(s)); }
    catch (e) { return encodeURIComponent(btoa(unescape(encodeURIComponent(s)))); } // non-Latin1 labels
  }
  function buildUrl(mask) {
    var label = lsGet(K.label) || DEF_LABEL;
    var url = 'wss://' + tvIp + ':' + PORT + '/api/v2/channels/samsung.remote.control?name=' + encodeName(label);
    var tok = lsGet(K.token);
    if (tok) url += '&token=' + (mask ? '***' : encodeURIComponent(tok));
    return url;
  }
  function clearConnectTimer() { if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; } }
  function clearRetryTimer() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } }

  function connect(silent) {
    if (ws && ws.readyState < 2) { log('Already connected/connecting - ignoring'); return; }
    clearRetryTimer();
    var tokenAtStart = hasToken(), opened = false, up = false;
    if (!silent) setHint('');
    setState('connecting');
    log('Connect attempt' + (silent ? ' (auto)' : '') + ': ' + buildUrl(true));
    try { ws = new WebSocket(buildUrl(false)); }
    catch (e) { log('WebSocket constructor threw: ' + e, 'err'); retry = false; setState('error'); return; }
    var mine = ws;
    // Safari can hang silently on an untrusted cert (or an off TV); surface that.
    clearConnectTimer();
    connectTimer = setTimeout(function () {
      if (mine !== ws || opened) return;
      log('No response after 12s', 'hint');
      if (retry) { try { mine.close(); } catch (e) {} }
      else setHint('Still not open. ' + CERT_HINT + ' Also check same Wi-Fi and TV is on.');
    }, 12000);

    mine.onopen = function () {
      if (mine !== ws) return;
      opened = true; clearConnectTimer();
      log('onopen - socket open', 'ok');
      if (tokenAtStart) setState('connecting');
      else { setState('waiting'); setHint('Look at the TV and select Allow with the TV\'s buttons.'); }
    };
    mine.onmessage = function (ev) {
      if (mine !== ws) return;
      var m = null;
      try { m = JSON.parse(ev.data); } catch (e) { log('Non-JSON message: ' + String(ev.data).slice(0, 120)); return; }
      var name = m.event || m.method || '(unknown)';
      if (name === 'ms.channel.connect') {
        log('Event: ' + name);
        var tok = m.data && m.data.token;
        if (tok) { lsSet(K.token, String(tok)); log('Token saved', 'ok'); }
        else log('No token in message - keeping any saved one');
        lsSet(K.done, '1');
        up = true; retry = true; attempt = 0; failStreak = 0;
        refreshUi(); setState('connected'); setHint('');
        flushQueue();
      } else if (name === 'ms.channel.unauthorized') {
        log('Event: ' + name);
        retry = false; setState('error');
        setHint('TV denied - reconnect and select Allow.');
        log('TV denied - reconnect and select Allow', 'hint');
      } else if (name === 'ms.channel.timeOut') {
        log('Event: ' + name);
        retry = false; setState('error');
        setHint('The Allow prompt timed out - reconnect and select Allow sooner.');
        log('Allow prompt timed out', 'hint');
      } else {
        log('Event: ' + name + '  ' + String(ev.data).slice(0, 160)); // shows app-launch replies/errors
      }
    };
    mine.onerror = function () {
      if (mine !== ws) return;
      log('onerror (browsers give no details)', 'err');
      if (!retry) {
        if (!opened) setHint(CERT_HINT);
        if (state !== 'error') setState('error');
      }
    };
    mine.onclose = function (ev) {
      clearConnectTimer();
      log('onclose code=' + ev.code + ' reason="' + (ev.reason || '') + '" clean=' + ev.wasClean, ev.code === 1000 ? '' : 'err');
      if (mine !== ws) return;
      ws = null;
      if (retry) {
        if (!up) {
          failStreak++;
          if (!opened && ev.code === 1006) log('Closed before open (TV off, or certificate not trusted)', 'hint');
          if (failStreak === 4) setHint('Can\'t reach the TV. If it was fully switched off, turn it on with the TV\'s own button \u2014 after that, use this Power button (it keeps the TV reachable).');
        }
        setState('disconnected');
        scheduleRetry();
      } else if (!opened && ev.code === 1006) {
        log(CERT_HINT, 'hint'); setHint(CERT_HINT); setState('error');
      } else if (state !== 'error') {
        setState('disconnected');
      }
    };
  }

  function disconnect() {
    retry = false; clearRetryTimer(); clearConnectTimer();
    var o = ws; ws = null;
    if (o) { o.onopen = o.onmessage = o.onerror = o.onclose = null; try { o.close(1000); } catch (e) {} }
    setState('disconnected');
  }

  // Quiet auto-retry: 1s, 2s, 4s, 8s, then 10s; only while the page is visible.
  function scheduleRetry() {
    clearRetryTimer();
    if (!retry || !visible()) return;
    var d = Math.min(10000, 1000 * Math.pow(2, attempt++));
    log('Retry in ' + (d / 1000) + 's');
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (retry && visible()) connect(true);
    }, d);
  }
  // Immediate reconnect (user pressed something, or page came back).
  function kick() {
    if (ws && ws.readyState < 2) return;
    retry = true; attempt = 0;
    connect(true);
  }
  function resume() {
    if (!visible() || !hasToken() || (ws && ws.readyState < 2)) return;
    log('Page visible again - reconnecting with saved token');
    kick();
  }

  // ---- sending (queues only the newest message while offline; dropped after 3s) ----
  function write(msg, label) {
    try { ws.send(JSON.stringify(msg)); } catch (e) { log('send failed: ' + e, 'err'); return false; }
    log('Sent ' + label);
    return true;
  }
  function sendMsg(msg, label) {
    haptic();
    if (state === 'connected' && ws && ws.readyState === 1) return write(msg, label);
    if (hasToken()) {
      queued = { msg: msg, label: label, t: Date.now() };
      log('Not connected - queued ' + label + ', reconnecting', 'hint');
      kick();
    } else log('Not connected - ' + label + ' not sent', 'hint');
    return false;
  }
  function flushQueue() {
    var q = queued; queued = null;
    if (!q) return;
    if (Date.now() - q.t <= QUEUE_MS) write(q.msg, q.label + ' (queued)');
    else log('Dropped stale queued ' + q.label, 'hint');
  }
  function keyMsg(key, cmd) {
    return { method: 'ms.remote.control', params: { Cmd: cmd || 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } };
  }
  function sendKey(key) {
    if (busy) return false; // screen-off sequence running
    if (!NOWAKE[key]) setScreenOff(false); // any other key brings the picture back
    return sendMsg(keyMsg(key), key);
  }
  function isUp() { return state === 'connected' && ws && ws.readyState === 1; }

  // ---- power: screen off/on via Picture Off (accessibility shortcut menu) ----
  function setScreenOff(v) {
    if (v !== screenOff) { screenOff = v; lsSet(K.scr, v ? '1' : '0'); }
    var p = $('power');
    p.classList.toggle('scr-off', screenOff);
    p.setAttribute('aria-label', screenOff ? 'Screen off' : 'Screen on');
  }
  function offSteps() {
    var l = [{ c: 'Press', k: 'KEY_MUTE', w: 2000 }, { c: 'Release', k: 'KEY_MUTE', w: 2200 }], i;
    for (i = 0; i < 16; i++) l.push({ c: 'Click', k: 'KEY_UP', w: 220 });
    for (i = 0; i < 11; i++) l.push({ c: 'Click', k: 'KEY_DOWN', w: 260 });
    l.push({ c: 'Click', k: 'KEY_ENTER', w: 0 });
    return l;
  }
  function endOff() { busy = false; if (stepT) { clearTimeout(stepT); stepT = null; } }
  function abortOff(msg) {
    endOff(); setHint(msg); log('Screen off aborted: ' + msg, 'hint');
  }
  function runOff(l, i) {
    stepT = null;
    if (!busy) return;
    if (!isUp()) { abortOff('Connection lost - screen off cancelled. Tap Power to retry.'); return; }
    var s = l[i];
    try { ws.send(JSON.stringify(keyMsg(s.k, s.c))); }
    catch (e) { log('send failed: ' + e, 'err'); abortOff('Send failed - screen off cancelled. Tap Power to retry.'); return; }
    if (i === l.length - 1) {
      endOff(); setScreenOff(true); setHint('');
      log('Screen off sequence done', 'ok');
      return;
    }
    stepT = setTimeout(function () { runOff(l, i + 1); }, s.w);
  }
  function needUp(again) {
    if (isUp()) return false;
    setHint('Connecting\u2026 ' + again);
    if (hasToken()) kick(); else log('Not paired - Power not sent', 'hint');
    return true;
  }
  function powerTap() {
    if (busy) return;
    if (screenOff) { // wake: KEY_RETURN (queues if offline)
      setScreenOff(false);
      sendMsg(keyMsg('KEY_RETURN'), 'KEY_RETURN');
      return;
    }
    haptic();
    if (needUp('tap Power again')) return;
    busy = true; setHint('Turning screen off\u2026'); log('Screen off sequence started');
    runOff(offSteps(), 0);
  }
  function powerHold() {
    if (busy || needUp('hold Power again')) return;
    if (!window.confirm('Turn the TV fully off? The phone can\'t turn it back on \u2014 you\'ll need the TV\'s own power button.')) return;
    if (!isUp()) { setHint('Connection lost - hold Power to try again.'); return; }
    if (write(keyMsg('KEY_POWER'), 'KEY_POWER')) setScreenOff(false);
  }
  // The TV ignores ed.apps.launch for some apps (Netflix); its REST endpoint launches all of them.
  function launchApp(name) {
    if (busy) return;
    setScreenOff(false);
    haptic();
    var url = 'https://' + tvIp + ':' + PORT + '/api/v2/applications/' + APPS[name];
    fetch(url, { method: 'POST', mode: 'no-cors', cache: 'no-store' })
      .then(function () { log('Launched ' + name); })
      .catch(function (e) {
        log('Launch ' + name + ' failed (' + e + ') - trying socket', 'hint');
        sendMsg({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: APPS[name], action_type: 'DEEP_LINK' } } }, 'launch ' + name);
      });
  }

  // ---- buttons: pointer events, instant .down class, hold-repeat ----
  var holdT = null, repT = null, curBtn = null, pwT = null, pwDown = false, pwLong = false;
  function release() {
    if (pwT) { clearTimeout(pwT); pwT = null; }
    pwDown = false;
    if (holdT) { clearTimeout(holdT); holdT = null; }
    if (repT) { clearInterval(repT); repT = null; }
    if (curBtn) { curBtn.classList.remove('down'); curBtn = null; }
  }
  function fire(b) {
    var d = b.dataset;
    if (d.act === 'playpause') { sendKey(playing ? 'KEY_PAUSE' : 'KEY_PLAY'); playing = !playing; }
    else if (d.app) launchApp(d.app);
    else if (d.key) sendKey(d.key);
  }
  function noMenu(e) { e.preventDefault(); }
  function bindPress(b, onDown) {
    b.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      release(); curBtn = b; b.classList.add('down');
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      onDown(b);
      if (b.dataset.repeat) holdT = setTimeout(function () { holdT = null; repT = setInterval(function () { fire(b); }, 180); }, 350);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
      b.addEventListener(t, function () { if (curBtn === b) release(); });
    });
    b.addEventListener('touchend', iosTap);
    b.addEventListener('click', function (e) { if (e.detail === 0) onDown(b); }); // keyboard / assistive
    b.addEventListener('contextmenu', noMenu);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.key:not(.power)'), function (b) { bindPress(b, fire); });
  // Power: tap = screen off/on, hold >= 900 ms = full power-off (never both)
  (function () {
    var b = $('power');
    b.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      release(); curBtn = b; b.classList.add('down');
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      pwDown = true; pwLong = false;
      pwT = setTimeout(function () { pwT = null; pwLong = true; haptic(); powerHold(); }, LONG_MS);
    });
    b.addEventListener('pointerup', function () {
      var tap = pwDown && !pwLong;
      release();
      if (tap) powerTap();
    });
    ['pointercancel', 'lostpointercapture'].forEach(function (t) {
      b.addEventListener(t, function () { if (curBtn === b) release(); });
    });
    b.addEventListener('touchend', iosTap);
    b.addEventListener('click', function (e) { if (e.detail === 0) powerTap(); }); // keyboard / assistive
    b.addEventListener('contextmenu', noMenu);
  })();
  bindPress($('gear'), function () {}); // press feedback only
  $('gear').addEventListener('click', function () { openSheet(true); }); // open on click so the tap can't hit the backdrop
  document.addEventListener('contextmenu', noMenu);
  document.addEventListener('gesturestart', noMenu);

  // ---- touchpad ----
  var SWIPE = 30, STEP = 45, TAP_MS = 250, TAP_MOVE = 10, EDGE = 0.22;
  var pad = $('pad'), glow = $('glow'), rip = $('ripple'), P = null;
  function moveGlow(x, y) { glow.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }
  function endPad() { P = null; pad.classList.remove('down'); }
  function pulse(x, y) {
    rip.style.left = x + 'px'; rip.style.top = y + 'px';
    if (rip.animate) rip.animate([{ opacity: 0.6, transform: 'scale(.2)' }, { opacity: 0, transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  function tapKey(p, x, y) {
    var fx = (x - p.r.left) / p.r.width, fy = (y - p.r.top) / p.r.height;
    var edge = fx < EDGE || fx > 1 - EDGE || fy < EDGE || fy > 1 - EDGE;
    if (!edge) return 'KEY_ENTER';
    if (Math.abs(fx - 0.5) > Math.abs(fy - 0.5)) return fx > 0.5 ? 'KEY_RIGHT' : 'KEY_LEFT';
    return fy > 0.5 ? 'KEY_DOWN' : 'KEY_UP';
  }
  pad.addEventListener('pointerdown', function (e) {
    if (P || (e.pointerType === 'mouse' && e.button !== 0)) return;
    var r = pad.getBoundingClientRect();
    P = { id: e.pointerId, x0: e.clientX, y0: e.clientY, ax: e.clientX, ay: e.clientY, t0: e.timeStamp, maxMove: 0, swiped: false, r: r };
    try { pad.setPointerCapture(e.pointerId); } catch (x) {}
    moveGlow(e.clientX - r.left, e.clientY - r.top);
    pad.classList.add('down');
  });
  pad.addEventListener('pointermove', function (e) {
    if (!P || e.pointerId !== P.id) return;
    var x = e.clientX, y = e.clientY;
    moveGlow(x - P.r.left, y - P.r.top);
    var m = Math.hypot(x - P.x0, y - P.y0); if (m > P.maxMove) P.maxMove = m;
    var dx = x - P.ax, dy = y - P.ay, adx = Math.abs(dx), ady = Math.abs(dy), need = P.swiped ? STEP : SWIPE;
    if (Math.max(adx, ady) < need) return;
    P.swiped = true;
    if (adx > ady) { P.ax += dx > 0 ? need : -need; P.ay = y; sendKey(dx > 0 ? 'KEY_RIGHT' : 'KEY_LEFT'); }
    else { P.ay += dy > 0 ? need : -need; P.ax = x; sendKey(dy > 0 ? 'KEY_DOWN' : 'KEY_UP'); }
  });
  pad.addEventListener('pointerup', function (e) {
    if (!P || e.pointerId !== P.id) return;
    var p = P; endPad();
    if (!p.swiped && p.maxMove < TAP_MOVE && e.timeStamp - p.t0 < TAP_MS) {
      pulse(e.clientX - p.r.left, e.clientY - p.r.top);
      sendKey(tapKey(p, e.clientX, e.clientY));
    }
  });
  pad.addEventListener('touchend', iosTap);
  pad.addEventListener('pointercancel', endPad);
  pad.addEventListener('lostpointercapture', function () { if (P) endPad(); });

  // ---- settings sheet ----
  var sheet = $('sheet');
  function openSheet(open) {
    sheet.classList.toggle('open', open);
    sheet.inert = !open;
    sheet.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) { $('ip').value = tvIp; $('label').value = lsGet(K.label) || DEF_LABEL; $('ipErr').textContent = ''; $('ip').classList.remove('bad'); }
  }
  function saveIp() {
    var v = $('ip').value.trim(), bad = !IPV4.test(v);
    $('ipErr').textContent = bad ? 'Enter a valid IPv4 address, e.g. ' + DEF_IP : '';
    $('ip').classList.toggle('bad', bad);
    if (bad) return false;
    if (v !== tvIp) {
      tvIp = v; lsSet(K.ip, v); updateTrust(); disconnect();
      log('TV IP set to ' + v + ' - tap Connect');
    }
    return true;
  }
  function saveLabel() { lsSet(K.label, $('label').value.trim() || DEF_LABEL); }
  function manualConnect() {
    saveLabel();
    if (!saveIp()) return false;
    disconnect(); connect(false);
    return true;
  }
  $('done').addEventListener('click', function () { saveLabel(); saveIp(); openSheet(false); });
  $('backdrop').addEventListener('click', function () { saveLabel(); saveIp(); openSheet(false); });
  $('ip').addEventListener('change', saveIp);
  $('label').addEventListener('change', saveLabel);
  $('reconnect').addEventListener('click', function () { if (manualConnect()) openSheet(false); });
  $('obConnect').addEventListener('click', manualConnect);
  $('forget').addEventListener('click', function () {
    if (!window.confirm('Forget pairing? You will need to press Allow on the TV again.')) return;
    lsDel(K.token); lsDel(K.done); queued = null;
    log('Pairing forgotten (token cleared)');
    disconnect(); refreshUi(); openSheet(false);
  });
  $('hapticTest').addEventListener('click', function () { haptic(); iosTap(); log('Vibration test fired (' + (canVibrate ? 'vibrate' : 'iOS switch') + ')'); });
  $('hapticTog').checked = hapticOn;
  $('hapticTog').addEventListener('change', function () {
    hapticOn = this.checked; lsSet(K.haptic, hapticOn ? '1' : '0');
    haptic(); iosTap();
  });

  // ---- lifecycle ----
  document.addEventListener('visibilitychange', function () {
    if (visible()) resume();
    else { clearRetryTimer(); release(); }
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) resume(); });
  window.addEventListener('blur', release);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) { log('Service worker not registered: ' + e, 'hint'); });
    });
  }

  // ---- init ----
  $('ip').value = tvIp;
  $('label').value = lsGet(K.label) || DEF_LABEL;
  updateTrust(); refreshUi(); setState('disconnected'); setScreenOff(screenOff);
  log('Page loaded. UA: ' + navigator.userAgent.slice(0, 90));
  if (hasToken() && visible()) { retry = true; connect(true); }
})();
