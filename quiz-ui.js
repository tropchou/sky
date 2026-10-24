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
    root: null
  };

  /* ══════════════════════════════════════════════════════
     START
     Returns false (file mode) when the file has no readable
     questions, so the viewer can show the plain text instead.
     ══════════════════════════════════════════════════════ */
  function start(opts) {
    S.opts = opts;
    S.mode = opts.mode === 'mixed' ? 'mixed' : 'file';
    S.progress = new C.Progress();

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
        audioUrl = S.opts.r2Base + '/' + found.transcript
          .replace('transcripts/', 'audio/')
          .replace('.txt', '.mp3')
          .replace(/\/hwasa-/, '/');
        try { audioOk = (await fetch(audioUrl, { method: 'HEAD', cache: 'no-store' })).ok; } catch (e) { audioOk = false; }
      }
      return { vocab, lines, transcript: found.transcript, audioUrl, audioOk };
    })().catch(() => ({ vocab: [], lines: [], transcript: null, audioUrl: null, audioOk: false }));
    return S.ctx;
  }

  const Clip = {
    audio: null, src: '', stopAt: 0, btn: null,
    toggle(url, start, end, btn) {
      if (this.btn === btn) { this.stop(); return; }
      this.stop();
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

  function contextBox(item) {
    const box = el('section', 'qz-ctx');
    box.hidden = true;
    loadContext().then(ctx => {
      let c = S.ctxCache.get(item.q.id);
      if (c === undefined) {
        c = C.findContext(item.q, ctx.vocab, ctx.lines);
        S.ctxCache.set(item.q.id, c);
      }
      if (!c || !box.isConnected) return;

      box.appendChild(el('div', 'qz-label', 'In the video'));
      const line = el('div', 'qz-ctx-line');
      line.appendChild(el('span', 'qz-ctx-ts', C.normTs(c.ts)));
      const ko = el('span', 'qz-ctx-ko', c.ko);
      ko.lang = 'ko';
      line.appendChild(ko);
      box.appendChild(line);

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
    const ids = saved.ids.filter(id => S.byId.has(id));
    if (!ids.length) { S.progress.clearSession(S.key); return; }
    const answers = {};
    Object.keys(saved.answers || {}).forEach(id => { if (S.byId.has(id)) answers[id] = saved.answers[id]; });
    S.session = {
      v: 1, ids, answers,
      idx: Math.min(Math.max(0, saved.idx | 0), ids.length - 1),
      settings: saved.settings || {},
      startGroups: saved.startGroups || {},
      started: saved.started || Date.now(),
      retry: false
    };
    // Setup defaults follow the saved quiz.
    const st = S.session.settings;
    if (Array.isArray(st.files) && S.mode === 'mixed') {
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

  function answeredCount(s) { return s.ids.filter(id => s.answers[id]).length; }
  function correctCount(s) { return s.ids.filter(id => s.answers[id] && s.answers[id] === S.byId.get(id).q.answer).length; }

  /* ══════════════════════════════════════════════════════
     SCREEN 1: SETUP
     ══════════════════════════════════════════════════════ */
  function pool() {
    const ids = [], seen = new Set();
    let dups = 0;
    S.files.forEach(f => {
      if (!S.setup.selected.has(f.path)) return;
      f.questions.forEach(q => {
        if (seen.has(q.id)) { dups++; return; }
        seen.add(q.id);
        ids.push(q.id);
      });
    });
    return { ids, dups };
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
    root.appendChild(el('h1', 'qz-title', S.mode === 'mixed' ? 'Mixed quiz' : S.files[0].label));
    const sub = el('p', 'qz-sub');
    root.appendChild(sub);

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
      card.appendChild(el('div', 'qz-card-title', 'Quiz in progress'));
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

    // Which files (mixed only)
    let dupNote = null;
    if (S.mode === 'mixed') {
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
        lab.append(cb, el('span', 'qz-check-name', f.label), el('span', 'qz-check-count', plural(f.questions.length, 'question', 'questions')));
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

    const startBtn = button('Start new quiz', 'qz-btn qz-btn-big', startNew);
    root.appendChild(startBtn);

    function refresh() {
      const { ids, dups } = pool();
      const max = ids.length;
      const nFiles = S.files.filter(f => S.setup.selected.has(f.path)).length;
      sub.textContent = S.mode === 'mixed'
        ? `${plural(max, 'question', 'questions')} from ${plural(nFiles, 'quiz file', 'quiz files')}, shuffled.`
        : `${plural(max, 'question', 'questions')}, shuffled.`;
      if (dupNote) {
        dupNote.textContent = dups
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
      startBtn.textContent = max === 0 ? 'Pick at least one quiz' : 'Start new quiz';
    }
    refresh();
    mount(root);
  }

  function startNew() {
    const { ids } = pool();
    if (!ids.length) return;
    const n = chosenSize(ids.length);
    const order = C.buildQuiz(ids, n, { focus: S.setup.focus, history: id => S.progress.history(id) });
    const startGroups = {};
    order.forEach(id => { startGroups[id] = S.progress.group(id); });
    S.session = {
      v: 1, ids: order, answers: {}, idx: 0,
      settings: { files: Array.from(S.setup.selected), size: n, focus: S.setup.focus },
      startGroups, started: Date.now(), retry: false
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
    const q = item.q;
    const ans = s.answers[id] || null;
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
    meta.appendChild(el('span', 'qz-label', `Question ${s.idx + 1} of ${total}`));
    meta.appendChild(el('span', 'qz-tag', S.mode === 'mixed' ? item.source : `Q${q.num}`));
    root.appendChild(meta);

    const h = el('h2', 'qz-q');
    h.tabIndex = -1;
    md(h, q.text);
    root.appendChild(h);

    const list = el('div', 'qz-opts');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Answer options');
    q.options.forEach(o => {
      const b = button('', 'qz-opt', () => answer(o.letter));
      const mark = el('span', 'qz-opt-mark', o.letter);
      const body = el('span', 'qz-opt-body');
      md(body.appendChild(el('span', 'qz-opt-text')), o.text);
      b.append(mark, body);
      if (ans) {
        b.disabled = true;
        const isRight = o.letter === q.answer;
        const isMine = o.letter === ans;
        if (isRight) {
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
      live.textContent = right ? 'Correct.' : `Not quite. The answer is ${q.answer}.`;
      const after = el('div', 'qz-after');
      if (q.explanation) {
        const ex = el('section', 'qz-expl');
        ex.appendChild(el('div', 'qz-label', 'Why'));
        md(ex.appendChild(el('p', 'qz-expl-text')), q.explanation);
        after.appendChild(ex);
      }
      after.appendChild(contextBox(item));
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
    if (!s.retry) S.progress.record(id, letter === S.byId.get(id).q.answer);
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
    const missed = s.ids.filter(id => s.answers[id] && s.answers[id] !== S.byId.get(id).q.answer);
    const finished = !skipped.length;

    let best = null;
    if (!s.retry && finished) {
      best = S.progress.recordBest(S.key, correct, total);
      S.progress.clearSession(S.key);   // done: no resume card next time
    } else if (!s.retry) {
      best = S.progress.getBest(S.key);
    }

    const root = el('div', 'qz qz-summary');
    root.appendChild(el('div', 'qz-label', s.retry ? 'Practice round done' : (finished ? 'Done' : 'Results so far')));
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
    if (S.mode === 'mixed' && !s.retry) {
      const byFile = new Map();
      s.ids.forEach(id => {
        const it = S.byId.get(id);
        const r = byFile.get(it.label) || { right: 0, total: 0 };
        r.total++;
        if (s.answers[id] === it.q.answer) r.right++;
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
        const row = el('div', 'qz-miss');
        md(row.appendChild(el('div', 'qz-miss-q')), it.q.text);
        const a = el('div', 'qz-miss-a');
        a.appendChild(document.createTextNode('→ '));
        md(a, it.q.answerText);
        row.appendChild(a);
        row.appendChild(el('div', 'qz-hint', S.mode === 'mixed' ? it.source : `Q${it.q.num}`));
        sec.appendChild(row);
      });
      root.appendChild(sec);
    }

    const actions = el('div', 'qz-actions');
    if (missed.length) {
      actions.appendChild(button(`Retry the ${missed.length} I missed`, 'qz-btn qz-btn-dark qz-btn-big', () => {
        S.session = {
          v: 1, ids: C.shuffle(missed, Math.random), answers: {}, idx: 0,
          settings: s.settings, startGroups: {}, started: Date.now(), retry: true
        };
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
      const q = S.byId.get(s.ids[s.idx]).q;
      const answered = !!s.answers[s.ids[s.idx]];
      const k = e.key.toLowerCase();
      let i = -1;
      if (/^[1-6]$/.test(k)) i = +k - 1;
      else if (/^[a-f]$/.test(k)) i = k.charCodeAt(0) - 97;
      if (i >= 0 && !answered && q.options[i]) { e.preventDefault(); answer(q.options[i].letter); return; }
      if (e.key === 'Enter' && answered && !(t && /^(BUTTON|A)$/.test(t.tagName))) { e.preventDefault(); goNext(); return; }
      if (e.key === 'ArrowRight') { goNext(); return; }
      if (e.key === 'ArrowLeft') { goPrev(); }
    });
  }

  window.QuizUI = { start };
})();
