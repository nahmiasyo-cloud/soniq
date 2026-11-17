/* SONIQ beats: 16 pads, a 16-step sequencer and a one-shot sampler, for hip-hop and electronic music.
   Sounds: CC0 recordings (Sonic Pi bundled samples, VCSL, Karoryfer Big Rusty Drums), loaded from sounds/beats-<kit>-mp3.js.
   Pads use the drum kit's low-latency recipe: play on pointerdown, one finger per pointer, start past the MP3 encoder's silence,
   two audio nodes per hit, samples decoded one by one, iPhone unlock on every finished touch, a restart when the clock stands still.
   Timing: a lookahead scheduler. A timer only wakes the scheduler; every note is started by the audio clock (ac.currentTime),
   so steps stay even when the page is busy. In a background tab timers slow down, so the scheduler looks further ahead there.
   The playhead follows what is heard: audio time minus the output delay the browser reports.
   Recording your own sound: the microphone opens for up to 3 seconds with the phone's voice processing off, the silence before
   the sound is cut, the level is normalised, and the pad plays it. Recordings stay in IndexedDB on this device.
   Looper: one big button records a loop from the microphone, 1, 2 or 4 bars long, after a one-bar count-in. The take closes by
   itself on the bar line and plays with the beat; each further press adds one layer (up to 8), one loop long. The microphone is read
   by an AudioWorklet that stamps every block with the audio clock's frame, so a take is cut at the exact frames of its bars, moved
   by the device's output and input delay (measured by the calibration, or estimated). Every pass of the loop is started by the
   audio clock on the sequencer's own bar time, so loop and beat cannot drift apart. Layers stay in memory only.
   Accessible: every control is a native button or input with a name; steps are toggle buttons ("Kick, step 5") in a grid
   with arrow keys; a status line announces play, stop, tempo and recording; nothing depends on colour or motion alone.
   mount(host, { audio, dest, T, chain }) — audio() returns the app's AudioContext, dest() the node to play into,
   chain the delay in seconds of what follows dest() (a compressor looks 6 ms ahead). */
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
  const LP_MAX = 8, LP_XF = 0.008, LP_STORE = 'soniq-looper', LP_BARS = [1, 2, 4];
  // the looper's ear: runs on the audio thread and posts the microphone in blocks, each with the frame of its first sample
  const TAP_SRC = `class SoniqTap extends AudioWorkletProcessor {
    constructor() { super(); this.b = new Float32Array(512); this.n = 0; this.f = 0; this.dead = false; this.port.onmessage = () => { this.dead = true; }; }
    send() { if (this.n) this.port.postMessage({ f: this.f, d: this.n === this.b.length ? this.b : this.b.slice(0, this.n) }); this.b = new Float32Array(512); this.n = 0; }
    process(inputs) {
      if (this.dead) return false;
      const ch = inputs[0] && inputs[0][0], len = ch ? ch.length : 128;
      if (this.n + len > this.b.length) this.send();
      if (this.n === 0) this.f = currentFrame;
      if (ch) this.b.set(ch, this.n);
      this.n += len;
      if (this.n >= this.b.length) this.send();
      return true;
    }
  }
  registerProcessor('soniq-tap', SoniqTap);`;
  function tapModule(a) {
    if (!a.audioWorklet || !window.AudioWorkletNode) return Promise.resolve(false);
    if (!a._soniqTap) a._soniqTap = new Promise(res => {
      try {
        const url = URL.createObjectURL(new Blob([TAP_SRC], { type: 'application/javascript' }));
        a.audioWorklet.addModule(url).then(() => res(true), () => res(false)).then(() => URL.revokeObjectURL(url));
      } catch (e) { res(false); }
    });
    return a._soniqTap;
  }
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
    const F = (k, ...v) => T(k).replace(/\{(\d)\}/g, (_, n) => v[n]);
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
    // the looper: what is recorded, what plays, and the microphone
    const lp = { bars: 2, calOff: null, nudge: 0, inLat: 0.012, state: 'empty', layers: [], cycles: [], steps: 0, len: 0, tick0: 0, gain: 0, take: null, mic: null, micTok: null, tok: null, calib: null, cleared: null, ui: null, bus: null, w: '' };
    try {
      const o = JSON.parse(localStorage.getItem(LP_STORE) || 'null');
      if (o && o.v === 1) {
        if (LP_BARS.indexOf(o.bars) >= 0) lp.bars = o.bars;
        if (typeof o.cal === 'number' && Math.abs(o.cal) < 500) lp.calOff = o.cal;
        if (typeof o.nudge === 'number' && Math.abs(o.nudge) <= 200) lp.nudge = Math.round(o.nudge);
      }
    } catch (e) { /* no storage: defaults */ }
    const live = () => root.isConnected && (root.offsetParent !== null || root.classList.contains('is-full'));
    const pads = () => KITS[kit].pads;
    const padName = i => T(pads()[i][1]);
    // each pad wears its family's colour, so kicks, snares, hats and the rest are found at a glance (the name stays the label)
    const FAM = { kick: 'low', kick2: 'low', '808': 'low', bass: 'low', tom: 'low', snare: 'snap', snare2: 'snap', clap: 'snap', rim: 'snap', snap: 'snap',
      chh: 'hat', ohh: 'hat', shaker: 'hat', tamb: 'hat', crash: 'hat', cymbal: 'hat' };
    const famOf = i => FAM[pads()[i][0]] || 'fx';

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
      if (!rec && !lp.mic && !lp.micTok) session('playback');
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
        if (nextTime < ac.currentTime - 0.2) { nextTime = ac.currentTime + 0.05; lpResync(); }
        while (nextTime < ac.currentTime + ahead) {
          const t = nextTime + swingOf(nextStep), e = { n: tickNo, step: nextStep, t, v: {} };
          e.lp = lpStep(tickNo, nextStep, nextTime);
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
      if (e) { setHead(e.step); if (!reduce) Object.keys(e.v).forEach(i => flash(+i)); lpShow(e.lp); }
      lpProgress(now);
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
      lpStart(); paintPlay(); pump(); raf = requestAnimationFrame(draw);
      say(recOn ? T('מנגן ומקליט. נגנו על הפדים.') : T('מנגן.') + ' ' + bpm + ' BPM' + (lp.layers.length ? '. ' + F('שכבות בלופ: {0}', lp.layers.length) : ''));
    }
    function halt(quiet) {
      if (!playing) return; playing = false; clearTimeout(timer); cancelAnimationFrame(raf);
      // notes already handed to the audio clock but not yet heard are taken back
      sched.forEach(e => Object.keys(e.v).forEach(i => { const v = e.v[i]; if (v.t > ac.currentTime) stopVoice(v, 0.005); }));
      sched = []; vis = []; muted.clear(); setHead(-1); paintPlay(); lpQuiet();
      if (!quiet) say(T('נעצר.'));
    }
    document.addEventListener('visibilitychange', () => {
      if (!ac || !live()) return;
      if (!document.hidden) wake();
      else if (lp.mic || lp.micTok) lpQuiet(true); // the microphone does not stay open behind the player's back
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
      plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
      phones: '<path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
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
      // on() may answer with the value to go back to (a locked tempo)
      r.addEventListener('input', () => { const back = on(+r.value, false); if (back != null) r.value = back; show(); });
      r.addEventListener('change', () => { const back = on(+r.value, true); if (back != null) { r.value = back; show(); } });
      show(); f.appendChild(l); f.appendChild(r); f.appendChild(o); return f;
    }
    ctl.appendChild(trans);
    const tempoF = slider(T('טמפו'), 60, 180, bpm, v => v + ' BPM', (v, end) => {
      if (lpLocked()) return bpm;
      bpm = v; if (lp.cleared) { lp.cleared = null; lpPaint(); }
      if (end) { save(); say(T('טמפו') + ' ' + v + ' BPM'); }
    }), tempoIn = tempoF.querySelector('input');
    const lockNote = el('p', 'desc bt-lock', T('הטמפו נעול כל עוד יש לופ. כדי לשנות טמפו, נקו את הלופ.')); lockNote.id = 'bt-lock' + Math.random().toString(36).slice(2, 7); lockNote.hidden = true;
    ctl.appendChild(tempoF); ctl.appendChild(lockNote);
    const swingF = slider(T('סווינג'), 0, 60, swing, v => v + '%', (v, end) => { swing = v; if (end) { save(); say(T('סווינג') + ' ' + v + '%'); } }); swingF.classList.add('lvl-adv'); ctl.appendChild(swingF);

    const seqBox = el('div', 'bt-seqbox');
    const seqH = el('h4', 'bt-h', T('סיקוונסר: 16 צעדים')); seqH.id = 'bt-seq-h' + Math.random().toString(36).slice(2, 7);
    const seqTip = el('p', 'desc bt-tip kbd-only', T('במקלדת: חיצים זזים בין הצעדים, Enter מדליק.'));
    const wrap = el('div', 'bt-seqwrap'); wrap.setAttribute('dir', 'ltr');
    const seq = el('div', 'bt-seq'); seq.setAttribute('role', 'group'); seq.setAttribute('aria-labelledby', seqH.id);
    wrap.appendChild(seq); seqBox.appendChild(seqH); seqBox.appendChild(seqTip); seqBox.appendChild(wrap);

    const smp = el('div', 'bt-sampler'); smp.setAttribute('role', 'group');
    const smpH = el('h4', 'bt-h', T('הקלטה עצמית')); smpH.id = 'bt-smp-h' + Math.random().toString(36).slice(2, 7); smp.setAttribute('aria-labelledby', smpH.id);
    const smpTip = el('p', 'desc bt-tip', T('בחרו פד והקליטו עליו צליל של עד 3 שניות.'));
    const smpSel = el('p', 'bt-sel');
    const micB = btn('bt-btn bt-mic', T('הקלטה לפד'), ICON.mic);
    const restB = btn('bt-btn bt-restore', T('שחזור הצליל המקורי'), ICON.back);
    const meter = el('span', 'bt-meter'); meter.setAttribute('aria-hidden', 'true'); meter.appendChild(el('span'));
    const smpRow = el('div', 'bt-transport'); smpRow.appendChild(micB); smpRow.appendChild(restB);
    [smpH, smpTip, smpSel, smpRow, meter].forEach(x => smp.appendChild(x));

    /* the looper: one big button, two small ones */
    // whole phrases, because 2 and 4 take different forms in some languages
    const lpBarsText = n => n === 1 ? T('תיבה אחת') : n === 2 ? T('2 תיבות') : T('4 תיבות');
    const rid = () => Math.random().toString(36).slice(2, 7);
    const loopBox = el('section', 'bt-looper'); loopBox.setAttribute('role', 'group'); loopBox.tabIndex = -1;
    const loopH = el('h4', 'bt-h', T('לופר')); loopH.id = 'bt-lp-h' + rid(); loopBox.setAttribute('aria-labelledby', loopH.id);
    const loopHint = el('p', 'lp-hint'); loopHint.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICON.phones + '</svg>';
    loopHint.appendChild(el('span', '', T('מומלץ עם אוזניות, כדי שהביט לא ייכנס להקלטה.')));
    const lenRow = el('div', 'lp-len'), lenLabel = el('span', 'lp-lenlabel', T('אורך הלופ')); lenLabel.id = 'bt-lp-l' + rid();
    const lenSeg = el('div', 'seg'); lenSeg.setAttribute('role', 'group'); lenSeg.setAttribute('aria-labelledby', lenLabel.id);
    LP_BARS.forEach(n => {
      const b = el('button', '', lpBarsText(n)); b.type = 'button'; b.dataset.bars = n;
      b.addEventListener('click', () => lpSetBars(n)); lenSeg.appendChild(b);
    });
    lenRow.appendChild(lenLabel); lenRow.appendChild(lenSeg);
    const loopMain = btn('lp-main', T('הקלט לופ'), ICON.rec);
    // the state in words; the button's description, so a screen reader hears the next action and where things stand
    const loopState = el('p', 'lp-state'); loopState.id = 'bt-lp-s' + rid(); loopMain.setAttribute('aria-describedby', loopState.id);
    const loopText = el('span', 'lp-text'), loopMic = el('span', 'lp-micon');
    loopMic.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICON.mic + '</svg>'; loopMic.appendChild(el('span', '', T('המיקרופון פתוח'))); loopMic.hidden = true;
    loopState.appendChild(loopText); loopState.appendChild(loopMic);
    const loopProg = el('div', 'lp-prog'); loopProg.setAttribute('aria-hidden', 'true'); loopProg.setAttribute('dir', 'ltr');
    const loopFill = el('span', 'lp-fill'), loopBarsEl = el('span', 'lp-bars'); loopProg.appendChild(loopFill); loopProg.appendChild(loopBarsEl);
    const loopRow = el('div', 'bt-transport');
    const undoB = btn('bt-btn lp-undo', T('בטל שכבה אחרונה'), ICON.back), wipeB = btn('bt-btn lp-clear', T('נקה לופ'), ICON.clear);
    loopRow.appendChild(undoB); loopRow.appendChild(wipeB);
    // timing help, folded away: most players never need it
    const sync = el('details', 'lp-sync'), syncSum = el('summary', '', T('סנכרון ההקלטה עם הביט'));
    const syncTip = el('p', 'desc', T('אם ההקלטה לא יושבת על הביט, כיילו פעם אחת: בלי אוזניות, בחדר שקט ובעוצמה בינונית. נשמעות 8 נקישות והמכשיר מודד את ההשהיה שלו.'));
    const calB = btn('bt-btn lp-cal', T('כיול אוטומטי'), ICON.mic);
    const syncLabel = el('p', 'lp-synclabel', T('כיוון ידני: להזיז את ההקלטות ביחס לביט')); syncLabel.id = 'bt-lp-n' + rid();
    const syncRow = el('div', 'lp-syncrow'); syncRow.setAttribute('role', 'group'); syncRow.setAttribute('aria-labelledby', syncLabel.id);
    const earlyB = btn('bt-btn lp-early', T('מוקדם יותר')), lateB = btn('bt-btn lp-late', T('מאוחר יותר')), resetB = btn('bt-btn lp-reset', T('איפוס'));
    const syncVal = el('span', 'lp-syncval'); syncVal.setAttribute('dir', 'ltr');
    [earlyB, syncVal, lateB, resetB].forEach(x => syncRow.appendChild(x));
    const syncInfo = el('p', 'desc lp-syncinfo');
    [syncSum, syncTip, calB, syncLabel, syncRow, syncInfo].forEach(x => sync.appendChild(x));
    [loopH, loopHint, lenRow, loopMain, loopState, loopProg, loopRow, sync].forEach(x => loopBox.appendChild(x));

    const status = el('p', 'status-line bt-status'); status.setAttribute('role', 'status');
    // one tool at a time under the pads: sequencer, looper or your own sound
    const VIEWS = [['seq', T('סיקוונסר'), seqBox], ['loop', T('לופר'), loopBox], ['own', T('צליל משלי'), smp]];
    let view = 'seq'; try { const v = localStorage.getItem('soniq-beats-view'); if (VIEWS.some(x => x[0] === v)) view = v; } catch (e) { /* no storage */ }
    const views = el('div', 'seg bt-views'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', T('כלי עבודה'));
    function setView(v) {
      view = v; try { localStorage.setItem('soniq-beats-view', v); } catch (e) { /* no storage */ }
      VIEWS.forEach(([k, , box]) => { box.hidden = k !== v; });
      [...views.children].forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
    }
    VIEWS.forEach(([k, t]) => { const b = el('button', '', t); b.type = 'button'; b.dataset.v = k; b.addEventListener('click', () => setView(k)); views.appendChild(b); });
    body.appendChild(grid); body.appendChild(ctl); body.appendChild(views); body.appendChild(seqBox); body.appendChild(loopBox); body.appendChild(smp);
    setView(view);
    root.appendChild(bar); root.appendChild(body); root.appendChild(status); host.appendChild(root);

    function say(t) { status.textContent = ''; setTimeout(() => { status.textContent = t; }, 40); }
    function flash(i) {
      const b = padBtn[i]; if (!b) return;
      b.classList.add('hit'); clearTimeout(b._t); b._t = setTimeout(() => b.classList.remove('hit'), reduce ? 120 : 160);
    }
    function paintPads() {
      padBtn.forEach((b, i) => {
        const mine = !!userPcm[kit + ':' + i];
        b.querySelector('.bt-name').textContent = padName(i); b.dataset.fam = famOf(i);
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
        const row = el('div', 'bt-row' + (i === sel ? ' sel' : '')); row.dataset.fam = famOf(i); row.setAttribute('role', 'group'); row.setAttribute('aria-label', padName(i));
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
      halt(true); lpQuiet();
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

    /* ---------- looper ---------- */
    // states: empty, open (microphone opening), pre (waiting for the bar), count, rec, play, wait (layer armed), dub, stopped, cal
    const lpBusy = () => !!lp.take || !!lp.calib || lp.state === 'open';
    const lpLocked = () => lp.layers.length > 0 || !!lp.take;
    function lpSave() { try { localStorage.setItem(LP_STORE, JSON.stringify({ v: 1, bars: lp.bars, cal: lp.calOff, nudge: lp.nudge })); } catch (e) { /* no storage */ } }
    /* How late the microphone hears what the player plays to the beat, in seconds: the way out (what follows our bus, the
       browser's buffer, the device) plus the way in. A take is cut this much later than its bars, so on playback it sits on them. */
    function lpEstimate() {
      if (!ac) return 0;
      return Math.min(0.5, (opt.chain || 0) + (ac.outputLatency > 0 ? ac.outputLatency : 0.015) + (ac.baseLatency || 0) + lp.inLat);
    }
    // a calibration is kept as its distance from the estimate, so a new audio route that the browser reports still moves the result
    const lpComp = () => Math.max(0, Math.min(0.6, lpEstimate() + (lp.calOff || 0) / 1000 + lp.nudge / 1000));
    function lpBus() { if (!lp.bus) { lp.bus = ac.createGain(); lp.bus.gain.value = 1; lp.bus.connect(opt.dest ? opt.dest() : ac.destination); } return lp.bus; }
    function setState(st) { lp.state = st; lp.ui = st !== 'empty' && lp.ui && lp.ui.bar ? { bar: lp.ui.bar } : null; lpPaint(); }

    /* the microphone: open from the first press until the loop stops, is cleared, or the player leaves */
    async function openMic() {
      if (lp.mic) return true;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say(T('המיקרופון לא זמין בדפדפן הזה.')); return false; }
      const a = ac, tok = lp.micTok = {}; session('play-and-record');
      const back = () => { if (lp.micTok === tok) { lp.micTok = null; if (!rec) session('playback'); } };
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
      catch (e) {
        back();
        say(e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') ? T('לא נמצא מיקרופון במכשיר הזה.') : T('אין גישה למיקרופון. אשרו אותו בהגדרות הדפדפן ונסו שוב.'));
        return false;
      }
      const worklet = await tapModule(a);
      // the player cancelled or left while the permission question was open
      if (lp.micTok !== tok || !live()) { stream.getTracks().forEach(t => t.stop()); back(); return false; }
      const m = { stream, track: stream.getAudioTracks()[0], kind: worklet ? 'worklet' : 'script', chunks: [], keep: false, last: 0, n: 0, base: Infinity, bs: 1024 };
      try {
        m.src = a.createMediaStreamSource(stream); m.mute = a.createGain(); m.mute.gain.value = 0;
        if (worklet) {
          m.node = new AudioWorkletNode(a, 'soniq-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
          m.node.port.onmessage = e => lpFeed(m, e.data.d, e.data.f, 0);
        } else {
          m.node = a.createScriptProcessor(m.bs, 1, 1);
          m.node.onaudioprocess = e => lpFeed(m, new Float32Array(e.inputBuffer.getChannelData(0)), 0, e.playbackTime || a.currentTime + m.bs / a.sampleRate);
        }
        m.src.connect(m.node); m.node.connect(m.mute); m.mute.connect(a.destination);
      } catch (e) {
        stream.getTracks().forEach(t => t.stop()); [m.src, m.node, m.mute].forEach(n => { try { if (n) n.disconnect(); } catch (x) { /* gone */ } });
        back(); say(T('המיקרופון לא זמין בדפדפן הזה.')); return false;
      }
      try { const s = m.track.getSettings(); lp.inLat = s && s.latency > 0 && s.latency < 0.3 ? s.latency : 0.012; } catch (e) { lp.inLat = 0.012; }
      // unplugged, or the permission was taken back
      m.track.addEventListener('ended', () => { if (lp.mic !== m) return; const busy = lpBusy(); lpAbort(false); if (busy) say(T('המיקרופון נותק. ההקלטה בוטלה.')); });
      lp.micTok = null; lp.mic = m; lp.tap = m.kind; lpPaint(); return true;
    }
    function closeMic() {
      const pending = lp.micTok, m = lp.mic; lp.micTok = null; lp.mic = null;
      if (!m) { if (pending && !rec) session('playback'); return; }
      try { if (m.kind === 'worklet') { m.node.port.onmessage = null; m.node.port.postMessage(0); } else m.node.onaudioprocess = null; } catch (e) { /* gone */ }
      try { m.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* gone */ }
      [m.src, m.node, m.mute].forEach(n => { try { n.disconnect(); } catch (e) { /* gone */ } });
      if (!rec) session('playback');
    }
    /* Every block of microphone sound arrives with the frame of the audio clock it was rendered at. The worklet knows it exactly.
       The old ScriptProcessor only says when its block will play: two blocks after the first input frame, and late by however
       busy the page was. Its blocks follow each other without gaps, so the earliest report fixes the frame of all of them. */
    function lpFeed(m, d, f, pt) {
      if (lp.mic !== m) return;
      if (m.kind === 'script') {
        m.base = Math.min(m.base, Math.round(pt * ac.sampleRate) - 2 * m.bs - m.n);
        if (m.keep) m.chunks.push({ i: m.n, d }); m.n += d.length; m.last = m.base + m.n;
      } else { if (m.keep) m.chunks.push({ f, d }); m.last = f + d.length; }
      const tk = lp.take, c = lp.calib;
      if (tk && tk.F0 != null && m.last >= tk.need) lpFinish();
      else if (c && c.need && m.last >= c.need) lpCalDone();
    }
    // n frames of what the microphone heard from frame F0 on
    function lpRead(m, F0, n) {
      const out = new Float32Array(n);
      m.chunks.forEach(c => {
        const f = m.kind === 'script' ? m.base + c.i : c.f, a = Math.max(f, F0), b = Math.min(f + c.d.length, F0 + n);
        if (b > a) out.set(c.d.subarray(a - f, b - f), a - F0);
      });
      return out;
    }

    /* the loop on the sequencer's clock: called for every step before it is handed to the audio clock. t is the step's place on
       the straight grid; bars start on step 0, which swing never moves */
    function lpStep(tick, step, t) {
      if (lp.take && lp.take.tEnd != null && ac.currentTime > lp.take.tEnd + 2) { lpAbort(true); say(T('ההקלטה נכשלה: לא הגיע צליל מהמיקרופון.')); }
      const tk = lp.take; let ui = null;
      if (tk) {
        if (tk.first && tick >= tk.countTick && tick < tk.recTick) {
          if (tick === tk.countTick) setState('count');
          if (step % 4 === 0 && !recOn) click(t, step === 0);
          ui = { beat: (step >> 2) + 1 };
        } else if (tick === tk.recTick) {
          tk.comp = lp.comp = lpComp(); tk.t0 = t; tk.F0 = Math.round((t + tk.comp) * ac.sampleRate); tk.need = tk.F0 + tk.len + tk.xf; tk.tEnd = t + lp.len;
          if (tk.first) lp.tick0 = tick;
          setState(tk.first ? 'rec' : 'dub'); say(tk.first ? T('מקליט.') : F('מקליט שכבה {0}.', lp.layers.length + 1));
        }
        // no beat to play to: the click goes on through the take
        if (tick >= tk.recTick && tick < tk.endTick && step % 4 === 0 && !recOn && !pat.some(r => r.some(Boolean))) click(t, step === 0);
      }
      const on = lp.steps && tick >= lp.tick0 && (lp.layers.length || (tk && tk.F0 != null));
      if (on && (tick - lp.tick0) % lp.steps === 0) lpCycle(t);
      if (on && !ui) ui = { bar: (((tick - lp.tick0) % lp.steps) >> 4) + 1 };
      return ui;
    }
    // one pass of the loop: every layer starts on the bar line, by the audio clock
    function lpCycle(t) {
      const now = ac.currentTime; lp.cycles = lp.cycles.filter(c => c.t + lp.len > now - 0.5);
      const c = { t, v: [] }; lp.cycles.push(c); lp.layers.forEach(l => lpVoice(c, l, 0));
    }
    // a layer in a pass; one that joins late starts inside its sound, with a short fade
    function lpVoice(c, l, now) {
      const when = Math.max(c.t, now), off = when - c.t; if (off >= lp.len - 0.02) return;
      try {
        const s = ac.createBufferSource(), g = ac.createGain(); s.buffer = l.buf; s.connect(g); g.connect(l.g);
        if (off > 0) { g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1, when + 0.01); }
        s.start(when, off);
        const v = { s, g, l, t: when }; c.v.push(v);
        s.onended = () => { const k = c.v.indexOf(v); if (k >= 0) c.v.splice(k, 1); try { s.disconnect(); g.disconnect(); } catch (e) { /* gone */ } };
      } catch (e) { /* ignore */ }
    }
    function lpJoin(l) { const now = ac.currentTime + 0.02; lp.cycles.forEach(c => { if (c.t + lp.len > now) lpVoice(c, l, now); }); }
    // silence one layer, or all of them
    function lpKill(l) {
      if (!ac) return; const now = ac.currentTime;
      lp.cycles.forEach(c => c.v.slice().forEach(v => {
        if (l && v.l !== l) return;
        try {
          if (v.t > now) v.s.stop();
          else { v.g.gain.cancelScheduledValues(now); v.g.gain.setValueAtTime(v.g.gain.value, now); v.g.gain.linearRampToValueAtTime(0, now + 0.012); v.s.stop(now + 0.02); }
        } catch (e) { /* already stopped */ }
        c.v.splice(c.v.indexOf(v), 1);
      }));
    }
    function lpLayer(pcm) {
      const b = ac.createBuffer(1, pcm.length, ac.sampleRate); b.getChannelData(0).set(pcm);
      const g = ac.createGain(); g.gain.value = 0.9; g.connect(lpBus()); return { pcm, buf: b, g };
    }
    // the take is complete: cut it at its bars, fold the few milliseconds after the end into the start, and let it play
    function lpFinish() {
      const tk = lp.take, m = lp.mic; if (!tk || !m) return;
      const raw = lpRead(m, tk.F0, tk.len + tk.xf); m.keep = false; m.chunks = []; lp.take = null;
      let sum = 0, pk = 0; for (let i = 0; i < raw.length; i++) sum += raw[i];
      const dc = sum / raw.length; for (let i = 0; i < raw.length; i++) { raw[i] -= dc; const v = Math.abs(raw[i]); if (v > pk) pk = v; }
      if (pk < 0.004) {
        if (tk.first) { lpAbort(false); say(T('לא נקלט צליל. נסו שוב, קרוב יותר למיקרופון.')); }
        else { setState(playing ? 'play' : 'stopped'); say(T('לא נקלט צליל. השכבה לא נוספה.')); }
        return;
      }
      // the first take sets the level for all layers, so a soft layer stays soft next to a loud one
      if (!lp.gain) lp.gain = Math.min(8, Math.max(1, 0.5 / pk));
      const g = Math.min(lp.gain, 0.95 / pk), n = tk.len, pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = raw[i] * g;
      for (let i = 0; i < tk.xf; i++) { const w = i / tk.xf; pcm[i] = pcm[i] * w + raw[n + i] * g * (1 - w); }
      let l; try { l = lpLayer(pcm); } catch (e) { lpAbort(true); say(T('ההקלטה נכשלה: לא הגיע צליל מהמיקרופון.')); return; }
      lp.layers.push(l); lpJoin(l);
      setState(playing ? 'play' : 'stopped'); say(F('מנגן לופ. שכבות: {0}', lp.layers.length));
    }
    // stop whatever is being recorded or measured. keepMic: the loop goes on playing, so the microphone stays ready
    function lpAbort(keepMic) {
      lp.tok = null;
      if (lp.calib) { clearTimeout(lp.calib.timer); (lp.calib.srcs || []).forEach(s => { try { s.stop(); } catch (e) { /* gone */ } }); lp.calib = null; }
      if (lp.mic) { lp.mic.keep = false; lp.mic.chunks = []; }
      lp.take = null;
      if (!keepMic || !lp.layers.length || !playing) closeMic();
      if (!playing) { lpKill(null); lp.cycles = []; }
      if (!lp.layers.length) { lp.steps = 0; lp.gain = 0; lp.cycles = []; }
      setState(lp.layers.length ? (playing ? 'play' : 'stopped') : 'empty');
    }
    const lpQuiet = () => lpAbort(false);
    function lpStart() { lp.tick0 = 0; lp.cycles = []; if (lp.layers.length && !lpBusy()) setState('play'); }
    // the clock jumped (the phone slept): a take across the jump is lost, the loop comes back on its next bar line
    function lpResync() { if (lp.take) { lpAbort(true); say(T('ההקלטה בוטלה.')); } lpKill(null); lp.cycles = []; }

    async function lpRecord(first) {
      if (!first && lp.layers.length >= LP_MAX) { say(F('יש כבר {0} שכבות, וזה המקסימום. בטלו שכבה כדי להוסיף חדשה.', LP_MAX)); return; }
      const a = wake(); if (!a) { say(T('הדפדפן הזה לא תומך בצליל.')); return; }
      if (rec) endRec(true);
      lp.cleared = null;
      const tok = lp.tok = {}; setState('open');
      const ok = await openMic();
      if (lp.tok !== tok) return;
      lp.tok = null;
      if (!ok || (!first && (!playing || !lp.layers.length))) { lpAbort(true); return; }
      const rate = a.sampleRate, m = lp.mic, xf = Math.round(LP_XF * rate); m.keep = true; m.chunks = [];
      if (first) {
        // one bar of count-in from the next bar line, then the take. The loop needs the grid: a beat that is not running starts now
        lp.steps = 16 * lp.bars; lp.len = lp.steps * stepDur(); lp.gain = 0;
        const c = playing ? Math.ceil(tickNo / 16) * 16 : 0;
        lp.take = { first: true, countTick: c, recTick: c + 16, endTick: c + 16 + lp.steps, len: Math.round(lp.len * rate), xf };
        setState('pre'); if (!playing) play();
        if (!playing) { lpAbort(false); return; }
        say(T('ספירה של תיבה אחת, ואז מקליטים. הטמפו נעול עד שמנקים את הלופ.'));
      } else {
        const r = lp.tick0 + Math.ceil((tickNo - lp.tick0) / lp.steps) * lp.steps;
        lp.take = { first: false, recTick: r, endTick: r + lp.steps, len: lp.layers[0].pcm.length, xf };
        setState('wait'); say(T('השכבה תוקלט מתחילת הלופ.'));
      }
    }
    let lpLast = -1e9;
    function lpMain() {
      const now = performance.now(); if (now - lpLast < 300) return; lpLast = now; // a double tap is one press
      const st = lp.state;
      if (st === 'empty') lpRecord(true);
      else if (st === 'stopped') play();
      else if (st === 'play') lpRecord(false);
      else { lpAbort(true); say(st === 'cal' ? T('הכיול בוטל.') : T('ההקלטה בוטלה.')); }
    }
    function lpUndo() {
      if (lpBusy()) { const cal = !!lp.calib; lpAbort(true); say(cal ? T('הכיול בוטל.') : T('ההקלטה בוטלה.')); return; }
      if (!lp.layers.length) { say(T('אין שכבה לבטל.')); return; }
      const l = lp.layers.pop(); lpKill(l); try { l.g.disconnect(); } catch (e) { /* gone */ }
      if (!lp.layers.length) { lpAbort(false); say(T('השכבה בוטלה. הלופ ריק.')); }
      else { lpPaint(); say(F('השכבה האחרונה בוטלה. שכבות: {0}', lp.layers.length)); }
    }
    function lpClear() {
      if (lp.cleared && !lp.layers.length && !lpBusy()) {
        const c = lp.cleared; lp.cleared = null; lp.layers = c.layers; lp.steps = c.steps; lp.len = c.len; lp.gain = c.gain; lp.bars = c.steps / 16; lp.cycles = [];
        if (playing) { // come in where the beat is now
          const r = ((tickNo - lp.tick0) % lp.steps + lp.steps) % lp.steps;
          if (r) { lp.cycles.push({ t: nextTime - r * stepDur(), v: [] }); lp.layers.forEach(lpJoin); }
        }
        lpSave(); setState(playing ? 'play' : 'stopped'); say(F('הלופ שוחזר. שכבות: {0}', lp.layers.length)); return;
      }
      if (!lp.layers.length && !lpBusy()) { say(T('אין לופ לנקות.')); return; }
      const keep = lp.layers.length ? { layers: lp.layers, steps: lp.steps, len: lp.len, gain: lp.gain } : null;
      lpKill(null); lp.layers = []; lpAbort(false); lp.cleared = keep; lpPaint();
      say(keep ? T('הלופ נוקה. לחיצה נוספת משחזרת אותו.') : T('ההקלטה בוטלה.'));
    }
    function lpSetBars(n) {
      if (lpLocked() || lpBusy()) { if (n !== (lp.steps ? lp.steps / 16 : lp.bars)) say(T('אורך הלופ נקבע בהקלטה הראשונה. כדי לשנות אותו, נקו את הלופ.')); return; }
      lp.bars = n; lp.cleared = null; lpSave(); lpPaint(); say(T('אורך הלופ') + ': ' + lpBarsText(n));
    }

    /* timing: a hand adjustment, and a measurement */
    // move what is already recorded: sec > 0 is earlier. A loop is a circle, so the sound turns round it
    function lpShift(sec) {
      const d = Math.round(sec * ac.sampleRate);
      lp.layers.concat(lp.cleared ? lp.cleared.layers : []).forEach(l => {
        const n = l.pcm.length, k = ((d % n) + n) % n; if (!k) return;
        const y = new Float32Array(n); y.set(l.pcm.subarray(k)); y.set(l.pcm.subarray(0, k), n - k); l.pcm = y;
        try { const b = ac.createBuffer(1, n, ac.sampleRate); b.getChannelData(0).set(y); l.buf = b; } catch (e) { /* keep the old one */ }
      });
    }
    function lpSync(calOff, nudge) {
      const old = lpComp(); lp.calOff = calOff; lp.nudge = Math.max(-200, Math.min(200, nudge));
      if (ac && lpComp() !== old) lpShift(lpComp() - old);
      lpSave(); lpPaint();
    }
    const lpSigned = v => (v > 0 ? '+' : '') + v + ' ms';
    function lpNudge(by) {
      if (lpBusy()) { say(T('אפשר לכוון אחרי שההקלטה מסתיימת.')); return; }
      lpSync(lp.calOff, lp.nudge + by); say(T('כיוון ידני') + ': ' + lpSigned(lp.nudge));
    }
    // the click the microphone listens for: 2 kHz, sharp at the front, 12 ms long
    function lpCalBuf() {
      if (!lp.calBuf) {
        const r = ac.sampleRate, n = Math.round(r * 0.012), b = ac.createBuffer(1, n, r), d = b.getChannelData(0);
        for (let i = 0; i < n; i++) { const t = i / r; d[i] = 0.9 * Math.sin(2 * Math.PI * 2000 * t) * Math.min(1, t / 0.00025) * Math.exp(-t / 0.002); }
        lp.calBuf = b;
      }
      return lp.calBuf;
    }
    const CAL_AT = [0, 0.41, 0.85, 1.27, 1.72, 2.13, 2.57, 3.0];
    async function lpCalibrate() {
      if (lpBusy()) { say(T('אפשר לכוון אחרי שההקלטה מסתיימת.')); return; }
      const a = wake(); if (!a) { say(T('הדפדפן הזה לא תומך בצליל.')); return; }
      if (rec) endRec(true); halt(true); // the room has to be quiet
      const tok = lp.tok = {}; lp.calib = { tok }; setState('cal');
      const ok = await openMic();
      if (lp.tok !== tok) return;
      lp.tok = null;
      if (!ok) { lpAbort(false); return; }
      const m = lp.mic, t0 = a.currentTime + 0.6, times = CAL_AT.map(g => t0 + g), srcs = [];
      m.keep = true; m.chunks = [];
      times.forEach(t => { try { const s = a.createBufferSource(); s.buffer = lpCalBuf(); s.connect(kitBus); s.start(t); srcs.push(s); } catch (e) { /* ignore */ } });
      lp.calib = { tok, t0, times, srcs, need: Math.round((times[times.length - 1] + 0.5) * a.sampleRate), timer: setTimeout(() => { if (lp.calib && lp.calib.tok === tok) lpCalDone(); }, 6500) };
      say(T('מכייל. שקט בבקשה: נשמעות 8 נקישות.'));
    }
    // where a click starts: the first sample that reaches 40% of its loudest, after a filter that drops hum and rumble
    function lpOnset(x, from, to) {
      let pk = 0; for (let i = Math.max(1, from); i < to; i++) { const v = Math.abs(x[i] - x[i - 1]); if (v > pk) pk = v; }
      for (let i = Math.max(1, from); i < to; i++) if (Math.abs(x[i] - x[i - 1]) >= 0.4 * pk) return { i, pk };
      return { i: -1, pk };
    }
    function lpCalDone() {
      const c = lp.calib, m = lp.mic; if (!c || !m || !c.times) return;
      const rate = ac.sampleRate, Fa = Math.round((c.t0 - 0.25) * rate), x = lpRead(m, Fa, Math.max(1, c.need - Fa));
      const noise = lpOnset(x, Math.round(0.03 * rate), Math.round(0.2 * rate)).pk, ref = lpOnset(lpCalBuf().getChannelData(0), 1, lpCalBuf().length).i;
      const ds = [];
      c.times.forEach(t => {
        const s = (t - c.t0 + 0.25) * rate, o = lpOnset(x, Math.round(s), Math.min(x.length, Math.round(s + 0.38 * rate)));
        if (o.i >= 0 && o.pk > Math.max(5 * noise, 0.0015)) ds.push((o.i - s - ref) / rate);
      });
      ds.sort((p, q) => p - q);
      const med = ds.length ? ds[ds.length >> 1] : -1, near = ds.filter(d => Math.abs(d - med) <= 0.0025).length;
      // six of the eight clicks have to agree within 2.5 ms, or the measurement is thrown away
      if (near >= 6 && med >= 0 && med < 0.45) {
        const off = Math.round((med - lpEstimate()) * 10000) / 10;
        lpAbort(false); lpSync(off, 0); say(F('הכיול הצליח. ההשהיה שנמדדה: {0} ms.', Math.round(med * 1000)));
      } else { lpAbort(false); say(T('הכיול לא הצליח. הוציאו אוזניות, הגבירו את העוצמה ונסו שוב בחדר שקט.')); }
    }

    /* what the player sees */
    function lpText() {
      const st = lp.state, n = lp.layers.length, u = lp.ui || {}, bars = lp.steps ? lp.steps / 16 : lp.bars, bar = Math.min(bars, u.bar || 1);
      let t;
      if (st === 'open') t = T('פותח את המיקרופון…');
      else if (st === 'cal') t = T('מכייל… שקט בבקשה.');
      else if (st === 'pre') t = T('ממתין לתחילת התיבה…');
      else if (st === 'count') t = F('ספירה: {0}', u.beat || 1);
      else if (st === 'rec') t = F('מקליט… תיבה {0} מתוך {1}', bar, bars);
      else if (st === 'wait') t = T('ממתין לתחילת הלופ…') + ' ' + F('תיבה {0} מתוך {1}', bar, bars);
      else if (st === 'dub') t = F('מקליט שכבה {0}…', n + 1) + ' ' + F('תיבה {0} מתוך {1}', bar, bars);
      else if (st === 'play') t = F('מנגן לופ. שכבות: {0}', n) + ' · ' + F('תיבה {0} מתוך {1}', bar, bars);
      else if (st === 'stopped') t = F('הלופ עצור. שכבות: {0}', n);
      else t = lp.cleared ? T('הלופ נוקה. לחיצה נוספת משחזרת אותו.') : T('הלופ ריק.');
      if (loopText.textContent !== t) loopText.textContent = t;
    }
    function lpPaint() {
      const st = lp.state, n = lp.layers.length, recng = st === 'rec' || st === 'dub', busy = lpBusy();
      const [label, icon] = st === 'cal' ? [T('בטל כיול'), ICON.stop] : busy ? [T('בטל הקלטה'), ICON.stop] : st === 'play' ? [T('הוסף שכבה'), ICON.plus] : st === 'stopped' ? [T('נגן לופ'), ICON.play] : [T('הקלט לופ'), ICON.rec];
      const lb = loopMain.querySelector('.bt-lbl'); if (lb.textContent !== label) { lb.textContent = label; loopMain.querySelector('svg').innerHTML = icon; }
      loopMain.classList.toggle('is-busy', busy); loopBox.classList.toggle('is-rec', recng); loopBox.classList.toggle('is-count', st === 'count');
      lpText(); loopMic.hidden = !lp.mic;
      undoB.setAttribute('aria-disabled', String(!(n || busy)));
      const back = !!lp.cleared && !n && !busy; wipeB.querySelector('.bt-lbl').textContent = back ? T('שחזר לופ') : T('נקה לופ');
      wipeB.setAttribute('aria-disabled', String(!(n || busy || lp.cleared)));
      const bars = lp.steps ? lp.steps / 16 : lp.bars, fixed = lpLocked() || busy;
      lenSeg.querySelectorAll('button').forEach(b => { const on = +b.dataset.bars === bars; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-disabled', String(fixed && !on)); });
      if (+loopBarsEl.dataset.n !== bars) { loopBarsEl.dataset.n = bars; loopBarsEl.textContent = ''; for (let i = 0; i < bars * 4; i++) loopBarsEl.appendChild(el('i', i % 4 === 0 ? 'b' : '')); }
      if (!playing || !lp.cycles.length) { lp.w = ''; loopFill.style.width = '0%'; }
      const lock = lpLocked(); tempoIn.disabled = lock; lockNote.hidden = !lock;
      if (lock) tempoIn.setAttribute('aria-describedby', lockNote.id); else tempoIn.removeAttribute('aria-describedby');
      syncVal.textContent = lpSigned(lp.nudge);
      syncInfo.textContent = lp.calOff != null ? T('המכשיר כויל. אפשר לכייל שוב אחרי החלפת אוזניות או רמקול.') : T('עוד לא כויל: ההשהיה מוערכת לפי מה שהדפדפן מדווח.');
      [calB, earlyB, lateB, resetB].forEach(b => b.setAttribute('aria-disabled', String(busy)));
    }
    function lpShow(ui) { if (ui) { lp.ui = ui; lpText(); } }
    // the loop's place, as heard. With reduced motion the bar fills beat by beat instead of sliding
    function lpProgress(now) {
      let f = 0;
      if (lp.steps) for (let i = lp.cycles.length - 1; i >= 0; i--) { const c = lp.cycles[i]; if (c.t <= now) { f = Math.min(1, (now - c.t) / lp.len); break; } }
      if (reduce) { const b = lp.steps / 4; f = Math.floor(f * b + 1e-6) / b; }
      const w = (f * 100).toFixed(1) + '%'; if (w !== lp.w) { lp.w = w; loopFill.style.width = w; }
    }
    loopMain.addEventListener('click', lpMain);
    // Space presses the big button from anywhere in the looper, except on a control that has its own Space
    loopBox.addEventListener('keydown', e => {
      if ((e.key !== ' ' && e.key !== 'Spacebar') || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target.closest('button, input, select, textarea, summary, a')) return;
      e.preventDefault(); lpMain();
    });
    undoB.addEventListener('click', lpUndo); wipeB.addEventListener('click', lpClear);
    earlyB.addEventListener('click', () => lpNudge(5)); lateB.addEventListener('click', () => lpNudge(-5));
    resetB.addEventListener('click', () => { if (lpBusy()) { say(T('אפשר לכוון אחרי שההקלטה מסתיימת.')); return; } lpSync(null, 0); say(T('הסנכרון אופס.')); });
    calB.addEventListener('click', lpCalibrate);
    const lpDebug = () => ({ state: lp.state, bars: lp.bars, steps: lp.steps, tick0: lp.tick0, len: lp.len, layers: lp.layers.map(l => l.pcm.length), mic: !!lp.mic, tap: lp.tap || '', comp: lp.comp || 0,
      est: lpEstimate(), calOff: lp.calOff, nudge: lp.nudge, cycles: lp.cycles.map(c => c.t), cleared: !!lp.cleared, text: loopText.textContent });

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

    paintPads(); renderSeq(); paintPlay(); lpPaint();

    function prepare() {
      const a = wake(); if (!a) { say(T('הדפדפן הזה לא תומך בצליל.')); return Promise.resolve(0); }
      const k = kit;
      if (pads().every(p => buf[k + ':' + p[0]])) return Promise.resolve(16);
      say(T('מכין צלילים…'));
      return loadKit(a, k).then(n => { if (k === kit) say(n > 0 ? T('הפדים מוכנים. נגנו!') : T('הצלילים לא נטענו. בדקו את החיבור ונסו שוב.')); flush(); return n; });
    }
    // leaving the tab: silence, microphone closed, out of full screen, the phone's audio mode as it was
    function stop() {
      halt(true); lpQuiet(); if (rec) endRec(true);
      if (lp.cleared) { lp.cleared = null; lpPaint(); }
      if (root.classList.contains('is-full')) setFull(false);
      waiting = [];
      try { if (sess != null) { navigator.audioSession.type = sess; sess = null; } } catch (e) { /* not supported */ }
    }
    const latency = () => ac ? { state: ac.state, rate: ac.sampleRate, base: Math.round((ac.baseLatency || 0) * 1000), output: Math.round((ac.outputLatency || 0) * 1000) } : null;
    // for tests: the steps as they were handed to the audio clock
    const debug = () => ({ playing, bpm, swing, kit, sel, recording: !!rec, steps: sched.map(e => ({ n: e.n, step: e.step, t: e.t, pads: Object.keys(e.v).map(Number) })), pat: pat.map(r => r.join('')), mine: Object.keys(userPcm), restored, looper: lpDebug() });
    return { prepare, stop, latency, debug, loopLayer: i => lp.layers[i] ? lp.layers[i].pcm : null };
  }
  window.SoniqBeats = { mount, KITS, KEYS };
})();
