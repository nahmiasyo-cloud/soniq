/* SONIQ drum kit: a playable kit seen from the drummer's seat.
   Sounds: Karoryfer Big Rusty Drums (CC0), loaded from sounds/drum-pad-mp3.js.
   Low latency: plays on pointerdown (not click), one finger per pointer, each sample starts past the MP3 encoder's silent lead,
   a hit makes only two audio nodes. Samples decode one by one, loud layers first, so the page never freezes.
   A hit that cannot sound this instant (sound still asleep, sample still decoding) plays the moment it can.
   iPhone: sound may only start from a finished touch, so until it runs every touchend / click tries again.
   Accessible: every drum is a real button with a name; Enter or Space plays the focused drum,
   letter keys play the whole kit (they follow the key's place on the keyboard, so Hebrew layout works too).
   mount(host, { audio, dest, T }) — audio() returns the app's AudioContext, dest() the node to play into. */
(function () {
  'use strict';
  // x, y: centre in % of the stage; d: diameter in % of the stage width. The stage is 2:1.
  const PADS = [
    { id: 'hh-open',   name: 'הייהט פתוח', kind: 'cym', x: 8,  y: 26, d: 13, key: 'KeyQ', pan: -0.4 },
    { id: 'crash',     name: 'קראש',       kind: 'cym', x: 25, y: 20, d: 18, key: 'KeyW', pan: -0.3 },
    { id: 'tom-hi',    name: 'טום גבוה',   kind: 'drum', x: 43, y: 24, d: 14, key: 'KeyE', pan: -0.1 },
    { id: 'tom-mid',   name: 'טום אמצעי',  kind: 'drum', x: 59, y: 24, d: 15, key: 'KeyR', pan: 0.1 },
    { id: 'ride',      name: 'רייד',       kind: 'cym', x: 83, y: 26, d: 22, key: 'KeyT', pan: 0.35, bell: 0.3 },
    { id: 'hh-closed', name: 'הייהט סגור', kind: 'cym', x: 11, y: 66, d: 16, key: 'KeyA', pan: -0.4, hat: true },
    { id: 'snare',     name: 'סנר',        kind: 'drum', x: 31, y: 64, d: 17, key: 'KeyS', pan: -0.12, rim: 0.82 },
    { id: 'kick',      name: 'בס דראם',    kind: 'kick', x: 52, y: 77, d: 22, key: 'KeyB', pan: 0, alt: 'KeyV' },
    { id: 'tom-floor', name: 'טום רצפה',   kind: 'drum', x: 78, y: 70, d: 20, key: 'KeyF', pan: 0.28 },
    { id: 'hh-pedal',  name: 'פדל הייהט',  kind: 'pedal', x: 11, y: 92, d: 12, key: 'KeyZ', pan: -0.4, hat: true }
  ];
  const keyLabel = code => code.replace('Key', '');
  // decode order: the drums a first tap is most likely to land on, loud layer before soft
  const FIRST = ['kick', 'snare', 'hh-closed', 'hh-pedal', 'hh-open', 'crash', 'ride', 'tom-hi', 'tom-mid', 'tom-floor', 'ride-bell', 'rimshot'];
  const rank = k => { const i = FIRST.indexOf(k.replace(/^dk-|-soft$/g, '')); return (i < 0 ? 50 : i) + (/-soft$/.test(k) ? 100 : 0); };
  const buf = {}, pend = {}; let script = null, all = null;

  function b64ToBuf(uri) {
    const b64 = uri.slice(uri.indexOf(',') + 1);
    if (Uint8Array.fromBase64) { try { return Uint8Array.fromBase64(b64).buffer; } catch (e) { /* use the loop below */ } }
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }
  // where the sound really starts: past the encoder's silence (browsers trim different amounts of it; measuring covers them all)
  function leadOf(b) {
    const d = b.getChannelData(0), n = Math.min(d.length, Math.floor(b.sampleRate * 0.3)); let pk = 0;
    for (let i = 0; i < n; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; }
    const th = pk * 0.02; let i = 0;
    while (i < n && Math.abs(d[i]) < th) i++;
    return i >= n ? 0 : Math.max(0, i / b.sampleRate - 0.0005);
  }
  function decode(ac, data) {
    return new Promise(res => {
      let done = false; const ok = b => { if (done) return; done = true; b.lead = leadOf(b); res(b); }, no = () => { if (!done) { done = true; res(null); } };
      try { const p = ac.decodeAudioData(b64ToBuf(data), ok, no); if (p && p.then) p.then(ok, no); } catch (e) { no(); }
    });
  }
  // a load that failed (offline) is forgotten, so opening the kit again tries again
  function loadScript(src) {
    if (window.SONIQ_PADKIT) return Promise.resolve(true);
    if (!script) script = new Promise(res => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = () => res(!!window.SONIQ_PADKIT); s.onerror = () => { s.remove(); res(false); };
      document.head.appendChild(s);
    }).then(ok => { if (!ok) script = null; return ok; });
    return script;
  }
  // one sample, decoded once and shared; null when it cannot be had right now
  function want(ac, src, k) {
    if (buf[k]) return Promise.resolve(buf[k]);
    return pend[k] || (pend[k] = loadScript(src).then(ok => { const d = ok && window.SONIQ_PADKIT[k]; return d ? decode(ac, d) : null; })
      .then(b => { delete pend[k]; if (b) buf[k] = b; return b; }));
  }
  // the whole kit, one sample after the other: the page stays free to answer touches in between,
  // and the kit is playable after the first few samples instead of after all of them
  function loadAll(ac, src) {
    return all || (all = loadScript(src).then(async ok => {
      if (ok) for (const k of Object.keys(window.SONIQ_PADKIT).sort((x, y) => rank(x) - rank(y))) await want(ac, src, k);
      all = null; return Object.keys(buf).length;
    }));
  }

  function mount(host, opt) {
    const T = opt.T || (s => s), audio = opt.audio, src = opt.src || 'sounds/drum-pad-mp3.js';
    let ac = null, kitBus = null, sess = null, armed = false, stuck = false, lastCT = -1, lastAt = 0, waiting = [];
    const voices = {}, outs = {}; // pad id -> playing voices (for choke and the voice cap), pad id -> its output node
    // the kit is on screen (a fixed full-screen box has no offsetParent, so ask for that case by name)
    const live = () => root.isConnected && (root.offsetParent !== null || root.classList.contains('is-full'));

    function graph() {
      ac = audio(); if (!ac) return null;
      if (!kitBus) {
        kitBus = ac.createGain(); kitBus.gain.value = 0.9; kitBus.connect(opt.dest ? opt.dest() : ac.destination);
        // one panner per drum, made once: a hit then only needs a source and a gain
        PADS.forEach(p => { let o = kitBus; if (p.pan && ac.createStereoPanner) { o = ac.createStereoPanner(); o.pan.value = p.pan; o.connect(kitBus); } outs[p.id] = o; });
        ac.addEventListener('statechange', onState); onState();
      }
      return ac;
    }
    function wake() {
      const a = graph(); if (!a) return null;
      // iPhone: play even with the silent switch on, like any music app. stop() puts the old value back,
      // because "playback" ends a running microphone (the tuner)
      try { const as = navigator.audioSession; if (as && as.type !== 'playback') { if (sess == null) sess = as.type; as.type = 'playback'; } } catch (e) { /* not supported */ }
      const now = performance.now();
      if (a.state !== 'running') { try { const p = a.resume(); if (p && p.then) p.then(flush, () => {}); } catch (e) { /* not allowed yet */ } return a; }
      if (!stuck && a.currentTime === lastCT && now - lastAt > 400) {
        // iPhone, back from another app or a call: the context says "running" but its clock stands still. Restart it.
        stuck = true; const go = () => { stuck = false; flush(); };
        try { a.suspend().then(() => a.resume()).then(go, go); } catch (e) { go(); }
      }
      lastCT = a.currentTime; lastAt = now;
      return a;
    }
    // iPhone lets sound start only from a finished touch (touchend, click), not from the finger landing.
    // While the context is not running, every such moment tries again and plays one silent sample to open the output.
    const ENDS = ['pointerup', 'touchend', 'click', 'keydown'];
    function unlock() {
      if (!live()) return;
      const a = wake(); if (!a || a.state === 'running') return;
      try { const s = a.createBufferSource(); s.buffer = a.createBuffer(1, 1, 22050); s.connect(a.destination); s.start(0); } catch (e) { /* ignore */ }
    }
    function arm(on) {
      if (on === armed) return; armed = on;
      ENDS.forEach(t => on ? document.addEventListener(t, unlock, { capture: true, passive: true }) : document.removeEventListener(t, unlock, true));
    }
    function onState() { if (ac.state === 'running') { arm(false); flush(); } else arm(true); }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && ac && live()) wake(); });

    // fade a voice out and stop it. The gain is known, so nothing is read back from the node (that can click in Safari),
    // and a voice is never faded twice
    function stopVoice(v, fade) {
      if (v.dead) return; v.dead = true; const at = ac.currentTime;
      try { v.g.gain.setValueAtTime(v.gain, at); v.g.gain.linearRampToValueAtTime(0, at + fade); v.src.stop(at + fade + 0.01); } catch (e) { /* already stopped */ }
    }
    // w: { pad, key, base, gain, at }. false = cannot sound yet
    function fire(w) {
      if (!ac || ac.state !== 'running' || stuck) return false;
      const b = buf[w.key] || buf[w.base]; if (!b) return false; // the soft layer may still be decoding: the loud one, played quietly, is better than a wait
      const id = w.pad.id, s = ac.createBufferSource(), g = ac.createGain(); s.buffer = b; g.gain.value = w.gain;
      s.connect(g); g.connect(outs[id]); s.start(0, b.lead || 0);
      // a closed hat or the pedal closes the open hat: 30 ms is fast enough to feel shut and slow enough not to click
      if (w.pad.hat) (voices['hh-open'] || []).forEach(v => stopVoice(v, 0.03));
      const list = voices[id] || (voices[id] = []), v = { src: s, g, gain: w.gain };
      list.push(v);
      s.onended = () => { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); try { s.disconnect(); g.disconnect(); } catch (e) { /* gone */ } };
      // cymbals ring long, so a fast ride pattern keeps more of them before the oldest is faded
      if (list.length > (w.pad.kind === 'cym' ? 6 : 4)) stopVoice(list.shift(), 0.05);
      return true;
    }
    // hits that could not sound at once: each plays the moment the context runs and its sample is decoded,
    // and is dropped when it has become too old to belong to the tap
    function flush() { const now = performance.now(); waiting = waiting.filter(w => now - w.at < 600 && !fire(w)); }
    // r: 0 at the centre of the drum, 1 at its edge. null = keyboard or screen reader
    function hit(pad, r) {
      if (!wake()) return;
      let hard = r == null || r < 0.6, gain = r == null ? 0.92 : 1 - 0.38 * r * r;
      let name = pad.id;
      if (pad.rim && r != null && r > pad.rim) { name = 'rimshot'; hard = true; gain = 0.95; }
      if (pad.bell && r != null && r < pad.bell) name = 'ride-bell';
      const base = 'dk-' + name, w = { pad, key: base + (hard ? '' : '-soft'), base, gain, at: performance.now() };
      if (!fire(w)) {
        waiting = waiting.filter(x => x.pad !== pad); waiting.push(w); // one waiting hit per drum: a burst of the same sample would only be louder
        if (!buf[base]) want(ac, src, base).then(flush);
      }
      flash(pad);
    }

    /* ---------- the stage ---------- */
    host.textContent = '';
    const root = el('div', 'dk');
    const stage = el('div', 'dk-stage'); stage.setAttribute('dir', 'ltr'); stage.setAttribute('role', 'group'); stage.setAttribute('aria-label', T('מערכת תופים'));
    const btns = {};
    PADS.forEach(p => {
      const b = el('button', 'dk-pad dk-' + p.kind + ' dk-' + p.id);
      b.type = 'button'; b.dataset.pad = p.id;
      b.style.left = (p.x - p.d / 2) + '%'; b.style.top = 'calc(' + p.y + '% - ' + (p.kind === 'pedal' ? p.d / 5 : p.d / 2) + 'cqw)'; b.style.width = p.d + '%';
      b.setAttribute('aria-label', T(p.name) + ', ' + T('מקש') + ' ' + keyLabel(p.key));
      b.setAttribute('aria-keyshortcuts', keyLabel(p.key));
      const face = el('span', 'dk-face'); face.setAttribute('aria-hidden', 'true');
      if (p.kind === 'kick') { const logo = el('span', 'dk-logo'); logo.textContent = 'SONIQ'; face.appendChild(logo); }
      if (p.bell) face.appendChild(el('span', 'dk-bell'));
      b.appendChild(face);
      const lab = el('span', 'dk-name'); lab.setAttribute('aria-hidden', 'true'); lab.textContent = T(p.name); b.appendChild(lab);
      const kb = el('span', 'dk-key'); kb.setAttribute('aria-hidden', 'true'); kb.textContent = keyLabel(p.key); b.appendChild(kb);
      stage.appendChild(b); btns[p.id] = b;
    });
    root.appendChild(stage);

    const bar = el('div', 'dk-bar');
    const full = el('button', 'dk-full'); full.type = 'button'; full.setAttribute('aria-pressed', 'false');
    full.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span></span>';
    const fullLbl = full.querySelector('span');
    const status = el('p', 'status-line dk-status'); status.setAttribute('role', 'status');
    const tip = el('p', 'desc dk-tip');
    tip.textContent = T('מכה במרכז חזקה יותר, בקצה רכה יותר. בקצה הסנר יש רים-שוט, ובמרכז הרייד הפעמון.');
    bar.appendChild(full); root.appendChild(bar); root.appendChild(tip); root.appendChild(status);
    host.appendChild(root);

    function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    function flash(p) {
      const b = btns[p.id]; if (!b) return;
      b.classList.add('hit'); // the pressed look has no animation to restart, so no layout is forced here
      clearTimeout(b._t); b._t = setTimeout(() => b.classList.remove('hit'), reduce ? 120 : 180);
    }

    /* ---------- input ---------- */
    const byId = id => PADS.find(p => p.id === id);
    // the last finger, mouse or key event on a drum: the click the browser sends after it is the same hit, not a new one
    let lastIn = -1e9;
    const mark = () => { lastIn = performance.now(); };
    stage.addEventListener('pointerdown', e => {
      const b = e.target.closest('.dk-pad'); if (!b || e.button !== 0) return; // left button, finger or pen tip only
      e.preventDefault(); mark();
      const r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // a circle stays a circle when the stage is turned, so the distance works in every orientation
      const dist = Math.min(1, Math.hypot(e.clientX - cx, e.clientY - cy) / (Math.max(r.width, r.height) / 2));
      hit(byId(b.dataset.pad), dist);
    });
    // a long press ends long after it began: count from the lift too, so its click is still known as the same hit
    stage.addEventListener('pointerup', mark); stage.addEventListener('pointercancel', mark);
    // screen readers, switch and voice control send a click with no finger before it
    stage.addEventListener('click', e => {
      const b = e.target.closest('.dk-pad'); if (!b || performance.now() - lastIn < 700) return;
      hit(byId(b.dataset.pad), null);
    });
    const isPress = e => e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
    stage.addEventListener('keydown', e => {
      const b = e.target.closest('.dk-pad'); if (!b || !isPress(e)) return;
      e.preventDefault(); mark(); if (!e.repeat) hit(byId(b.dataset.pad), null);
    });
    // Space clicks a button when the key comes up: stop that, the drum already played when it went down
    stage.addEventListener('keyup', e => { if (e.target.closest('.dk-pad') && isPress(e)) { e.preventDefault(); mark(); } });
    stage.addEventListener('contextmenu', e => e.preventDefault());
    // letter keys play the kit while it is on screen; typing in a field is left alone
    function onKey(e) {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.defaultPrevented || !live()) return;
      const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'Escape' && root.classList.contains('is-full')) { setFull(false); return; }
      const p = PADS.find(x => x.key === e.code || x.alt === e.code); if (!p) return;
      e.preventDefault(); hit(p, null);
    }
    document.addEventListener('keydown', onKey);

    /* ---------- full screen, sideways ---------- */
    let back = null;
    function setFull(on) {
      root.classList.toggle('is-full', on); document.documentElement.classList.toggle('dk-locked', on);
      full.setAttribute('aria-pressed', String(on));
      fullLbl.textContent = on ? T('יציאה ממסך מלא') : T('מסך מלא');
      if (on) {
        back = document.activeElement;
        const fe = root.requestFullscreen || root.webkitRequestFullscreen;
        if (fe) { try { const p = fe.call(root); if (p && p.then) p.then(lock, () => {}); else lock(); } catch (e) { /* not allowed */ } }
        say(T('מסך מלא. Escape או הכפתור יוצאים.'));
        full.focus();
      } else {
        const ex = document.exitFullscreen || document.webkitExitFullscreen;
        if (document.fullscreenElement || document.webkitFullscreenElement) { try { ex.call(document); } catch (e) { /* ignore */ } }
        try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (e) { /* ignore */ }
        if (back && back.focus) back.focus();
      }
    }
    function lock() { try { screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* ignore */ } }
    full.addEventListener('click', () => setFull(!root.classList.contains('is-full')));
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && root.classList.contains('is-full')) setFull(false); });
    fullLbl.textContent = T('מסך מלא');
    function say(t) { status.textContent = ''; setTimeout(() => { status.textContent = t; }, 40); }

    // decode now, so the first hit is already instant; and try to wake the sound while the tab's click still counts as a touch
    function prepare() {
      const a = wake(); if (!a) { say(T('הדפדפן הזה לא תומך בצליל.')); return; }
      if (window.SONIQ_PADKIT && Object.keys(window.SONIQ_PADKIT).every(k => buf[k])) return;
      say(T('מכין צלילים…'));
      loadAll(a, src).then(n => say(n > 0 ? T('התופים מוכנים. נגנו!') : T('הצלילים לא נטענו. בדקו את החיבור ונסו שוב.')));
    }
    // leaving the kit: out of full screen, nothing left waiting, and the phone's audio mode as it was
    function stop() {
      if (root.classList.contains('is-full')) setFull(false);
      waiting = [];
      try { if (sess != null) { navigator.audioSession.type = sess; sess = null; } } catch (e) { /* not supported */ }
    }
    // for measuring on a real phone: the delay the browser itself reports, in milliseconds
    const latency = () => ac ? { state: ac.state, rate: ac.sampleRate, base: Math.round((ac.baseLatency || 0) * 1000), output: Math.round((ac.outputLatency || 0) * 1000) } : null;
    return { prepare, stop, latency };
  }
  window.SoniqDrums = { mount, PADS };
})();
