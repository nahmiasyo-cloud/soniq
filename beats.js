/* SONIQ beats: 16 pads, a 16-step sequencer and a one-shot sampler, for hip-hop and electronic music.
   Sounds: CC0 recordings (Sonic Pi bundled samples, VCSL, Karoryfer Big Rusty Drums), loaded from sounds/beats-<kit>-mp3.js.
   Pads use the drum kit's low-latency recipe: play on pointerdown, one finger per pointer, start past the MP3 encoder's silence,
   two audio nodes per hit, samples decoded one by one, iPhone unlock on every finished touch, a restart when the clock stands still.
   Timing: a lookahead scheduler. A timer only wakes the scheduler; every note is started by the audio clock (ac.currentTime),
   so steps stay even when the page is busy. In a background tab timers slow down, so the scheduler looks further ahead there.
   The playhead follows what is heard: audio time minus the output delay the browser reports.
   Recording your own sound: the microphone opens for up to 3 seconds with the phone's voice processing off, the silence before
   the sound is cut, the level is normalised, and the pad plays it. Recordings stay in IndexedDB on this device.
   Accessible: every control is a native button or input with a name; steps are toggle buttons ("Kick, step 5") in a grid
   with arrow keys; a status line announces play, stop, tempo and recording; nothing depends on colour or motion alone.
   mount(host, { audio, dest, T }) — audio() returns the app's AudioContext, dest() the node to play into. */
(function () {
  'use strict';
  // pad 1 is bottom left, like on a pad sampler; the four key rows lie the same way as the four pad rows
  const KEYS = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'Digit1', 'Digit2', 'Digit3', 'Digit4'];
  const keyLabel = code => code.replace(/Key|Digit/, '');
  const KITS = {
    hiphop: { name: 'היפ-הופ', src: 'sounds/beats-hiphop-mp3.js', pads: [
      ['kick', 'קיק'], ['snare', 'סנר'], ['chh', 'הייהט סגור'], ['ohh', 'הייהט פתוח'],
      ['808', '808'], ['clap', 'קלאפ'], ['rim', 'רים'], ['snap', 'נקישת אצבעות'],
      ['kick2', 'קיק 2'], ['snare2', 'סנר 2'], ['shaker', 'שייקר'], ['tamb', 'טמבורין'],
      ['crash', 'קראש'], ['cowbell', 'קאובל'], ['scratch', "סקרץ'"], ['spin', 'סיבוב תקליט']] },
    electro: { name: 'אלקטרוני', src: 'sounds/beats-electro-mp3.js', pads: [
      ['kick', 'קיק'], ['snare', 'סנר'], ['chh', 'הייהט סגור'], ['ohh', 'הייהט פתוח'],
      ['808', '808'], ['clap', 'קלאפ'], ['rim', 'רים'], ['kick2', 'קיק 2'],
      ['tom', 'טום'], ['cowbell', 'קאובל'], ['cymbal', 'מצילה'], ['blip', 'בליפ'],
      ['crash', 'קראש'], ['snare2', 'סנר 2'], ['bass', 'בס'], ['glitch', "גליץ'"]] }
  };
  const STEPS = 16, MAX_REC = 3, STORE = 'soniq-beats';
  const buf = {}, pend = {}, scripts = {};

  function b64ToBuf(uri) {
    const b64 = uri.slice(uri.indexOf(',') + 1);
    if (Uint8Array.fromBase64) { try { return Uint8Array.fromBase64(b64).buffer; } catch (e) { /* use the loop below */ } }
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }
  // where the sound really starts: past the encoder's silence
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
  const have = kit => window.SONIQ_BEATS && window.SONIQ_BEATS[kit];
  // a load that failed (offline) is forgotten, so the next try starts again
  function loadScript(kit) {
    if (have(kit)) return Promise.resolve(true);
    if (!scripts[kit]) scripts[kit] = new Promise(res => {
      const s = document.createElement('script'); s.src = KITS[kit].src; s.async = true;
      s.onload = () => res(!!have(kit)); s.onerror = () => { s.remove(); res(false); };
      document.head.appendChild(s);
    }).then(ok => { if (!ok) scripts[kit] = null; return ok; });
    return scripts[kit];
  }
  function want(ac, kit, id) {
    const k = kit + ':' + id;
    if (buf[k]) return Promise.resolve(buf[k]);
    return pend[k] || (pend[k] = loadScript(kit).then(ok => { const d = ok && window.SONIQ_BEATS[kit][id]; return d ? decode(ac, d) : null; })
      .then(b => { delete pend[k]; if (b) buf[k] = b; return b; }));
  }
  // the whole kit, one sample after the other, in pad order (kick, snare and hats first)
  async function loadKit(ac, kit) {
    if (!(await loadScript(kit))) return 0;
    let n = 0; for (const [id] of KITS[kit].pads) if (await want(ac, kit, id)) n++;
    return n;
  }

  /* recordings on this device */
  function idb() {
    return new Promise(res => {
      try {
        const r = indexedDB.open(STORE, 1);
        r.onupgradeneeded = () => { try { r.result.createObjectStore('rec'); } catch (e) { /* exists */ } };
        r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null);
      } catch (e) { res(null); }
    });
  }
  function idbDo(mode, fn) {
    return idb().then(db => new Promise(res => {
      if (!db) return res(null);
      try { const tx = db.transaction('rec', mode), rq = fn(tx.objectStore('rec')); tx.oncomplete = () => { res(rq && rq.result); db.close(); }; tx.onerror = tx.onabort = () => { res(null); db.close(); }; }
      catch (e) { res(null); }
    }));
  }
  // cut the silence before the sound and after it, bring the peak to full level. null = nothing was heard
  function shape(x, rate) {
    let pk = 0, sum = 0; for (let i = 0; i < x.length; i++) sum += x[i];
    const dc = x.length ? sum / x.length : 0;
    for (let i = 0; i < x.length; i++) { x[i] -= dc; const v = Math.abs(x[i]); if (v > pk) pk = v; }
    if (pk < 0.004) return null;
    let a = 0; const th = pk * 0.1; while (a < x.length && Math.abs(x[a]) < th) a++;
    a = Math.max(0, a - Math.floor(rate * 0.003));
    let b = x.length - 1; const tl = pk * 0.02; while (b > a && Math.abs(x[b]) < tl) b--;
    b = Math.min(x.length, b + Math.floor(rate * 0.03));
    if (b - a < rate * 0.02) return null;
    const y = x.slice(a, b), g = Math.min(40, 0.9 / pk), fi = Math.min(y.length, Math.floor(rate * 0.002)), fo = Math.min(y.length, Math.floor(rate * 0.02));
    for (let i = 0; i < y.length; i++) y[i] *= g;
    for (let i = 0; i < fi; i++) y[i] *= i / fi;
    for (let i = 0; i < fo; i++) y[y.length - 1 - i] *= i / fo;
    return y;
  }

  function mount(host, opt) {
    const T = opt.T || (s => s), audio = opt.audio;
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let kit = 'hiphop', sel = 0, bpm = 90, swing = 0;
    let pat = Array.from({ length: 16 }, () => new Array(STEPS).fill(0));
    // a first beat to press play on: kick, snare and hats
    [[0, [0, 7, 10]], [1, [4, 12]], [2, [0, 2, 4, 6, 8, 10, 12, 14]]].forEach(([p, ss]) => ss.forEach(s => { pat[p][s] = 1; }));
    try {
      const o = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (o && o.v === 1) {
        if (KITS[o.kit]) kit = o.kit;
        if (o.bpm >= 60 && o.bpm <= 180) bpm = Math.round(o.bpm);
        if (o.swing >= 0 && o.swing <= 60) swing = Math.round(o.swing);
        if (Array.isArray(o.pat) && o.pat.length === 16) pat = o.pat.map(r => Array.from({ length: STEPS }, (_, i) => String(r)[i] === '1' ? 1 : 0));
        if (o.sel >= 0 && o.sel < 16) sel = o.sel | 0;
      }
    } catch (e) { /* no storage, or an old shape: start fresh */ }
    function save() {
      try { localStorage.setItem(STORE, JSON.stringify({ v: 1, kit, bpm, swing, sel, pat: pat.map(r => r.join('')) })); } catch (e) { /* no storage */ }
    }

    let ac = null, kitBus = null, sess = null, armed = false, stuck = false, lastCT = -1, lastAt = 0, waiting = [];
    const voices = {};               // pad index -> voices that sound or are about to
    const userPcm = {}, userBuf = {}; // 'kit:pad' -> the player's own recording
    const live = () => root.isConnected && (root.offsetParent !== null || root.classList.contains('is-full'));
    const pads = () => KITS[kit].pads;
    const padName = i => T(pads()[i][1]);

    function graph() {
      ac = audio(); if (!ac) return null;
      if (!kitBus) {
        kitBus = ac.createGain(); kitBus.gain.value = 0.9; kitBus.connect(opt.dest ? opt.dest() : ac.destination);
        ac.addEventListener('statechange', onState); onState();
      }
      return ac;
    }
    // iPhone: 'playback' sounds with the silent switch on; recording needs 'play-and-record'. The first value is kept for stop()
    function session(type) {
      try { const as = navigator.audioSession; if (as && as.type !== type) { if (sess == null) sess = as.type; as.type = type; } } catch (e) { /* not supported */ }
    }
    function wake() {
      const a = graph(); if (!a) return null;
      if (!rec) session('playback');
      const now = performance.now();
      if (a.state !== 'running') { try { const p = a.resume(); if (p && p.then) p.then(flush, () => {}); } catch (e) { /* not allowed yet */ } return a; }
      if (!stuck && a.currentTime === lastCT && now - lastAt > 400) {
        // iPhone, back from another app: the context says "running" but its clock stands still. Restart it.
        stuck = true; const go = () => { stuck = false; flush(); };
        try { a.suspend().then(() => a.resume()).then(go, go); } catch (e) { go(); }
      }
      lastCT = a.currentTime; lastAt = now;
      return a;
    }
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

    function stopVoice(v, fade, at) {
      if (v.dead) return; v.dead = true; const t = Math.max(at || 0, ac.currentTime);
      try { v.g.gain.setValueAtTime(v.gain, t); v.g.gain.linearRampToValueAtTime(0, t + fade); v.src.stop(t + fade + 0.01); } catch (e) { /* already stopped */ }
    }
    function bufferOf(i) {
      const u = kit + ':' + i;
      if (userPcm[u]) {
        if (!userBuf[u]) { try { const p = userPcm[u], b = ac.createBuffer(1, p.pcm.length, p.rate); b.getChannelData(0).set(p.pcm); b.lead = 0; userBuf[u] = b; } catch (e) { delete userPcm[u]; } }
        if (userBuf[u]) return userBuf[u];
      }
      return buf[kit + ':' + pads()[i][0]];
    }
    // w: { i, gain, at (performance time of the tap), when (audio time, 0 = now) }. Returns the voice, or null when it cannot sound yet
    function fire(w) {
      if (!ac || ac.state !== 'running' || stuck) return null;
      const b = bufferOf(w.i); if (!b) return null;
      const s = ac.createBufferSource(), g = ac.createGain(), t = w.when || 0; s.buffer = b; g.gain.value = w.gain;
      s.connect(g); g.connect(kitBus); s.start(t, b.lead || 0);
      const start = t || ac.currentTime;
      // the closed hat shuts the open one
      if (pads()[w.i][0] === 'chh') { const oi = pads().findIndex(p => p[0] === 'ohh'); (voices[oi] || []).forEach(v => { if (v.t <= start) stopVoice(v, 0.03, start); }); }
      const list = voices[w.i] || (voices[w.i] = []), v = { src: s, g, gain: w.gain, t: start };
      list.push(v);
      s.onended = () => { const k = list.indexOf(v); if (k >= 0) list.splice(k, 1); try { s.disconnect(); g.disconnect(); } catch (e) { /* gone */ } };
      if (list.length > 6) stopVoice(list.shift(), 0.04, start);
      return v;
    }
    function flush() { const now = performance.now(); waiting = waiting.filter(w => now - w.at < 600 && !fire(w)); }

    /* ---------- the sequencer clock ---------- */
    let playing = false, recOn = false, timer = 0, raf = 0, nextStep = 0, nextTime = 0, tickNo = 0, head = -1;
    let sched = [];       // the last scheduled steps: { n, step, t, v: { pad: voice } }
    let vis = [];         // steps waiting to be shown
    const muted = new Set();
    const stepDur = () => 60 / bpm / 4;
    // swing moves every second 16th later; 50% lands it on the triplet
    const swingOf = step => (step % 2) ? swing / 100 * (2 / 3) * stepDur() : 0;
    const delay = () => ac ? Math.min(0.3, ac.outputLatency || ac.baseLatency || 0) : 0;
    function click(t, strong) {
      try {
        const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = strong ? 1568 : 1047;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        o.connect(g); g.connect(kitBus); o.start(t); o.stop(t + 0.06);
      } catch (e) { /* ignore */ }
    }
    function pump() {
      if (!playing || !ac) return;
      const hidden = document.hidden, ahead = hidden ? 1.6 : 0.12;
      if (ac.state === 'running' && !stuck) {
        // after a long sleep (phone locked) do not replay the missed bars: start again from now
        if (nextTime < ac.currentTime - 0.2) nextTime = ac.currentTime + 0.05;
        while (nextTime < ac.currentTime + ahead) {
          const t = nextTime + swingOf(nextStep), e = { n: tickNo, step: nextStep, t, v: {} };
          for (let i = 0; i < 16; i++) if (pat[i][nextStep] && !muted.has(i + ':' + tickNo)) { const v = fire({ i, gain: 0.9, when: t }); if (v) e.v[i] = v; }
          muted.forEach(k => { if (+k.split(':')[1] <= tickNo) muted.delete(k); });
          if (recOn && nextStep % 4 === 0) click(t, nextStep === 0);
          sched.push(e); if (sched.length > 96) sched.shift();
          vis.push(e);
          nextTime += stepDur(); nextStep = (nextStep + 1) % STEPS; tickNo++;
        }
      } else wake();
      timer = setTimeout(pump, hidden ? 250 : 25);
    }
    function draw() {
      if (!playing) return;
      const now = ac.currentTime - delay(); let e = null;
      while (vis.length && vis[0].t <= now) e = vis.shift();
      if (e) { setHead(e.step); if (!reduce) Object.keys(e.v).forEach(i => flash(+i)); }
      raf = requestAnimationFrame(draw);
    }
    function setHead(s) {
      if (s === head) return; head = s;
      seq.querySelectorAll('.now').forEach(c => c.classList.remove('now'));
      if (s >= 0) seq.querySelectorAll('[data-s="' + s + '"]').forEach(c => c.classList.add('now'));
    }
    function play() {
      if (playing) return; const a = wake(); if (!a) { say(T('הדפדפן הזה לא תומך בצליל.')); return; }
      if (rec) endRec(true);
      playing = true; nextStep = 0; tickNo = 0; sched = []; vis = []; muted.clear(); nextTime = a.currentTime + 0.08;
      paintPlay(); pump(); raf = requestAnimationFrame(draw);
      say(recOn ? T('מנגן ומקליט. נגנו על הפדים.') : T('מנגן.') + ' ' + bpm + ' BPM');
    }
    function halt(quiet) {
      if (!playing) return; playing = false; clearTimeout(timer); cancelAnimationFrame(raf);
      // notes already handed to the audio clock but not yet heard are taken back
      sched.forEach(e => Object.keys(e.v).forEach(i => { const v = e.v[i]; if (v.t > ac.currentTime) stopVoice(v, 0.005); }));
      sched = []; vis = []; muted.clear(); setHead(-1); paintPlay();
      if (!quiet) say(T('נעצר.'));
    }
    document.addEventListener('visibilitychange', () => {
      if (!ac || !live()) return;
      if (!document.hidden) wake();
      if (playing) { clearTimeout(timer); pump(); } // going to the background: fill the longer lookahead now
    });

    // r: 0 centre, 1 edge; null = keyboard or screen reader
    function hit(i, r) {
      if (!wake()) return;
      const w = { i, gain: r == null ? 0.92 : 1 - 0.35 * r * r, at: performance.now() };
      if (playing && recOn && ac.state === 'running') capture(i);
      if (!fire(w)) {
        waiting = waiting.filter(x => x.i !== i); waiting.push(w);
        if (!bufferOf(i)) want(ac, kit, pads()[i][0]).then(flush);
      }
      flash(i); if (i !== sel) select(i);
    }
    // a pad played while recording lands on the nearest 16th of what the player hears
    function capture(i) {
      const tap = ac.currentTime - delay();
      const cands = sched.slice(-8).concat([{ n: tickNo, step: nextStep, t: nextTime + swingOf(nextStep), next: true }]);
      let best = null; cands.forEach(c => { if (!best || Math.abs(c.t - tap) < Math.abs(best.t - tap)) best = c; });
      if (!best) return;
      // the tap itself is the note this time round: the step's own copy stays silent
      if (best.next) muted.add(i + ':' + best.n);
      else if (best.v[i] && best.v[i].t > ac.currentTime) { stopVoice(best.v[i], 0.003); delete best.v[i]; }
      if (!pat[i][best.step]) { pat[i][best.step] = 1; undo = null; save(); renderSeq(); }
    }

    /* ---------- the page ---------- */
    host.textContent = '';
    function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function btn(cls, label, icon) {
      const b = el('button', cls); b.type = 'button';
      if (icon) b.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + icon + '</svg>';
      b.appendChild(el('span', 'bt-lbl', label)); return b;
    }
    const ICON = {
      play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
      rec: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
      clear: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
      back: '<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    };
    const root = el('div', 'bt');
    // a touch screen gets full-size step buttons (the grid then scrolls sideways)
    if (navigator.maxTouchPoints > 0 || (window.matchMedia && matchMedia('(pointer: coarse)').matches)) root.classList.add('is-touch');
    const bar = el('div', 'bt-bar');
    const kits = el('div', 'seg bt-kits'); kits.setAttribute('role', 'group'); kits.setAttribute('aria-label', T('ערכת צלילים'));
    Object.keys(KITS).forEach(k => {
      const b = el('button', '', T(KITS[k].name)); b.type = 'button'; b.dataset.kit = k; b.setAttribute('aria-pressed', String(k === kit));
      b.addEventListener('click', () => setKit(k)); kits.appendChild(b);
    });
    const full = btn('bt-btn bt-full', T('מסך מלא'), ICON.full); full.setAttribute('aria-pressed', 'false');
    bar.appendChild(kits); bar.appendChild(full);

    const body = el('div', 'bt-body');
    const grid = el('div', 'bt-pads'); grid.setAttribute('dir', 'ltr'); grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', T('פדים'));
    const padBtn = [];
    // top row first, so the screen reads like the pads look
    [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3].forEach(i => {
      const b = el('button', 'bt-pad'); b.type = 'button'; b.dataset.pad = i; b.setAttribute('aria-keyshortcuts', keyLabel(KEYS[i]));
      const led = el('span', 'bt-led'), nm = el('span', 'bt-name'), kb = el('span', 'bt-key', keyLabel(KEYS[i])), mine = el('span', 'bt-mine');
      mine.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICON.mic + '</svg>';
      [led, nm, kb, mine].forEach(x => { x.setAttribute('aria-hidden', 'true'); b.appendChild(x); });
      grid.appendChild(b); padBtn[i] = b;
    });

    const ctl = el('div', 'bt-ctl');
    const trans = el('div', 'bt-transport'); trans.setAttribute('role', 'group'); trans.setAttribute('aria-label', T('נגינה והקלטה'));
    const playB = btn('bt-btn bt-play', T('נגן'), ICON.play);
    const recB = btn('bt-btn bt-rec', T('הקלטה חיה'), ICON.rec); recB.setAttribute('aria-pressed', 'false');
    const clearB = btn('bt-btn bt-clear', T('ניקוי התבנית'), ICON.clear);
    trans.appendChild(playB); trans.appendChild(recB); trans.appendChild(clearB);
    let uid = 0;
    function slider(label, min, max, val, fmt, on) {
      const f = el('div', 'bt-field'), id = 'bt-r' + (++uid) + '-' + Math.random().toString(36).slice(2, 7);
      const l = el('label', 'bt-flabel', label); l.htmlFor = id;
      const r = el('input'); r.type = 'range'; r.id = id; r.min = min; r.max = max; r.step = 1; r.value = val;
      const o = el('span', 'bt-out'); o.setAttribute('aria-hidden', 'true'); o.setAttribute('dir', 'ltr');
      const show = () => { o.textContent = fmt(+r.value); r.setAttribute('aria-valuetext', fmt(+r.value)); };
      r.addEventListener('input', () => { show(); on(+r.value, false); });
      r.addEventListener('change', () => on(+r.value, true));
      show(); f.appendChild(l); f.appendChild(r); f.appendChild(o); return f;
    }
    ctl.appendChild(trans);
    ctl.appendChild(slider(T('טמפו'), 60, 180, bpm, v => v + ' BPM', (v, end) => { bpm = v; if (end) { save(); say(T('טמפו') + ' ' + v + ' BPM'); } }));
    ctl.appendChild(slider(T('סווינג'), 0, 60, swing, v => v + '%', (v, end) => { swing = v; if (end) { save(); say(T('סווינג') + ' ' + v + '%'); } }));

    const seqBox = el('div', 'bt-seqbox');
    const seqH = el('h4', 'bt-h', T('סיקוונסר: 16 צעדים')); seqH.id = 'bt-seq-h' + Math.random().toString(36).slice(2, 7);
    const seqTip = el('p', 'desc bt-tip', T('כל שורה היא פד. לחצו על צעד כדי להדליק או לכבות אותו. במקלדת: חיצים זזים בין הצעדים, Enter מדליק.'));
    const wrap = el('div', 'bt-seqwrap'); wrap.setAttribute('dir', 'ltr');
    const seq = el('div', 'bt-seq'); seq.setAttribute('role', 'group'); seq.setAttribute('aria-labelledby', seqH.id);
    wrap.appendChild(seq); seqBox.appendChild(seqH); seqBox.appendChild(seqTip); seqBox.appendChild(wrap);

    const smp = el('div', 'bt-sampler'); smp.setAttribute('role', 'group');
    const smpH = el('h4', 'bt-h', T('הקלטה עצמית')); smpH.id = 'bt-smp-h' + Math.random().toString(36).slice(2, 7); smp.setAttribute('aria-labelledby', smpH.id);
    const smpTip = el('p', 'desc bt-tip', T('בחרו פד, לחצו על הקלטה והשמיעו צליל של עד 3 שניות: קול, מחיאת כף, כלי. הפד ינגן את ההקלטה שלכם.'));
    const smpSel = el('p', 'bt-sel');
    const micB = btn('bt-btn bt-mic', T('הקלטה לפד'), ICON.mic);
    const restB = btn('bt-btn bt-restore', T('שחזור הצליל המקורי'), ICON.back);
    const meter = el('span', 'bt-meter'); meter.setAttribute('aria-hidden', 'true'); meter.appendChild(el('span'));
    const smpRow = el('div', 'bt-transport'); smpRow.appendChild(micB); smpRow.appendChild(restB);
    [smpH, smpTip, smpSel, smpRow, meter].forEach(x => smp.appendChild(x));

    const status = el('p', 'status-line bt-status'); status.setAttribute('role', 'status');
    body.appendChild(grid); body.appendChild(ctl); body.appendChild(seqBox); body.appendChild(smp);
    root.appendChild(bar); root.appendChild(body); root.appendChild(status); host.appendChild(root);

    function say(t) { status.textContent = ''; setTimeout(() => { status.textContent = t; }, 40); }
    function flash(i) {
      const b = padBtn[i]; if (!b) return;
      b.classList.add('hit'); clearTimeout(b._t); b._t = setTimeout(() => b.classList.remove('hit'), reduce ? 120 : 160);
    }
    function paintPads() {
      padBtn.forEach((b, i) => {
        const mine = !!userPcm[kit + ':' + i];
        b.querySelector('.bt-name').textContent = padName(i);
        b.classList.toggle('sel', i === sel); b.classList.toggle('mine', mine);
        b.setAttribute('aria-label', padName(i) + (mine ? ', ' + T('הקלטה שלי') : '') + ', ' + T('מקש') + ' ' + keyLabel(KEYS[i]));
      });
      smpSel.textContent = T('הפד הנבחר:') + ' ' + padName(sel) + (userPcm[kit + ':' + sel] ? ' (' + T('הקלטה שלי') + ')' : '');
      restB.disabled = !userPcm[kit + ':' + sel];
    }
    function paintPlay() {
      playB.querySelector('.bt-lbl').textContent = playing ? T('עצור') : T('נגן');
      playB.querySelector('svg').innerHTML = playing ? ICON.stop : ICON.play;
      playB.classList.toggle('on', playing);
    }
    function select(i) { sel = i; paintPads(); renderSeq(); save(); }

    /* ---------- the step grid ---------- */
    let focusAt = { pad: sel, step: 0 }, undo = null;
    function rowsNow() { const r = []; for (let i = 0; i < 16; i++) if (i === sel || pat[i].some(Boolean)) r.push(i); return r; }
    function renderSeq() {
      const rows = rowsNow(), had = seq.contains(document.activeElement) && document.activeElement.classList.contains('bt-step');
      if (rows.indexOf(focusAt.pad) < 0) focusAt = { pad: sel, step: focusAt.step };
      seq.textContent = '';
      const nums = el('div', 'bt-row bt-nums'); nums.setAttribute('aria-hidden', 'true'); nums.appendChild(el('span', 'bt-rowname'));
      for (let s = 0; s < STEPS; s++) { const n = el('span', 'bt-num' + (s % 4 === 0 ? ' b' : ''), String(s + 1)); n.dataset.s = s; if (s === head) n.classList.add('now'); nums.appendChild(n); }
      seq.appendChild(nums);
      rows.forEach(i => {
        const row = el('div', 'bt-row' + (i === sel ? ' sel' : '')); row.setAttribute('role', 'group'); row.setAttribute('aria-label', padName(i));
        const nm = el('span', 'bt-rowname', padName(i)); nm.setAttribute('aria-hidden', 'true'); row.appendChild(nm);
        for (let s = 0; s < STEPS; s++) {
          const c = el('button', 'bt-step' + (s % 4 === 0 ? ' b' : '')); c.type = 'button'; c.dataset.p = i; c.dataset.s = s;
          c.setAttribute('aria-pressed', String(!!pat[i][s])); c.setAttribute('aria-label', padName(i) + ', ' + T('צעד') + ' ' + (s + 1));
          c.tabIndex = (i === focusAt.pad && s === focusAt.step) ? 0 : -1;
          if (s === head) c.classList.add('now');
          row.appendChild(c);
        }
        seq.appendChild(row);
      });
      if (had) { const c = cell(focusAt.pad, focusAt.step); if (c) c.focus(); }
      clearB.querySelector('.bt-lbl').textContent = undo ? T('שחזור התבנית') : T('ניקוי התבנית');
    }
    const cell = (p, s) => seq.querySelector('.bt-step[data-p="' + p + '"][data-s="' + s + '"]');
    function moveTo(p, s) {
      const old = seq.querySelector('.bt-step[tabindex="0"]'); if (old) old.tabIndex = -1;
      focusAt = { pad: p, step: s }; const c = cell(p, s); if (c) { c.tabIndex = 0; c.focus(); }
    }
    seq.addEventListener('click', e => {
      const c = e.target.closest('.bt-step'); if (!c) return;
      const p = +c.dataset.p, s = +c.dataset.s; pat[p][s] = pat[p][s] ? 0 : 1; undo = null;
      focusAt = { pad: p, step: s }; sel = p; paintPads(); save();
      const keep = document.activeElement === c; renderSeq(); if (keep) { const n = cell(p, s); if (n) n.focus(); }
      // hear what was just switched on, unless the beat is running and will play it anyway
      if (pat[p][s] && !playing && wake()) { if (!fire({ i: p, gain: 0.85, at: performance.now() }) && !bufferOf(p)) want(ac, kit, pads()[p][0]); }
    });
    seq.addEventListener('focusin', e => { const c = e.target.closest('.bt-step'); if (c && c.tabIndex !== 0) { const o = seq.querySelector('.bt-step[tabindex="0"]'); if (o) o.tabIndex = -1; c.tabIndex = 0; focusAt = { pad: +c.dataset.p, step: +c.dataset.s }; } });
    seq.addEventListener('keydown', e => {
      const c = e.target.closest('.bt-step'); if (!c || e.altKey || e.ctrlKey || e.metaKey) return;
      const rows = rowsNow(), p = +c.dataset.p, s = +c.dataset.s, r = rows.indexOf(p); let np = p, ns = s;
      if (e.key === 'ArrowRight') ns = Math.min(STEPS - 1, s + 1);
      else if (e.key === 'ArrowLeft') ns = Math.max(0, s - 1);
      else if (e.key === 'ArrowDown') np = rows[Math.min(rows.length - 1, r + 1)];
      else if (e.key === 'ArrowUp') np = rows[Math.max(0, r - 1)];
      else if (e.key === 'Home') ns = 0;
      else if (e.key === 'End') ns = STEPS - 1;
      else return;
      e.preventDefault(); moveTo(np, ns);
    });

    /* ---------- pads: fingers, mouse, keys, screen readers ---------- */
    let lastIn = -1e9; const mark = () => { lastIn = performance.now(); };
    grid.addEventListener('pointerdown', e => {
      const b = e.target.closest('.bt-pad'); if (!b || e.button !== 0) return;
      e.preventDefault(); mark();
      const r = b.getBoundingClientRect();
      const d = Math.min(1, Math.max(Math.abs(e.clientX - (r.left + r.width / 2)) / (r.width / 2), Math.abs(e.clientY - (r.top + r.height / 2)) / (r.height / 2)));
      hit(+b.dataset.pad, d);
    });
    grid.addEventListener('pointerup', mark); grid.addEventListener('pointercancel', mark);
    // screen readers, switch and voice control send a click with no finger before it
    grid.addEventListener('click', e => {
      const b = e.target.closest('.bt-pad'); if (!b || performance.now() - lastIn < 700) return;
      hit(+b.dataset.pad, null);
    });
    const isPress = e => e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
    grid.addEventListener('keydown', e => {
      const b = e.target.closest('.bt-pad'); if (!b || !isPress(e)) return;
      e.preventDefault(); mark(); if (!e.repeat) hit(+b.dataset.pad, null);
    });
    grid.addEventListener('keyup', e => { if (e.target.closest('.bt-pad') && isPress(e)) { e.preventDefault(); mark(); } });
    grid.addEventListener('contextmenu', e => e.preventDefault());
    // iPhone zooms on fast repeated taps even with touch-action: stop the browser's own touch handling on the pads
    const noZoom = e => { if (e.cancelable) e.preventDefault(); };
    grid.addEventListener('touchstart', noZoom, { passive: false });
    grid.addEventListener('touchend', e => { if (ac && ac.state === 'running') noZoom(e); }, { passive: false });
    grid.addEventListener('dblclick', noZoom);
    function onKey(e) {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.defaultPrevented || !live()) return;
      const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'Escape' && root.classList.contains('is-full')) { setFull(false); return; }
      const i = KEYS.indexOf(e.code); if (i < 0) return;
      e.preventDefault(); hit(i, null);
    }
    document.addEventListener('keydown', onKey);

    /* ---------- transport ---------- */
    playB.addEventListener('click', () => { if (playing) halt(); else play(); });
    recB.addEventListener('click', () => {
      recOn = !recOn; recB.setAttribute('aria-pressed', String(recOn));
      say(recOn ? (playing ? T('הקלטה חיה פועלת. נגנו על הפדים והם נכנסים לתבנית.') : T('הקלטה חיה מוכנה. לחצו על נגן ונגנו על הפדים עם המטרונום.')) : T('הקלטה חיה כבויה.'));
    });
    clearB.addEventListener('click', () => {
      if (undo) { pat = undo; undo = null; say(T('התבנית שוחזרה.')); }
      else { undo = pat.map(r => r.slice()); pat = pat.map(() => new Array(STEPS).fill(0)); say(T('התבנית נוקתה. לחיצה נוספת משחזרת אותה.')); }
      save(); renderSeq();
    });
    function setKit(k) {
      if (k === kit) return; if (rec) endRec(true);
      kit = k; kits.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kit === k)));
      paintPads(); renderSeq(); save(); prepare();
    }

    /* ---------- recording your own sound ---------- */
    let rec = null;
    function paintRec() {
      const on = !!rec; micB.querySelector('.bt-lbl').textContent = on ? T('עצירת ההקלטה') : T('הקלטה לפד');
      micB.querySelector('svg').innerHTML = on ? ICON.stop : ICON.mic;
      micB.classList.toggle('on', on); root.classList.toggle('is-rec', on);
      meter.firstChild.style.width = '0%';
    }
    // close the microphone at once; drop = throw the sound away
    function endRec(drop) {
      const r = rec; if (!r) return; rec = null; clearTimeout(r.timer); cancelAnimationFrame(r.raf);
      if (r.sp) r.sp.onaudioprocess = null;
      try { if (r.stream) r.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* gone */ }
      [r.src, r.sp, r.mute].forEach(n => { try { if (n) n.disconnect(); } catch (e) { /* gone */ } });
      session('playback'); paintRec();
      if (drop || !r.chunks) return;
      let n = 0; r.chunks.forEach(c => { n += c.length; });
      const x = new Float32Array(Math.min(n, Math.floor(r.rate * MAX_REC))); let o = 0;
      for (const c of r.chunks) { if (o >= x.length) break; x.set(c.subarray(0, Math.min(c.length, x.length - o)), o); o += c.length; }
      const y = shape(x, r.rate);
      if (!y) { say(T('לא נקלט צליל. נסו שוב, קרוב יותר למיקרופון.')); return; }
      const key = r.kit + ':' + r.pad; userPcm[key] = { rate: r.rate, pcm: y }; delete userBuf[key];
      idbDo('readwrite', st => st.put({ rate: r.rate, pcm: y.buffer }, key));
      paintPads(); renderSeq();
      say(T('ההקלטה נשמרה בפד:') + ' ' + T(KITS[r.kit].pads[r.pad][1]) + '. ' + T('הקישו עליו כדי לשמוע.'));
      if (r.kit === kit) setTimeout(() => { if (fire({ i: r.pad, gain: 0.9, at: performance.now() })) flash(r.pad); }, 250);
    }
    async function startRec() {
      const a = wake(); if (!a) { say(T('הדפדפן הזה לא תומך בצליל.')); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say(T('המיקרופון לא זמין בדפדפן הזה.')); return; }
      halt(true);
      const r = rec = { kit, pad: sel, rate: a.sampleRate }; paintRec();
      session('play-and-record');
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
      catch (e) {
        if (rec === r) { rec = null; session('playback'); paintRec(); }
        say(e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') ? T('לא נמצא מיקרופון במכשיר הזה.') : T('אין גישה למיקרופון. אשרו אותו בהגדרות הדפדפן ונסו שוב.'));
        return;
      }
      // the player left or pressed stop while the permission question was open
      if (rec !== r || !live()) { stream.getTracks().forEach(t => t.stop()); if (rec === r) { rec = null; session('playback'); paintRec(); } return; }
      try {
        r.stream = stream; r.chunks = []; r.src = a.createMediaStreamSource(stream);
        r.sp = a.createScriptProcessor(2048, 1, 1); r.mute = a.createGain(); r.mute.gain.value = 0;
        let n = 0; const max = Math.floor(a.sampleRate * MAX_REC);
        r.sp.onaudioprocess = e => {
          if (rec !== r) return; const d = e.inputBuffer.getChannelData(0); r.chunks.push(new Float32Array(d)); n += d.length;
          if (n >= max) endRec(false);
        };
        r.src.connect(r.sp); r.sp.connect(r.mute); r.mute.connect(a.destination);
      } catch (e) { endRec(true); say(T('המיקרופון לא זמין בדפדפן הזה.')); return; }
      r.t0 = performance.now(); r.timer = setTimeout(() => { if (rec === r) endRec(false); }, MAX_REC * 1000 + 500);
      const tickBar = () => { if (rec !== r) return; meter.firstChild.style.width = Math.min(100, (performance.now() - r.t0) / (MAX_REC * 10)) + '%'; r.raf = requestAnimationFrame(tickBar); };
      tickBar();
      say(T('מקליט עד 3 שניות. השמיעו את הצליל עכשיו.'));
    }
    micB.addEventListener('click', () => { if (rec) endRec(false); else startRec(); });
    restB.addEventListener('click', () => {
      const key = kit + ':' + sel; if (!userPcm[key]) return;
      delete userPcm[key]; delete userBuf[key]; idbDo('readwrite', st => st.delete(key));
      paintPads(); renderSeq(); micB.focus(); say(T('הצליל המקורי חזר לפד:') + ' ' + padName(sel));
    });
    // recordings saved on this device come back
    const restored = idbDo('readonly', st => {
      const out = { result: {} }, rq = st.openCursor();
      rq.onsuccess = () => { const c = rq.result; if (!c) return; try { const v = c.value; if (v && v.pcm && v.rate) out.result[c.key] = { rate: v.rate, pcm: new Float32Array(v.pcm) }; } catch (e) { /* skip a broken one */ } c.continue(); };
      return out;
    }).then(all => { if (all) { Object.keys(all).forEach(k => { if (!userPcm[k]) userPcm[k] = all[k]; }); paintPads(); } });

    /* ---------- full screen ---------- */
    let back = null;
    function setFull(on) {
      root.classList.toggle('is-full', on); document.documentElement.classList.toggle('bt-locked', on);
      full.setAttribute('aria-pressed', String(on)); full.querySelector('.bt-lbl').textContent = on ? T('יציאה ממסך מלא') : T('מסך מלא');
      if (on) {
        back = document.activeElement;
        const fe = root.requestFullscreen || root.webkitRequestFullscreen;
        if (fe) { try { const p = fe.call(root); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not allowed */ } }
        say(T('מסך מלא. Escape או הכפתור יוצאים.')); full.focus();
      } else {
        const ex = document.exitFullscreen || document.webkitExitFullscreen;
        if (document.fullscreenElement || document.webkitFullscreenElement) { try { ex.call(document); } catch (e) { /* ignore */ } }
        if (back && back.focus) back.focus();
      }
    }
    full.addEventListener('click', () => setFull(!root.classList.contains('is-full')));
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && root.classList.contains('is-full')) setFull(false); });

    paintPads(); renderSeq(); paintPlay();

    function prepare() {
      const a = wake(); if (!a) { say(T('הדפדפן הזה לא תומך בצליל.')); return Promise.resolve(0); }
      const k = kit;
      if (pads().every(p => buf[k + ':' + p[0]])) return Promise.resolve(16);
      say(T('מכין צלילים…'));
      return loadKit(a, k).then(n => { if (k === kit) say(n > 0 ? T('הפדים מוכנים. נגנו!') : T('הצלילים לא נטענו. בדקו את החיבור ונסו שוב.')); flush(); return n; });
    }
    // leaving the tab: silence, microphone closed, out of full screen, the phone's audio mode as it was
    function stop() {
      halt(true); if (rec) endRec(true);
      if (root.classList.contains('is-full')) setFull(false);
      waiting = [];
      try { if (sess != null) { navigator.audioSession.type = sess; sess = null; } } catch (e) { /* not supported */ }
    }
    const latency = () => ac ? { state: ac.state, rate: ac.sampleRate, base: Math.round((ac.baseLatency || 0) * 1000), output: Math.round((ac.outputLatency || 0) * 1000) } : null;
    // for tests: the steps as they were handed to the audio clock
    const debug = () => ({ playing, bpm, swing, kit, sel, recording: !!rec, steps: sched.map(e => ({ n: e.n, step: e.step, t: e.t, pads: Object.keys(e.v).map(Number) })), pat: pat.map(r => r.join('')), mine: Object.keys(userPcm), restored });
    return { prepare, stop, latency, debug };
  }
  window.SoniqBeats = { mount, KITS, KEYS };
})();
