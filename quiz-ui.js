/* ══════════════════════════════════════════════════════════
   quiz-ui.js  —  interactive quiz screens for viewer.html
   ──────────────────────────────────────────────────────────
   Needs quiz-core.js loaded first. Started by viewer.html:

     QuizUI.start({ mode: 'file',  file, text, ... })   one quiz file
     QuizUI.start({ mode: 'mixed', stem, dir, ... })    every quiz file of one video

   Screens: setup → question (→ after answering) → summary.
   ══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const C = window.QuizCore;
  if (!C) return;

  /* ══════════════════════════════════════════════════════
     SMALL HELPERS
     ══════════════════════════════════════════════════════ */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(label, cls, onClick) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  // Renders **bold** as <strong>; everything else as plain text (never HTML).
  function md(parent, text) {
    String(text || '').split(/\*\*(.+?)\*\*/g).forEach((part, i) => {
      if (!part) return;
      if (i % 2) parent.appendChild(el('strong', null, part));
      else parent.appendChild(document.createTextNode(part.replace(/\*\*/g, '')));
    });
    return parent;
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function plural(n, one, many) { return n === 1 ? `1 ${one}` : `${n} ${many}`; }
  function fileLabel(path) {
    const m = String(path).match(/quiz(\d*)\.txt$/i);
    return m && m[1] ? `Quiz ${m[1]}` : 'Quiz';
  }
  function formatDate(yymmdd) {
    if (!/^\d{6}$/.test(yymmdd || '')) return '';
    const d = new Date(2000 + +yymmdd.slice(0, 2), +yymmdd.slice(2, 4) - 1, +yymmdd.slice(4, 6));
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  // Only plain relative paths inside the site (no "..", no other sites).
  function safePath(p) {
    return typeof p === 'string' && /^[A-Za-z0-9_\-./]+$/.test(p) && !p.includes('..') && !p.startsWith('/');
  }

  async function fetchText(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }
  async function exists(path) {
    try { return (await fetch(path, { method: 'HEAD' })).ok; } catch (e) { return false; }
  }
  async function probe(base, prefix) {
    const out = [];
    for (let i = 1; i <= 20; i++) {
      const p = `${base}-${prefix}${pad2(i)}.txt`;
      if (await exists(p)) out.push(p); else break;
    }
    return out;
  }
  // Which quiz / vocab / transcript files exist for one video.
  async function discover(dir, stem) {
    try {
      const r = await fetch('site-index.json', { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        const e = j && j.entries && j.entries[stem];
        if (e) {
          return {
            quiz:  (Array.isArray(e.quiz)  ? e.quiz  : []).filter(safePath),
            vocab: (Array.isArray(e.vocab) ? e.vocab : []).filter(safePath),
            transcript: safePath(e.transcript) ? e.transcript : null
          };
        }
      }
    } catch (e) { /* no index: check files directly */ }
    const base = `${dir}/${stem}`;
    const [quiz, vocab, hasT] = await Promise.all([probe(base, 'quiz'), probe(base, 'vocab'), exists(base + '.txt')]);
    return { quiz, vocab, transcript: hasT ? base + '.txt' : null };
  }
  // Era label + title from entries.json (best effort).
  async function entryInfo(stem) {
    try {
      const r = await fetch('entries.json', { cache: 'no-cache' });
      if (!r.ok) return null;
      const j = await r.json();
      for (const era of (j.eras || [])) {
        for (const e of (era.entries || [])) {
          const s = `hwasa-${era.key}-${String(e.date).trim()}` + (e.slug ? `-${String(e.slug).trim()}` : '');
          if (s === stem) return { era: era.label || era.key, title: e.title || '', date: String(e.date).trim() };
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ══════════════════════════════════════════════════════
     STATE
     ══════════════════════════════════════════════════════ */
  const S = {
    opts: null,
    progress: null,
    mode: 'file',
    key: '',
    stem: '',
    dir: '',
    files: [],            // [{ path, label, questions, problems }]
    byId: new Map(),      // id → { q, label, source, path }
    info: null,
    found: null,          // discover() result
    ctx: null,            // Promise → { vocab, lines, transcript, audioUrl, audioOk }
    ctxCache: new Map(),
    setup: { selected: new Set(), size: 10, other: false, otherValue: 15, focus: true },
    session: null,
    screen: 'loading',
    root: null,
    // practice (vocab) mode
    kind: 'cards',
    allWords: [],
    okCache: new Map(),
    voiceOk: false,
    revealed: new Set()
  };

  const KINDS = {
    cards:  { title: 'Flashcards',        hint: 'See the word, then rate yourself.', leftOut: '' },
    mc:     { title: 'Vocab quiz',        hint: 'Pick the meaning or the word.', leftOut: 'not enough different meanings to build wrong options.' },
    blank:  { title: 'Fill in the blank', hint: 'Hwasa’s sentence with the word missing.', leftOut: 'no sentence where the word can be blanked.' },
    listen: { title: 'Listening',         hint: 'Hear the word, pick its meaning.', leftOut: 'no meaning to choose from.' }
  };
  function practiceKey() { return 'practice:' + S.kind + ':' + S.stem; }

  /* ══════════════════════════════════════════════════════
     START
     Returns false (file mode) when the file has no readable
     questions, so the viewer can show the plain text instead.
     ══════════════════════════════════════════════════════ */
  function start(opts) {
    S.opts = opts;
    S.mode = opts.mode === 'mixed' ? 'mixed' : opts.mode === 'practice' ? 'practice' : 'file';
    S.progress = new C.Progress();

    if (S.mode === 'practice') return startPractice(opts);

    if (S.mode === 'file') {
      const parsed = C.parseQuiz(opts.text || '');
      if (!parsed || !parsed.questions.length) return false;
      const m = opts.file.match(/^(.*)\/([^/]+?)-quiz\d*\.txt$/i);
      S.dir = m ? m[1] : '';
      S.stem = m ? m[2] : '';
      S.key = 'file:' + opts.file;
      addFile(opts.file, parsed);
      if (opts.nameEl) opts.nameEl.textContent = fileLabel(opts.file);
      addTextLink();
      afterLoad();
      return true;
    }

    S.stem = opts.stem || '';
    S.dir = opts.dir || '';
    S.key = 'mixed:' + S.stem;
    if (opts.nameEl) opts.nameEl.textContent = 'Mixed quiz';
    if (!/^[A-Za-z0-9_\-.]+$/.test(S.stem) || (S.dir && !safePath(S.dir))) {
      showMessage('This mixed quiz link is not valid.');
      return true;
    }
    showMessage('Loading quiz…');
    (async () => {
      S.found = await discover(S.dir, S.stem);
      const texts = await Promise.all(S.found.quiz.map(p => fetchText(p).catch(() => null)));
      const skipped = [];
      S.found.quiz.forEach((p, i) => {
        const parsed = texts[i] ? C.parseQuiz(texts[i]) : null;
        if (parsed && parsed.questions.length) addFile(p, parsed);
        else skipped.push(fileLabel(p));
      });
      if (!S.files.length) {
        showMessage('No quiz files with readable questions were found for this video.');
        return;
      }
      S.loadNotes = skipped.map(l => `${l}: could not be read, left out`);
      afterLoad();
    })().catch(() => showMessage('The quiz could not be loaded.'));
    return true;
  }

  /* ── Practice from vocab lists: viewer.html?practice=<stem>&dir=…[&kind=…][&only=<vocab file>] ── */
  function startPractice(opts) {
    S.stem = opts.stem || '';
    S.dir = opts.dir || '';
    S.kind = KINDS[opts.kind] ? opts.kind : 'cards';
    S.key = practiceKey();
    if (opts.nameEl) opts.nameEl.textContent = 'Practice';
    if (!/^[A-Za-z0-9_\-.]+$/.test(S.stem) || (S.dir && !safePath(S.dir))) {
      showMessage('This practice link is not valid.');
      return true;
    }
    showMessage('Loading words…');
    (async () => {
      const [found, voiceOk] = await Promise.all([discover(S.dir, S.stem), Voice.available()]);
      S.found = found;
      S.voiceOk = voiceOk;
      const texts = await Promise.all(found.vocab.map(p => fetchText(p).catch(() => null)));
      found.vocab.forEach((p, i) => {
        const entries = texts[i] ? C.parseVocab(texts[i]) : [];
        if (!entries.length) return;
        const vm = p.match(/vocab(\d+)\.txt$/i);
        const label = vm ? `Vocab ${vm[1]}` : 'Vocab';
        const words = C.vocabWords(entries, label, p);
        S.files.push({ path: p, label, questions: words, problems: [] });
        words.forEach(w => {
          if (!S.byId.has(w.id)) S.byId.set(w.id, { word: w, label, source: w.num != null ? `${label} · ${w.num}` : label, path: p });
        });
        S.setup.selected.add(p);
      });
      if (!S.files.length) { showMessage('No vocab lists were found for this video.'); return; }
      S.allWords = Array.from(S.byId.values()).map(x => x.word);
      if (opts.only && S.files.some(f => f.path === opts.only)) S.setup.selected = new Set([opts.only]);
      afterLoad();
    })().catch(() => showMessage('The practice words could not be loaded.'));
    return true;
  }

  // Exercise picker on the practice setup screen.
  function kindPicker() {
    const grp = el('div', 'qz-group');
    grp.appendChild(el('div', 'qz-label', 'Exercise'));
    const grid = el('div', 'qz-kinds');
    Object.keys(KINDS).forEach(k => {
      const b = button('', 'qz-kind', () => {
        if (k === S.kind) return;
        S.kind = k;
        S.key = practiceKey();
        S.session = null;
        S.revealed.clear();
        restoreSession();
        try {
          const u = new URL(window.location.href);
          u.searchParams.set('kind', k);
          history.replaceState(null, '', u.pathname + u.search);
        } catch (e) { /* ignore */ }
        renderSetup();
      });
      b.append(el('span', 'qz-kind-name', KINDS[k].title), el('span', 'qz-hint', KINDS[k].hint));
      const on = k === S.kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      if (k === 'listen' && !S.voiceOk) {
        b.disabled = true;
        b.lastChild.textContent = 'Needs a Korean voice on this device.';
      }
      grid.appendChild(b);
    });
    grp.appendChild(grid);
    return grp;
  }

  function sayButton(text) {
    const b = button('', 'qz-play vc-say', () => Voice.say(text));
    b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M19 5a10 10 0 0 1 0 14"></path></svg>';
    b.appendChild(el('span', null, 'Say the word'));
    b.setAttribute('aria-label', 'Say the word ' + text);
    return b;
  }

  // The word's own entry: Korean (optional), FR, EN.
  function wordNote(q, withHead) {
    const w = q.word;
    const box = el('section', 'qz-expl qz-word');
    if (withHead) {
      box.appendChild(el('div', 'qz-label', 'The word'));
      const head = el('div', 'qz-word-head');
      const ko = el('span', 'qz-word-ko', w.headword);
      ko.lang = 'ko';
      head.appendChild(ko);
      if (w.pos || w.level) head.appendChild(el('span', 'qz-hint', [w.pos, w.level].filter(Boolean).join(' · ')));
      box.appendChild(head);
    }
    if (w.fr) { const f = el('div', 'qz-word-line', 'FR: ' + w.fr); f.lang = 'fr'; box.appendChild(f); }
    if (w.en) box.appendChild(el('div', 'qz-word-line', 'EN: ' + w.en));
    if (withHead && S.voiceOk) {
      const row = el('div', 'qz-ctx-actions');
      row.appendChild(sayButton(w.headword));
      box.appendChild(row);
    }
    return box;
  }

  function addFile(path, parsed) {
    const label = fileLabel(path);
    S.files.push({ path, label, questions: parsed.questions, problems: parsed.problems });
    parsed.questions.forEach(q => {
      if (!S.byId.has(q.id)) S.byId.set(q.id, { q, label, source: `${label} · Q${q.num}`, path });
    });
    S.setup.selected.add(path);
  }

  function afterLoad() {
    entryInfo(S.stem).then(info => {
      S.info = info;
      const k = document.querySelector('.qz-kicker');
      if (k) k.textContent = kickerText();
    });
    // Start fetching vocab + transcript in the background for "In the video".
    loadContext();
    restoreSession();
    bindKeys();
    renderSetup();
  }

  function addTextLink() {
    const header = S.opts.nameEl && S.opts.nameEl.parentElement;
    if (!header || header.querySelector('.qz-textlink')) return;
    const a = el('a', 'qz-textlink', 'Show as text');
    a.href = 'viewer.html?file=' + encodeURIComponent(S.opts.file) + '&view=text';
    header.appendChild(a);
  }

  function showMessage(text) {
    hidePill();
    const root = el('div', 'qz');
    root.appendChild(el('p', 'qz-status', text));
    if (!/Loading/.test(text)) {
      const a = el('a', 'qz-link', '← Back to index');
      a.href = 'index.html';
      root.appendChild(a);
    }
    mount(root);
  }

  function mount(root) {
    S.root = root;
    S.opts.container.replaceChildren(root);
  }

  function kickerText() {
    const d = (S.info && S.info.date) || ((S.stem.match(/-(\d{6})(?:-|$)/) || [])[1]) || '';
    const parts = [];
    if (S.info && S.info.era) parts.push(S.info.era);
    if (d) parts.push(formatDate(d));
    return parts.join(' · ');
  }

  /* ══════════════════════════════════════════════════════
     "IN THE VIDEO": vocab + transcript + audio
     ══════════════════════════════════════════════════════ */
  function loadContext() {
    if (S.ctx) return S.ctx;
    S.ctx = (async () => {
      const found = S.found || await discover(S.dir, S.stem);
      const [vocabTexts, tText] = await Promise.all([
        Promise.all(found.vocab.map(p => fetchText(p).catch(() => ''))),
        found.transcript ? fetchText(found.transcript).catch(() => '') : Promise.resolve('')
      ]);
      const vocab = [].concat(...vocabTexts.map(C.parseVocab));
      const lines = C.parseTranscriptLines(tText);
      let audioUrl = null, audioOk = false;
      if (found.transcript && S.opts.r2Base) {
        audioUrl = audioUrlFor(found.transcript, S.opts.r2Base);
        audioOk = await audioExists(audioUrl);
      }
      return { vocab, lines, transcript: found.transcript, audioUrl, audioOk };
    })().catch(() => ({ vocab: [], lines: [], transcript: null, audioUrl: null, audioOk: false }));
    return S.ctx;
  }

  // Same rule as the transcript viewer: transcripts/x/hwasa-…txt → <R2>/audio/x/….mp3
  function audioUrlFor(transcriptPath, r2Base) {
    return r2Base + '/' + transcriptPath
      .replace('transcripts/', 'audio/')
      .replace('.txt', '.mp3')
      .replace(/\/hwasa-/, '/');
  }
  async function audioExists(url) {
    try { return (await fetch(url, { method: 'HEAD', cache: 'no-store' })).ok; } catch (e) { return false; }
  }

  /* ── Built-in Korean voice (free, from the phone/browser) ── */
  const Voice = {
    voice: null,
    ready: null,
    // Resolves true when a Korean voice exists (or the device doesn't list voices but can speak).
    available() {
      if (this.ready) return this.ready;
      this.ready = new Promise(resolve => {
        if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') { resolve(false); return; }
        const pick = () => {
          const list = window.speechSynthesis.getVoices() || [];
          if (!list.length) return null;
          this.voice = list.find(v => /^ko(-|_|$)/i.test(v.lang)) || null;
          return !!this.voice;
        };
        const now = pick();
        if (now !== null) { resolve(now); return; }
        let done = false;
        const finish = () => { if (done) return; done = true; const r = pick(); resolve(r === null ? true : r); };
        window.speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
        setTimeout(finish, 1500);
      });
      return this.ready;
    },
    say(text) {
      if (!('speechSynthesis' in window)) return;
      Clip.stop();
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      if (this.voice) u.voice = this.voice;
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    }
  };

  const Clip = {
    audio: null, src: '', stopAt: 0, btn: null,
    toggle(url, start, end, btn) {
      if (this.btn === btn) { this.stop(); return; }
      this.stop();
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      if (!this.audio) {
        this.audio = new Audio();
        this.audio.preload = 'none';
        this.audio.addEventListener('timeupdate', () => {
          if (this.audio.currentTime >= this.stopAt) this.stop();
        });
        this.audio.addEventListener('ended', () => this.stop());
        this.audio.addEventListener('error', () => this.stop());
      }
      if (this.src !== url) { this.audio.src = url; this.src = url; }
      this.stopAt = end;
      this.btn = btn;
      setPlaying(btn, true);
      const go = () => {
        try { this.audio.currentTime = start; } catch (e) { /* not ready */ }
        const p = this.audio.play();
        if (p && p.catch) p.catch(() => this.stop());
      };
      if (this.audio.readyState >= 1) go();
      else { this.audio.addEventListener('loadedmetadata', go, { once: true }); this.audio.load(); }
    },
    stop() {
      if (this.audio && !this.audio.paused) this.audio.pause();
      if (this.btn) setPlaying(this.btn, false);
      this.btn = null;
    }
  };
  function setPlaying(btn, on) {
    btn.classList.toggle('playing', on);
    btn.querySelector('.qz-play-label').textContent = on ? 'Stop' : 'Play clip';
    btn.setAttribute('aria-pressed', String(on));
  }

  function contextBox(q) {
    const box = el('section', 'qz-ctx');
    box.hidden = true;
    loadContext().then(ctx => {
      let c = S.ctxCache.get(q.id);
      if (c === undefined) {
        if (q.word) {
          // Practice word: its own Context line, translations from the transcript.
          const l = q.word.ts ? C.lineAt(q.word.ts, ctx.lines) : null;
          c = q.word.ts ? { ts: q.word.ts, ko: q.word.contextKo, fr: l ? l.fr : '', en: l ? l.en : '' } : null;
        } else {
          c = C.findContext(q, ctx.vocab, ctx.lines);
        }
        S.ctxCache.set(q.id, c);
      }
      if (!c || !box.isConnected) return;

      box.appendChild(el('div', 'qz-label', 'In the video'));
      const line = el('div', 'qz-ctx-line');
      line.appendChild(el('span', 'qz-ctx-ts', C.normTs(c.ts)));
      const ko = el('span', 'qz-ctx-ko', c.ko);
      ko.lang = 'ko';
      line.appendChild(ko);
      box.appendChild(line);
      // Translations of that line (from the transcript), styled like search results.
      if (c.fr || c.en) {
        const tr = el('div', 'qz-ctx-tr');
        if (c.fr) { const f = el('div', null, c.fr); f.lang = 'fr'; tr.appendChild(f); }
        if (c.en) { const e = el('div', null, c.en); e.lang = 'en'; tr.appendChild(e); }
        box.appendChild(tr);
      }

      const actions = el('div', 'qz-ctx-actions');
      if (ctx.audioOk && ctx.audioUrl) {
        const startSec = C.tsToSeconds(c.ts);
        const b = button('', 'qz-play', () => Clip.toggle(ctx.audioUrl, startSec, C.clipEnd(startSec, ctx.lines), b));
        b.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><polygon points="6 4 20 12 6 20" fill="currentColor"></polygon></svg>';
        b.appendChild(el('span', 'qz-play-label', 'Play clip'));
        b.setAttribute('aria-pressed', 'false');
        actions.appendChild(b);
      }
      if (ctx.transcript) {
        const a = el('a', 'qz-link', 'Open in transcript →');
        a.href = 'viewer.html?file=' + encodeURIComponent(ctx.transcript) + '&t=' + encodeURIComponent(C.normTs(c.ts));
        actions.appendChild(a);
      }
      if (actions.children.length) box.appendChild(actions);
      box.hidden = false;
    });
    return box;
  }

  /* ══════════════════════════════════════════════════════
     SESSIONS
     ══════════════════════════════════════════════════════ */
  function restoreSession() {
    const saved = S.progress.getSession(S.key);
    if (!saved || !Array.isArray(saved.ids)) return;
    // Drop questions that no longer exist (file replaced or edited).
    const ids = saved.ids.filter(id => S.byId.has(id) && (!saved.gen || saved.gen[id]));
    if (!ids.length) { S.progress.clearSession(S.key); return; }
    const answers = {};
    Object.keys(saved.answers || {}).forEach(id => { if (S.byId.has(id)) answers[id] = saved.answers[id]; });
    S.session = {
      v: 1, ids, answers,
      idx: Math.min(Math.max(0, saved.idx | 0), ids.length - 1),
      settings: saved.settings || {},
      startGroups: saved.startGroups || {},
      started: saved.started || Date.now(),
      gen: saved.gen || null,
      retry: false
    };
    // Setup defaults follow the saved quiz.
    const st = S.session.settings;
    if (Array.isArray(st.files) && S.mode !== 'file') {
      const sel = st.files.filter(p => S.files.some(f => f.path === p));
      if (sel.length) S.setup.selected = new Set(sel);
    }
    if (typeof st.focus === 'boolean') S.setup.focus = st.focus;
    if (st.size) {
      if (st.size === 5 || st.size === 10) { S.setup.size = st.size; S.setup.other = false; }
      else { S.setup.other = true; S.setup.otherValue = st.size; }
    }
  }

  function saveSession() {
    if (S.session && !S.session.retry) S.progress.setSession(S.key, S.session);
  }

  // The question shown for an id: generated (practice) or from a quiz file.
  function getQ(id) {
    const s = S.session;
    if (s && s.gen && s.gen[id]) return s.gen[id];
    const it = S.byId.get(id);
    return it ? it.q : null;
  }

  function answeredCount(s) { return s.ids.filter(id => s.answers[id]).length; }
  function correctCount(s) { return s.ids.filter(id => s.answers[id] && s.answers[id] === getQ(id).answer).length; }

  /* ══════════════════════════════════════════════════════
     SCREEN 1: SETUP
     ══════════════════════════════════════════════════════ */
  function pool() {
    const ids = [], seen = new Set();
    let dups = 0;
    S.files.forEach(f => {
      if (!S.setup.selected.has(f.path)) return;
      f.questions.forEach(q => {
        if (S.mode === 'practice' && !eligible(q.id)) return;
        if (seen.has(q.id)) { dups++; return; }
        seen.add(q.id);
        ids.push(q.id);
      });
    });
    return { ids, dups };
  }

  function eligible(id) {
    const key = S.kind + ':' + id;
    if (!S.okCache.has(key)) {
      const ok = S.kind === 'listen' && !S.voiceOk ? false : C.canPractice(S.kind, S.byId.get(id).word, S.allWords);
      S.okCache.set(key, ok);
    }
    return S.okCache.get(key);
  }

  function chosenSize(max) {
    const n = S.setup.other ? parseInt(S.setup.otherValue, 10) : S.setup.size;
    return Math.max(1, Math.min(isNaN(n) ? max : n, max));
  }

  function renderSetup() {
    S.screen = 'setup';
    hidePill();
    Clip.stop();
    const root = el('div', 'qz qz-setup');

    root.appendChild(el('div', 'qz-kicker', kickerText()));
    root.appendChild(el('h1', 'qz-title', S.mode === 'practice' ? KINDS[S.kind].title
      : S.mode === 'mixed' ? 'Mixed quiz' : S.files[0].label));
    const sub = el('p', 'qz-sub');
    root.appendChild(sub);
    if (S.mode === 'practice') root.appendChild(kindPicker());

    // Problems found while reading the files
    const notes = [].concat(S.loadNotes || []);
    S.files.forEach(f => f.problems.forEach(p => notes.push(S.mode === 'mixed' ? `${f.label}: ${p}` : p)));
    if (notes.length) {
      const n = el('div', 'qz-notice');
      n.appendChild(el('strong', null, 'Some questions were left out'));
      const ul = el('ul');
      notes.forEach(t => ul.appendChild(el('li', null, t)));
      n.appendChild(ul);
      root.appendChild(n);
    }
    if (!S.progress.ok) {
      root.appendChild(el('div', 'qz-notice', 'This browser is not saving data (private window or blocked storage). The quiz works, but progress will not be kept.'));
    }

    // Resume card
    const s = S.session;
    if (s && !s.retry && answeredCount(s) < s.ids.length) {
      const card = el('div', 'qz-card');
      card.appendChild(el('div', 'qz-card-title', S.mode === 'practice' ? `${KINDS[S.kind].title} in progress` : 'Quiz in progress'));
      card.appendChild(el('div', 'qz-card-text', `${answeredCount(s)} of ${s.ids.length} answered · ${correctCount(s)} correct`));
      const row = el('div', 'qz-row');
      row.appendChild(button('Resume', 'qz-btn qz-btn-dark', () => { renderQuestion(true); }));
      row.appendChild(button('Start over', 'qz-btn', () => {
        S.progress.clearSession(S.key);
        S.session = null;
        renderSetup();
      }));
      card.appendChild(row);
      root.appendChild(card);
    }

    // Which files (mixed quiz and practice)
    let dupNote = null;
    if (S.mode === 'mixed' || (S.mode === 'practice' && S.files.length > 1)) {
      const grp = el('div', 'qz-group');
      grp.appendChild(el('div', 'qz-label', 'Include'));
      S.files.forEach((f, i) => {
        const lab = el('label', 'qz-check');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.id = 'qzf' + i;
        cb.checked = S.setup.selected.has(f.path);
        cb.addEventListener('change', () => {
          if (cb.checked) S.setup.selected.add(f.path); else S.setup.selected.delete(f.path);
          refresh();
        });
        lab.htmlFor = cb.id;
        lab.append(cb, el('span', 'qz-check-name', f.label), el('span', 'qz-check-count',
          S.mode === 'practice' ? plural(f.questions.length, 'word', 'words') : plural(f.questions.length, 'question', 'questions')));
        grp.appendChild(lab);
      });
      dupNote = el('div', 'qz-hint');
      grp.appendChild(dupNote);
      root.appendChild(grp);
    }

    // How many
    const sizeGrp = el('div', 'qz-group');
    sizeGrp.appendChild(el('div', 'qz-label', 'How many'));
    const seg = el('div', 'qz-seg');
    const b5 = button('5', 'qz-pillbtn', () => { S.setup.size = 5; S.setup.other = false; refresh(); });
    const b10 = button('10', 'qz-pillbtn', () => { S.setup.size = 10; S.setup.other = false; refresh(); });
    const bOther = button('Other', 'qz-pillbtn', () => { S.setup.other = true; refresh(); input.focus(); });
    seg.append(b5, b10, bOther);
    sizeGrp.appendChild(seg);
    const otherRow = el('div', 'qz-other');
    const otherLab = el('label', null, 'Number of questions');
    const input = el('input');
    input.type = 'number';
    input.id = 'qzCount';
    input.inputMode = 'numeric';
    input.min = '1';
    input.value = String(S.setup.otherValue);
    otherLab.htmlFor = 'qzCount';
    const ofMax = el('span', 'qz-hint');
    input.addEventListener('input', () => { S.setup.otherValue = input.value; });
    input.addEventListener('change', () => {
      const max = pool().ids.length;
      let v = parseInt(input.value, 10);
      if (isNaN(v) || v < 1) v = 1;
      if (v > max) v = max;
      S.setup.otherValue = v;
      input.value = String(v);
    });
    otherRow.append(otherLab, input, ofMax);
    sizeGrp.appendChild(otherRow);
    root.appendChild(sizeGrp);

    // Focus switch
    const focusLab = el('label', 'qz-switch');
    const fcb = el('input');
    fcb.type = 'checkbox';
    fcb.id = 'qzFocus';
    fcb.setAttribute('role', 'switch');
    fcb.checked = S.setup.focus;
    fcb.addEventListener('change', () => { S.setup.focus = fcb.checked; });
    focusLab.htmlFor = 'qzFocus';
    const ftext = el('span', 'qz-switch-text');
    ftext.append(el('span', 'qz-switch-title', 'Focus on missed words'),
                 el('span', 'qz-hint', 'Words you missed come back more often, mixed with ones you know. Off: plain shuffle.'));
    focusLab.append(fcb, el('span', 'qz-switch-track'), ftext);
    root.appendChild(focusLab);

    const startLabel = S.mode === 'practice' ? 'Start' : 'Start new quiz';
    const startBtn = button(startLabel, 'qz-btn qz-btn-big', startNew);
    root.appendChild(startBtn);

    function refresh() {
      const { ids, dups } = pool();
      const max = ids.length;
      const nFiles = S.files.filter(f => S.setup.selected.has(f.path)).length;
      if (S.mode === 'practice') {
        const all = S.files.filter(f => S.setup.selected.has(f.path)).reduce((n, f) => n + f.questions.length, 0) - dups;
        sub.textContent = `${plural(max, 'word', 'words')} from ${plural(nFiles, 'vocab list', 'vocab lists')}.` +
          (max < all ? ` ${all - max} left out: ${KINDS[S.kind].leftOut}` : '');
      } else {
        sub.textContent = S.mode === 'mixed'
          ? `${plural(max, 'question', 'questions')} from ${plural(nFiles, 'quiz file', 'quiz files')}, shuffled.`
          : `${plural(max, 'question', 'questions')}, shuffled.`;
      }
      if (dupNote) {
        dupNote.textContent = S.mode === 'practice'
          ? (dups ? `${plural(dups, 'word appears', 'words appear')} in more than one list; each is used once.` : '')
          : dups
            ? `${plural(dups, 'duplicate question', 'duplicate questions')} merged, so each appears once.`
            : 'No duplicate questions found across these files.';
      }
      [[b5, !S.setup.other && S.setup.size === 5], [b10, !S.setup.other && S.setup.size === 10], [bOther, S.setup.other]]
        .forEach(([b, on]) => { b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on); });
      otherRow.hidden = !S.setup.other;
      input.max = String(max);
      ofMax.textContent = `of ${max}`;
      if (S.setup.other && parseInt(S.setup.otherValue, 10) > max) { S.setup.otherValue = max; input.value = String(max); }
      startBtn.disabled = max === 0;
      startBtn.textContent = max === 0 ? (S.mode === 'practice' ? 'No words available' : 'Pick at least one quiz') : startLabel;
    }
    refresh();
    mount(root);
  }

  function startNew() {
    const { ids } = pool();
    if (!ids.length) return;
    const n = chosenSize(ids.length);
    const order = C.buildQuiz(ids, n, { focus: S.setup.focus, history: id => S.progress.history(id) });
    let gen = null;
    S.revealed.clear();
    if (S.mode === 'practice') {
      gen = {};
      order.forEach(id => {
        const q = C.makeQuestion(S.kind, S.byId.get(id).word, S.allWords);
        if (q) gen[id] = q;
      });
      for (let i = order.length - 1; i >= 0; i--) if (!gen[order[i]]) order.splice(i, 1);
      if (!order.length) return;
    }
    const startGroups = {};
    order.forEach(id => { startGroups[id] = S.progress.group(id); });
    S.session = {
      v: 1, ids: order, answers: {}, idx: 0,
      settings: { files: Array.from(S.setup.selected), size: n, focus: S.setup.focus },
      startGroups, started: Date.now(), retry: false, gen, kind: S.mode === 'practice' ? S.kind : null
    };
    saveSession();
    renderQuestion(true);
  }

  /* ══════════════════════════════════════════════════════
     SCREEN 2: QUESTION (+ after answering)
     ══════════════════════════════════════════════════════ */
  function renderQuestion(fresh) {
    S.screen = 'question';
    Clip.stop();
    const s = S.session;
    const id = s.ids[s.idx];
    const item = S.byId.get(id);
    const q = getQ(id);
    const ans = s.answers[id] || null;
    const kind = q.kind || 'quiz';
    const total = s.ids.length;
    const root = el('div', 'qz qz-question');

    if (s.retry) root.appendChild(el('div', 'qz-practice', 'Practice round: answers here don’t change your progress.'));

    const bar = el('div', 'qz-bar');
    const fill = el('div', 'qz-bar-fill');
    fill.style.width = (answeredCount(s) / total * 100) + '%';
    bar.appendChild(fill);
    bar.setAttribute('aria-hidden', 'true');
    root.appendChild(bar);

    const meta = el('div', 'qz-meta');
    meta.appendChild(el('span', 'qz-label', `${kind === 'cards' ? 'Card' : 'Question'} ${s.idx + 1} of ${total}`));
    const metaRight = el('div', 'qz-meta-right');
    metaRight.appendChild(el('span', 'qz-tag', S.mode === 'file' ? `Q${q.num}` : item.source));
    const quitBtn = button('Quit', 'qz-quit-btn');
    quitBtn.setAttribute('aria-expanded', 'false');
    quitBtn.setAttribute('aria-controls', 'qzQuit');
    metaRight.appendChild(quitBtn);
    meta.appendChild(metaRight);
    root.appendChild(meta);

    // Quit choices (hidden until Quit is tapped)
    const quit = el('div', 'qz-quit');
    quit.id = 'qzQuit';
    quit.hidden = true;
    const nAnswered = answeredCount(s);
    quit.appendChild(el('div', 'qz-quit-title', s.retry ? 'Leave this practice round?' : 'Leave this quiz?'));
    const pauseBtn = button('', 'qz-quit-choice', pauseAndExit);
    pauseBtn.append(el('span', 'qz-quit-name', s.retry ? 'Exit to index' : 'Pause and exit'),
                    el('span', 'qz-hint', s.retry ? 'Practice answers are not saved.' : 'Saved as in progress. Resume any time.'));
    const endBtn = button('', 'qz-quit-choice', endQuizNow);
    endBtn.append(el('span', 'qz-quit-name', 'End quiz now'),
                  el('span', 'qz-hint', nAnswered
                    ? `See results for the ${plural(nAnswered, 'question', 'questions')} answered so far.`
                    : 'Nothing answered yet, so this just ends the quiz.'));
    const cancelBtn = button('Keep going', 'qz-btn', () => toggleQuit(false));
    quit.append(pauseBtn, endBtn, cancelBtn);
    root.appendChild(quit);
    quitBtn.addEventListener('click', () => toggleQuit(quit.hidden));
    function toggleQuit(open) {
      quit.hidden = !open;
      quitBtn.setAttribute('aria-expanded', String(open));
      if (open) pauseBtn.focus(); else quitBtn.focus();
    }
    S.toggleQuit = () => toggleQuit(quit.hidden);

    const h = el('h2', kind === 'cards' ? 'qz-q qz-cardword' : 'qz-q');
    h.tabIndex = -1;
    md(h, q.text);
    if (kind === 'cards') h.lang = 'ko';
    root.appendChild(h);
    if (q.hint) root.appendChild(el('p', 'qz-hint qz-qhint', q.hint));

    // Flashcard front: word tag + Say; Show answer until revealed.
    const revealed = kind !== 'cards' || ans || S.revealed.has(id);
    if (kind === 'cards') {
      const row = el('div', 'qz-row qz-cardrow');
      if (q.word.pos || q.word.level) row.appendChild(el('span', 'qz-tag', [q.word.pos, q.word.level].filter(Boolean).join(' · ')));
      if (S.voiceOk) row.appendChild(sayButton(q.word.headword));
      root.appendChild(row);
      if (!revealed) {
        root.appendChild(button('Show answer', 'qz-btn qz-btn-dark qz-btn-big qz-reveal', () => {
          S.revealed.add(id);
          renderQuestion(false);
        }));
      } else {
        root.appendChild(wordNote(q, false));
        root.appendChild(contextBox(q));
      }
    }
    // Listening: a big Hear button (spoken by the device's Korean voice).
    if (kind === 'listen') {
      const hear = button('', 'qz-hear', () => Voice.say(q.say));
      hear.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M19 5a10 10 0 0 1 0 14"></path></svg>';
      hear.appendChild(el('span', null, ans ? 'Hear it again' : 'Hear the word'));
      root.appendChild(hear);
      if (fresh && !ans) setTimeout(() => Voice.say(q.say), 250);
    }

    const list = el('div', kind === 'cards' ? 'qz-opts qz-opts-2' : 'qz-opts');
    if (kind === 'cards' && !revealed) list.hidden = true;
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Answer options');
    q.options.forEach(o => {
      const b = button('', 'qz-opt', () => answer(o.letter));
      const mark = el('span', 'qz-opt-mark', kind === 'cards' ? (o.letter === 'A' ? '1' : '2') : o.letter);
      const body = el('span', 'qz-opt-body');
      md(body.appendChild(el('span', 'qz-opt-text')), o.text);
      b.append(mark, body);
      if (ans) {
        b.disabled = true;
        const isRight = o.letter === q.answer;
        const isMine = o.letter === ans;
        if (kind === 'cards') {
          // Self-graded: only mark what you chose.
          b.classList.add(isMine ? (isRight ? 'is-right' : 'is-wrong') : 'is-dim');
        } else if (isRight) {
          b.classList.add('is-right');
          mark.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12 10 17 19 7"></polyline></svg>';
          body.appendChild(el('span', 'qz-opt-note', isMine ? 'Your answer · correct' : 'Correct answer'));
        } else if (isMine) {
          b.classList.add('is-wrong');
          mark.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg>';
          body.appendChild(el('span', 'qz-opt-note', 'Your answer'));
        } else {
          b.classList.add('is-dim');
        }
      }
      list.appendChild(b);
    });
    root.appendChild(list);

    const live = el('p', 'qz-sr');
    live.setAttribute('aria-live', 'polite');
    root.appendChild(live);

    let nextBtn = null;
    if (ans) {
      const right = ans === q.answer;
      live.textContent = kind === 'cards' ? (right ? 'Marked as known.' : 'Marked to review.')
        : right ? 'Correct.' : `Not quite. The answer is ${q.answer}.`;
      const after = el('div', 'qz-after');
      if (q.explanation) {
        const ex = el('section', 'qz-expl');
        ex.appendChild(el('div', 'qz-label', 'Why'));
        md(ex.appendChild(el('p', 'qz-expl-text')), q.explanation);
        after.appendChild(ex);
      }
      if (q.word && kind !== 'cards') after.appendChild(wordNote(q, true));
      if (kind !== 'cards') after.appendChild(contextBox(q));
      nextBtn = button(nextLabel(), 'qz-btn qz-btn-dark qz-btn-big', goNext);
      after.appendChild(nextBtn);
      root.appendChild(after);
    }

    mount(root);
    setPill(ans);

    if (fresh) {
      window.scrollTo(0, 0);
      h.focus({ preventScroll: true });
    } else if (nextBtn) {
      nextBtn.focus({ preventScroll: true });
      const after = root.querySelector('.qz-after');
      requestAnimationFrame(() => {
        const r = after.getBoundingClientRect();
        if (r.top > window.innerHeight - 120) after.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  function nextLabel() {
    const s = S.session;
    if (s.idx < s.ids.length - 1) return 'Next question';
    const left = s.ids.filter(id => !s.answers[id]).length;
    return left ? `Go to skipped (${left})` : 'See results';
  }

  function answer(letter) {
    const s = S.session;
    const id = s.ids[s.idx];
    if (s.answers[id]) return;
    s.answers[id] = letter;
    if (!s.retry) S.progress.record(id, letter === getQ(id).answer);
    saveSession();
    renderQuestion(false);
  }

  function goNext() {
    const s = S.session;
    if (s.idx < s.ids.length - 1) { s.idx++; saveSession(); renderQuestion(true); return; }
    // At the last question: once it is answered, go back to any skipped ones;
    // skipping the last question (or nothing left) shows the results.
    const cur = s.ids[s.idx];
    const firstOpen = s.ids.findIndex(id => !s.answers[id] && id !== cur);
    if (s.answers[cur] && firstOpen !== -1) { s.idx = firstOpen; saveSession(); renderQuestion(true); return; }
    renderSummary();
  }

  /* ── Quit: pause (keep as in progress) or end now (results so far) ── */
  function pauseAndExit() {
    Clip.stop();
    saveSession();
    const back = document.getElementById('backLink');
    if (back) back.click(); else window.location.href = 'index.html';
  }

  function endQuizNow() {
    const s = S.session;
    const answered = s.ids.filter(id => s.answers[id]);
    if (!s.retry) S.progress.clearSession(S.key);
    if (!answered.length) {
      S.session = null;
      renderSetup();
      window.scrollTo(0, 0);
      return;
    }
    s.ids = answered;          // unanswered questions are dropped, not counted as wrong
    s.endedEarly = true;
    renderSummary();
  }

  function goPrev() {
    const s = S.session;
    if (s.idx > 0) { s.idx--; saveSession(); renderQuestion(true); }
  }

  /* ── Bottom pill: Prev · score · Skip/Next ── */
  function setPill(answered) {
    const pill = S.opts.pill;
    if (!pill) return;
    const s = S.session;
    pill.replaceChildren();
    const prev = button('◀ Prev', null, goPrev);
    prev.disabled = s.idx === 0;
    const sep = () => el('div', 'pill-sep');
    const n = answeredCount(s);
    const score = el('span', 'qz-pill-score', n ? `${correctCount(s)} / ${n} correct` : `0 / ${s.ids.length}`);
    const next = button(answered ? 'Next ▶' : 'Skip ▶', null, goNext);
    pill.append(prev, sep(), score, sep(), next);
    pill.classList.add('visible');
  }
  function hidePill() {
    const pill = S.opts && S.opts.pill;
    if (pill) { pill.classList.remove('visible'); pill.replaceChildren(); }
  }

  /* ══════════════════════════════════════════════════════
     SCREEN 3: SUMMARY
     ══════════════════════════════════════════════════════ */
  function renderSummary() {
    S.screen = 'summary';
    hidePill();
    Clip.stop();
    const s = S.session;
    const total = s.ids.length;
    const correct = correctCount(s);
    const skipped = s.ids.filter(id => !s.answers[id]);
    const missed = s.ids.filter(id => s.answers[id] && s.answers[id] !== getQ(id).answer);
    const finished = !skipped.length;

    let best = null;
    if (!s.retry && finished && !s.endedEarly) {
      best = S.progress.recordBest(S.key, correct, total);
      S.progress.clearSession(S.key);   // done: no resume card next time
    } else if (!s.retry) {
      best = S.progress.getBest(S.key);   // an early end never counts as a best score
    }

    const root = el('div', 'qz qz-summary');
    root.appendChild(el('div', 'qz-label', s.retry ? 'Practice round done'
      : s.endedEarly ? 'Quiz ended early' : (finished ? 'Done' : 'Results so far')));
    const big = el('div', 'qz-score');
    big.appendChild(el('span', 'qz-score-num', `${correct} / ${total}`));
    big.appendChild(el('span', 'qz-score-pct', `${Math.round(correct / total * 100)}%`));
    root.appendChild(big);
    if (best && !s.retry) {
      root.appendChild(el('p', 'qz-sub', `Best on this device: ${best.score} / ${best.total} (${Math.round(best.pct * 100)}%)`));
    }

    if (!s.retry) {
      const moved = s.ids.filter(id => s.startGroups[id] === 'shaky' && S.progress.group(id) !== 'shaky').length;
      if (moved) root.appendChild(el('p', 'qz-win', `${plural(moved, 'word', 'words')} moved out of Shaky. Nice.`));
    }

    if (skipped.length) {
      const sk = el('div', 'qz-card');
      sk.appendChild(el('div', 'qz-card-text', `${plural(skipped.length, 'question', 'questions')} skipped.`));
      sk.appendChild(button('Answer skipped questions', 'qz-btn', () => {
        s.idx = s.ids.indexOf(skipped[0]);
        saveSession();
        renderQuestion(true);
      }));
      root.appendChild(sk);
    }

    // Per-file breakdown (mixed quiz with 2+ files in this run)
    if (S.mode !== 'file' && !s.retry) {
      const byFile = new Map();
      s.ids.forEach(id => {
        const it = S.byId.get(id);
        const r = byFile.get(it.label) || { right: 0, total: 0 };
        r.total++;
        if (s.answers[id] === getQ(id).answer) r.right++;
        byFile.set(it.label, r);
      });
      if (byFile.size > 1) {
        const grid = el('div', 'qz-breakdown');
        [...byFile.entries()].sort().forEach(([label, r]) => {
          const cell = el('div', 'qz-break');
          cell.append(el('div', 'qz-hint', label), el('div', 'qz-break-num', `${r.right} / ${r.total}`));
          grid.appendChild(cell);
        });
        root.appendChild(grid);
      }
    }

    if (missed.length) {
      const sec = el('section', 'qz-missed');
      sec.appendChild(el('div', 'qz-label qz-rule', `Missed (${missed.length})`));
      missed.forEach(id => {
        const it = S.byId.get(id);
        const mq = getQ(id);
        const row = el('div', 'qz-miss');
        if (mq.word) {
          const w = el('div', 'qz-miss-q qz-miss-word', mq.word.headword);
          w.lang = 'ko';
          row.appendChild(w);
          row.appendChild(el('div', 'qz-miss-a', '→ ' + [mq.word.en, mq.word.fr].filter(Boolean).join(' · ')));
        } else {
          md(row.appendChild(el('div', 'qz-miss-q')), mq.text);
          const a = el('div', 'qz-miss-a');
          a.appendChild(document.createTextNode('→ '));
          md(a, mq.answerText);
          row.appendChild(a);
        }
        row.appendChild(el('div', 'qz-hint', S.mode === 'file' ? `Q${mq.num}` : it.source));
        sec.appendChild(row);
      });
      root.appendChild(sec);
    }

    const actions = el('div', 'qz-actions');
    if (missed.length) {
      actions.appendChild(button(`Retry the ${missed.length} I missed`, 'qz-btn qz-btn-dark qz-btn-big', () => {
        S.session = {
          v: 1, ids: C.shuffle(missed, Math.random), answers: {}, idx: 0,
          settings: s.settings, startGroups: {}, started: Date.now(), retry: true, gen: s.gen, kind: s.kind
        };
        S.revealed.clear();
        renderQuestion(true);
      }));
    }
    const row = el('div', 'qz-row qz-row-2');
    row.appendChild(button('New quiz', 'qz-btn', () => {
      if (!s.retry && !finished) S.progress.clearSession(S.key);
      S.session = null;
      renderSetup();
      window.scrollTo(0, 0);
    }));
    const back = el('a', 'qz-btn', 'Back to index');
    back.href = 'index.html';
    row.appendChild(back);
    actions.appendChild(row);
    root.appendChild(actions);

    mount(root);
    window.scrollTo(0, 0);
  }

  /* ══════════════════════════════════════════════════════
     KEYBOARD: 1–6 or A–F answers, Enter / → next, ← back
     ══════════════════════════════════════════════════════ */
  let keysBound = false;
  function bindKeys() {
    if (keysBound) return;
    keysBound = true;
    document.addEventListener('keydown', e => {
      if (S.screen !== 'question' || !S.session) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const s = S.session;
      const id = s.ids[s.idx];
      const q = getQ(id);
      const answered = !!s.answers[id];
      const k = e.key.toLowerCase();
      // Flashcards: Space/Enter shows the answer, then 1 = didn't know, 2 = knew it.
      if (q.kind === 'cards' && !answered && !S.revealed.has(id)) {
        if ((e.key === ' ' || e.key === 'Enter') && !(t && /^(BUTTON|A)$/.test(t.tagName))) {
          e.preventDefault(); S.revealed.add(id); renderQuestion(false);
        }
        return;
      }
      let i = -1;
      if (/^[1-6]$/.test(k)) i = +k - 1;
      else if (/^[a-f]$/.test(k) && q.kind !== 'cards') i = k.charCodeAt(0) - 97;
      if (i >= 0 && !answered && q.options[i]) { e.preventDefault(); answer(q.options[i].letter); return; }
      if (e.key === 'Enter' && answered && !(t && /^(BUTTON|A)$/.test(t.tagName))) { e.preventDefault(); goNext(); return; }
      if (e.key === 'ArrowRight') { goNext(); return; }
      if (e.key === 'ArrowLeft') { goPrev(); return; }
      if (e.key === 'Escape' && S.toggleQuit) { S.toggleQuit(); }
    });
  }

  /* ══════════════════════════════════════════════════════════
     VOCAB PAGE  (viewer.html?file=…-vocabNN.txt)
     Number + KO on one bold line, Say the word (built-in voice),
     Play clip (Hwasa's audio), Open in transcript, cover mode
     (toggled from the nav pill), filter and sort.
     ══════════════════════════════════════════════════════════ */
  const COVER_KEY = 'hwasa-vocab-cover';
  const VIEW_KEY  = 'hwasa-vocab-view';
  const COVER_MODES = [
    { id: 'off',     label: 'Cover: off' },
    { id: 'meaning', label: 'Hide meaning' },
    { id: 'korean',  label: 'Hide Korean' }
  ];
  const POS_NAMES = { n: 'Nouns', v: 'Verbs', adj: 'Adjectives', adv: 'Adverbs', exp: 'Expressions', expr: 'Expressions', int: 'Interjections' };

  function readPref(store, key, fallback) {
    try { const v = window[store].getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
  function writePref(store, key, value) {
    try { window[store].setItem(key, JSON.stringify(value)); } catch (e) { /* not saved; fine */ }
  }

  function startVocab(opts) {
    const page = C.parseVocabPage(opts.text || '');
    if (!page.entries.length) return false;

    const m = opts.file.match(/^(.*)\/([^/]+?)-vocab\d*\.txt$/i);
    const dir = m ? m[1] : '';
    const stem = m ? m[2] : '';
    const vm = opts.file.match(/vocab(\d+)\.txt$/i);
    if (opts.nameEl) opts.nameEl.textContent = vm ? `Vocab ${vm[1]}` : 'Vocab';

    const V = {
      opts, page, dir, stem,
      cover: readPref('localStorage', COVER_KEY, 'off'),
      view: Object.assign({ pos: 'all', level: 'all', sort: 'list' }, readPref('sessionStorage', VIEW_KEY + ':' + opts.file, {})),
      media: null     // Promise → { transcript, lines, audioUrl, audioOk, voiceOk }
    };
    if (!COVER_MODES.some(c => c.id === V.cover)) V.cover = 'off';

    // Transcript, audio and voice are looked up once, in the background.
    V.media = (async () => {
      const tPath = dir && stem ? `${dir}/${stem}.txt` : null;
      const [hasT, voiceOk] = await Promise.all([tPath ? exists(tPath) : false, Voice.available()]);
      let lines = [], audioUrl = null, audioOk = false;
      if (hasT) {
        lines = C.parseTranscriptLines(await fetchText(tPath).catch(() => ''));
        if (opts.r2Base) { audioUrl = audioUrlFor(tPath, opts.r2Base); audioOk = await audioExists(audioUrl); }
      }
      return { transcript: hasT ? tPath : null, lines, audioUrl, audioOk, voiceOk };
    })().catch(() => ({ transcript: null, lines: [], audioUrl: null, audioOk: false, voiceOk: false }));

    renderVocab(V);
    vocabPill(V);
    return true;
  }

  function renderVocab(V) {
    const root = el('div', 'vc');

    if (V.page.header.length) {
      const pre = el('pre', 'vc-header', V.page.header.join('\n'));
      root.appendChild(pre);
    }
    V.page.intro.forEach(t => root.appendChild(el('p', 'vc-intro', t)));
    if (V.stem) {
      const prac = el('a', 'qz-btn qz-btn-dark vc-practice', 'Practice these words →');
      prac.href = 'viewer.html?practice=' + encodeURIComponent(V.stem) + '&dir=' + encodeURIComponent(V.dir) +
        '&only=' + encodeURIComponent(V.opts.file);
      root.appendChild(prac);
    }

    // Toolbar: filter + sort
    const entries = V.page.entries;
    const posList = Array.from(new Set(entries.map(e => e.pos).filter(Boolean))).sort();
    const levelList = Array.from(new Set(entries.map(e => e.level).filter(Boolean)))
      .sort((a, b) => C.levelRank(a) - C.levelRank(b));
    const hasUntagged = entries.some(e => !e.level);

    const bar = el('div', 'vc-bar');
    const mkSelect = (label, id, options, value, onChange) => {
      const wrap = el('label', 'vc-field');
      wrap.htmlFor = id;
      wrap.appendChild(el('span', 'vc-field-label', label));
      const sel = el('select');
      sel.id = id;
      options.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; sel.appendChild(o); });
      sel.value = options.some(o => o[0] === value) ? value : options[0][0];
      sel.addEventListener('change', () => onChange(sel.value));
      wrap.appendChild(sel);
      bar.appendChild(wrap);
      return sel;
    };
    if (posList.length > 1) {
      mkSelect('Type', 'vcPos', [['all', 'All types']].concat(posList.map(p => [p, POS_NAMES[p] || p])), V.view.pos,
        v => { V.view.pos = v; update(); });
    } else V.view.pos = 'all';
    if (levelList.length > 1 || hasUntagged) {
      mkSelect('Level', 'vcLevel', [['all', 'All levels']].concat(levelList.map(l => [l, l]), hasUntagged ? [['none', 'Untagged']] : []),
        V.view.level, v => { V.view.level = v; update(); });
    } else V.view.level = 'all';
    mkSelect('Sort', 'vcSort', [['list', 'List order'], ['easy', 'Level: easy first'], ['hard', 'Level: hard first'], ['ko', 'Korean ㄱ–ㅎ']],
      V.view.sort, v => { V.view.sort = v; update(); });
    root.appendChild(bar);

    const count = el('p', 'vc-count');
    count.setAttribute('aria-live', 'polite');
    root.appendChild(count);

    const list = el('div', 'vc-list cover-' + V.cover);
    V.listEl = list;
    const cards = entries.map((e, i) => ({ e, i, node: vocabCard(V, e) }));
    root.appendChild(list);

    function update() {
      writePref('sessionStorage', VIEW_KEY + ':' + V.opts.file, V.view);
      let shown = cards.filter(c =>
        (V.view.pos === 'all' || c.e.pos === V.view.pos) &&
        (V.view.level === 'all' || (V.view.level === 'none' ? !c.e.level : c.e.level === V.view.level)));
      if (V.view.sort === 'easy' || V.view.sort === 'hard') {
        const dir = V.view.sort === 'easy' ? 1 : -1;
        shown = shown.slice().sort((a, b) => {
          const ra = C.levelRank(a.e.level), rb = C.levelRank(b.e.level);
          if (ra === 999 || rb === 999) return (ra === 999) - (rb === 999) || a.i - b.i;   // untagged last
          return (ra - rb) * dir || a.i - b.i;
        });
      } else if (V.view.sort === 'ko') {
        shown = shown.slice().sort((a, b) => a.e.headword.localeCompare(b.e.headword, 'ko') || a.i - b.i);
      }
      list.replaceChildren(...shown.map(c => c.node));
      count.textContent = shown.length === cards.length
        ? plural(cards.length, 'word', 'words')
        : `Showing ${shown.length} of ${cards.length} words`;
      if (!shown.length) list.appendChild(el('p', 'vc-empty', 'No words match these filters.'));
    }
    update();
    V.opts.container.replaceChildren(root);
  }

  function vocabCard(V, e) {
    const card = el('article', 'vc-entry');

    const head = el('div', 'vc-ko');
    const strong = el('strong');
    strong.appendChild(document.createTextNode(`${e.num != null ? e.num + '. ' : ''}KO: `));
    const word = el('span', 'vc-word', e.ko);
    word.lang = 'ko';
    strong.appendChild(word);
    strong.appendChild(el('span', 'vc-hidden', '•••'));
    head.appendChild(strong);
    card.appendChild(head);

    if (e.fr) { const f = el('div', 'vc-line vc-mean', 'FR: ' + e.fr); f.lang = 'fr'; card.appendChild(f); }
    if (e.en) card.appendChild(el('div', 'vc-line vc-mean', 'EN: ' + e.en));
    if (e.context) {
      const cx = el('div', 'vc-line vc-ctx', 'Context: ' + e.context);
      card.appendChild(cx);
    }
    e.extra.forEach(t => card.appendChild(el('div', 'vc-line', t)));

    // Covered entries: one button reveals this entry only.
    const show = button('Show', 'vc-show', () => {
      const open = card.classList.toggle('revealed');
      show.textContent = open ? 'Hide' : 'Show';
      show.setAttribute('aria-expanded', String(open));
    });
    show.setAttribute('aria-expanded', 'false');
    card.appendChild(show);

    const actions = el('div', 'vc-actions');
    card.appendChild(actions);
    V.media.then(md => {
      if (md.voiceOk) {
        const say = button('', 'qz-play vc-say', () => Voice.say(e.headword));
        say.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M19 5a10 10 0 0 1 0 14"></path></svg>';
        say.appendChild(el('span', null, 'Say the word'));
        say.setAttribute('aria-label', 'Say the word ' + e.headword);
        actions.appendChild(say);
      }
      if (e.ts && md.audioOk && md.audioUrl) {
        const start = C.tsToSeconds(e.ts);
        const b = button('', 'qz-play', () => Clip.toggle(md.audioUrl, start, C.clipEnd(start, md.lines), b));
        b.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><polygon points="6 4 20 12 6 20" fill="currentColor"></polygon></svg>';
        b.appendChild(el('span', 'qz-play-label', 'Play clip'));
        b.setAttribute('aria-pressed', 'false');
        actions.appendChild(b);
      }
      if (e.ts && md.transcript) {
        const a = el('a', 'qz-link', 'Open in transcript →');
        a.href = 'viewer.html?file=' + encodeURIComponent(md.transcript) + '&t=' + encodeURIComponent(C.normTs(e.ts));
        actions.appendChild(a);
      }
      if (!actions.children.length) actions.remove();
    });
    return card;
  }

  // Nav pill: ▲ Top · cover mode (Off → Hide meaning → Hide Korean)
  function vocabPill(V) {
    const pill = V.opts.pill;
    if (!pill) return;
    pill.replaceChildren();
    const top = button('▲ Top', null, () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    const sep = el('div', 'pill-sep');
    const cov = button('', 'vc-cover-btn', () => {
      const i = COVER_MODES.findIndex(c => c.id === V.cover);
      V.cover = COVER_MODES[(i + 1) % COVER_MODES.length].id;
      writePref('localStorage', COVER_KEY, V.cover);
      apply();
    });
    function apply() {
      const mode = COVER_MODES.find(c => c.id === V.cover);
      cov.textContent = mode.label;
      cov.classList.toggle('on', V.cover !== 'off');
      cov.setAttribute('aria-label', `Cover mode: ${mode.label}. Tap to change.`);
      V.listEl.className = 'vc-list cover-' + V.cover;
      V.listEl.querySelectorAll('.vc-entry.revealed').forEach(c => {
        c.classList.remove('revealed');
        const b = c.querySelector('.vc-show');
        if (b) { b.textContent = 'Show'; b.setAttribute('aria-expanded', 'false'); }
      });
    }
    pill.append(top, sep, cov);
    apply();
    pill.classList.add('visible');
  }

  /* ══════════════════════════════════════════════════════════
     TRANSCRIPT: underline this video's vocab words in KO lines.
     A quick tap opens the word's card. Nothing listens for
     press-and-hold, so long-press text selection (e.g. for
     Google Translate) works exactly as before.
     ══════════════════════════════════════════════════════════ */
  async function attachWords(opts) {
    const m = String(opts.file || '').match(/^(.*)\/([^/]+)\.txt$/);
    if (!m || !opts.container) return;
    const found = await discover(m[1], m[2]);
    if (!found.vocab.length) return;
    const texts = await Promise.all(found.vocab.map(p => fetchText(p).catch(() => '')));
    const words = C.vocabWords([].concat(...texts.map(C.parseVocab)));
    if (!words.length) return;
    const voiceOk = await Voice.available();

    // Every searchable form, longest first so "말랑말랑하다" wins over "말랑".
    const forms = [];
    words.forEach((w, i) => C.vocabForms(w.headword).forEach(f => forms.push({ f, i })));
    forms.sort((a, b) => b.f.length - a.f.length);
    const byForm = new Map(forms.map(x => [x.f, x.i]));
    const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(forms.map(x => esc(x.f)).join('|'), 'g');

    opts.container.querySelectorAll('.line-group pre strong').forEach(strong => {
      const text = strong.textContent;
      if (!/^\s*KO:/.test(text)) return;
      re.lastIndex = 0;
      if (!re.test(text)) return;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, mm;
      while ((mm = re.exec(text))) {
        if (mm.index > last) frag.appendChild(document.createTextNode(text.slice(last, mm.index)));
        const span = el('span', 'vw', mm[0]);
        span.dataset.w = String(byForm.get(mm[0]));
        span.tabIndex = 0;
        span.setAttribute('role', 'button');
        span.setAttribute('aria-label', `${mm[0]}: show word card`);
        frag.appendChild(span);
        last = mm.index + mm[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      strong.replaceChildren(frag);
    });

    let card = null, openSpan = null;
    function closeCard() {
      if (card) card.remove();
      card = null;
      openSpan = null;
    }
    function openCard(span) {
      if (openSpan === span) { closeCard(); return; }
      closeCard();
      const w = words[+span.dataset.w];
      if (!w) return;
      card = el('div', 'vw-card');
      card.setAttribute('role', 'region');
      card.setAttribute('aria-label', 'Word card');
      const head = el('div', 'vw-head');
      const ko = el('span', 'vw-ko', w.headword);
      ko.lang = 'ko';
      head.appendChild(ko);
      if (w.pos || w.level) head.appendChild(el('span', 'vw-tag', [w.pos, w.level].filter(Boolean).join(' · ')));
      card.appendChild(head);
      if (w.fr) { const f = el('div', 'vw-line', 'FR: ' + w.fr); f.lang = 'fr'; card.appendChild(f); }
      if (w.en) card.appendChild(el('div', 'vw-line', 'EN: ' + w.en));
      const row = el('div', 'vw-actions');
      if (voiceOk) row.appendChild(sayButton(w.headword));
      row.appendChild(button('Close', 'qz-btn vw-close', closeCard));
      card.appendChild(row);
      const group = span.closest('.line-group');
      const pre = group && group.querySelector('pre');
      if (pre) pre.after(card); else span.after(card);
      openSpan = span;
    }
    opts.container.addEventListener('click', e => {
      const span = e.target.closest && e.target.closest('.vw');
      if (!span) return;
      e.stopPropagation();
      openCard(span);
    });
    opts.container.addEventListener('keydown', e => {
      const span = e.target.closest && e.target.closest('.vw');
      if (span && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openCard(span); }
    });
  }

  window.QuizUI = { start };
  window.VocabUI = { start: startVocab };
  window.TranscriptWords = { attach: (opts) => attachWords(opts).catch(() => { /* underlines are optional */ }) };
})();
