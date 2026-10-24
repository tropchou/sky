/* ══════════════════════════════════════════════════════════
   quiz-core.js  —  shared quiz logic for Hwasa Transcripts
   ──────────────────────────────────────────────────────────
   No screen code here: reading quiz / vocab / transcript files,
   question IDs, saved progress, and the repetition rules.

   Works in the browser (window.QuizCore) and in Node
   (require('./quiz-core.js')), so the GitHub Action can reuse
   it in phase 2 and always agree with the site.
   ══════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QuizCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── Settings you may want to tune ─────────────────────── */
  const STORAGE_KEY = 'hwasa-quiz-v1';
  const SHAKY_EXIT  = 2;    // correct answers in a row to leave "Shaky"
  const KNOWN_AT    = 3;    // correct answers in a row to count as "Known"
  const MIX_SHAKY   = 0.4;  // share of each quiz from Shaky words
  const MIX_FRESH   = 0.4;  // share from New + Learning words (Known gets the rest)

  /* ══════════════════════════════════════════════════════
     TEXT HELPERS
     ══════════════════════════════════════════════════════ */
  function nfc(s) { return String(s == null ? '' : s).normalize('NFC'); }

  // Removes markdown bold/italics markers and backticks.
  function stripMd(s) { return nfc(s).replace(/\*\*/g, '').replace(/`/g, ''); }

  // Used for IDs: ignores case, punctuation, bold markers and spacing.
  function normText(s) {
    return stripMd(s).toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // cyrb53: small, fast 53-bit hash. Same result in every browser and Node.
  function cyrb53(str, seed) {
    seed = seed || 0;
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  // Question ID = fingerprint of question text + the TEXT of its correct answer.
  function questionId(questionText, answerText) {
    return cyrb53(normText(questionText) + '|' + normText(answerText))
      .toString(36).padStart(11, '0');
  }

  function tsToSeconds(ts) {
    const p = String(ts).trim().split(':').map(Number);
    if (p.some(isNaN)) return 0;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return p[0] || 0;
  }

  // "01:01:42" → "1:01:42", "05:28" → "5:28" (same form the viewer uses for &t=)
  function normTs(ts) {
    let sec = tsToSeconds(ts);
    const h = Math.floor(sec / 3600); sec -= h * 3600;
    const m = Math.floor(sec / 60);   const s = sec - m * 60;
    const p2 = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
  }

  /* ══════════════════════════════════════════════════════
     QUIZ FILE PARSER
     Returns null when no questions are found at all
     (the viewer then shows the plain-text version).
     ══════════════════════════════════════════════════════ */
  const Q_RE   = /^\s*(?:\*\*)?\s*Q\s*(\d+)\s*[.):]\s*(?:\*\*)?\s*(.*)$/i;
  const OPT_RE = /^\s*(?:\*\*)?\s*\(?([A-Fa-f])[).]\s*(?:\*\*)?\s*(.+)$/;
  const KEY_RE = /^\s*(?:\*\*)?\s*Q\s*(\d+)\s*(?:[—–:.-]|\s)\s*\(?([A-Fa-f])(?![A-Za-z])\)?[).]?\s*(?:\*\*)?\s*[—–:-]?\s*(.*)$/;
  const KEY_HEAD_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*answer\s*key\b/i;
  const SEP_RE = /^\s*(?:-{3,}|={3,}|_{3,}|\*{3,})\s*$/;

  function parseQuiz(raw) {
    const lines = nfc(raw).replace(/\r\n?/g, '\n').split('\n');

    // Skip the header block (everything up to the ===== line), if there is one.
    let start = lines.findIndex(l => /^\s*={5,}\s*$/.test(l));
    start = start === -1 ? 0 : start + 1;

    let keyAt = -1;
    for (let i = start; i < lines.length; i++) {
      if (KEY_HEAD_RE.test(lines[i])) { keyAt = i; break; }
    }
    const body    = lines.slice(start, keyAt === -1 ? lines.length : keyAt);
    const keyPart = keyAt === -1 ? [] : lines.slice(keyAt + 1);

    // Title: first markdown heading in the body, else the file's first line.
    let title = '';
    const h = body.find(l => /^\s*#{1,6}\s+\S/.test(l));
    if (h) title = stripMd(h.replace(/^\s*#{1,6}\s+/, '')).trim();
    else title = stripMd(lines.find(l => l.trim()) || '').trim();

    // Questions
    const parsed = [];
    let cur = null;
    for (const line of body) {
      const qm = line.match(Q_RE);
      if (qm && qm[2].trim()) {
        cur = { num: parseInt(qm[1], 10), text: qm[2].trim(), options: [] };
        parsed.push(cur);
        continue;
      }
      if (!cur || !line.trim() || SEP_RE.test(line) || /^\s*#/.test(line)) continue;
      const om = line.match(OPT_RE);
      if (om) {
        cur.options.push({ letter: om[1].toUpperCase(), text: om[2].replace(/\*\*\s*$/, '').trim() });
      } else if (!cur.options.length) {
        cur.text += ' ' + line.trim();   // question text that runs over two lines
      }
    }

    // Answer key
    const key = new Map();
    let k = null;
    for (const line of keyPart) {
      const km = line.match(KEY_RE);
      if (km) {
        k = { answer: km[2].toUpperCase(), explanation: km[3].trim() };
        key.set(parseInt(km[1], 10), k);
        continue;
      }
      if (k && line.trim() && !SEP_RE.test(line) && !/^\s*#/.test(line)) {
        k.explanation += (k.explanation ? ' ' : '') + line.trim();
      }
    }

    if (!parsed.length) return null;

    const questions = [];
    const problems  = [];
    for (const q of parsed) {
      const a = key.get(q.num);
      if (q.options.length < 2) { problems.push(`Q${q.num} skipped: no answer options found`); continue; }
      if (!a)                   { problems.push(`Q${q.num} skipped: no answer in the answer key`); continue; }
      const opt = q.options.find(o => o.letter === a.answer);
      if (!opt)                 { problems.push(`Q${q.num} skipped: answer ${a.answer} is not one of its options`); continue; }
      questions.push({
        num: q.num,
        text: q.text.replace(/\*\*\s*$/, '').trim(),
        options: q.options,
        answer: a.answer,
        answerText: opt.text,
        explanation: a.explanation,
        id: questionId(q.text, opt.text)
      });
    }
    return { title, questions, problems };
  }

  /* ══════════════════════════════════════════════════════
     VOCAB + TRANSCRIPT (for "In the video")
     ══════════════════════════════════════════════════════ */
  // Reads "(n; II-4)" at the end of a KO line → { pos: 'n', level: 'II-4' }.
  function vocabTag(ko) {
    const m = String(ko).match(/\(([^)]*)\)\s*$/);
    if (!m) return { pos: '', level: '' };
    const parts = m[1].split(/[;,]/).map(x => x.trim()).filter(Boolean);
    let pos = '', level = '';
    parts.forEach(p => {
      if (/^(I{1,3}|IV|V)-\d+$/i.test(p)) level = p.toUpperCase();
      else if (!pos) pos = p.toLowerCase();
    });
    return { pos, level };
  }

  // Level "II-4" → 24 (for sorting); unknown → 999.
  function levelRank(level) {
    const m = String(level || '').match(/^(I{1,3}|IV|V)-(\d+)$/i);
    if (!m) return 999;
    const roman = { I: 1, II: 2, III: 3, IV: 4, V: 5 }[m[1].toUpperCase()] || 9;
    return roman * 10 + parseInt(m[2], 10);
  }

  /* Vocab file → { header: [lines], intro: [lines], entries: [...] }
     Handles "1." on its own line or on the KO line ("1. KO: …"), "1)" too,
     and blank lines in between. */
  function parseVocabPage(raw) {
    const lines = nfc(raw).replace(/\r\n?/g, '\n').split('\n');
    let start = lines.findIndex(l => /^\s*={5,}\s*$/.test(l));
    const header = start === -1 ? [] : lines.slice(0, start + 1);
    start = start === -1 ? 0 : start + 1;

    const intro = [];
    const entries = [];
    let cur = null;
    let pendingNum = null;
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = line.match(/^\s*(\d+)\s*[.)]\s*$/))) { pendingNum = parseInt(m[1], 10); continue; }
      if ((m = line.match(/^\s*(?:(\d+)\s*[.)]\s*)?(?:\*\*)?KO:\s*(.+?)\s*(?:\*\*)?$/))) {
        const ko = m[2].trim();
        const tag = vocabTag(ko);
        cur = {
          num: m[1] ? parseInt(m[1], 10) : pendingNum,
          ko,
          headword: ko.replace(/\s*\([^)]*\)\s*$/, '').trim(),
          pos: tag.pos, level: tag.level,
          fr: '', en: '', ts: null, contextKo: '', context: '', extra: []
        };
        entries.push(cur);
        pendingNum = null;
        continue;
      }
      if (cur && (m = line.match(/^\s*(FR|EN):\s*(.*)$/))) { cur[m[1].toLowerCase()] = m[2].trim(); continue; }
      if (cur && (m = line.match(/^\s*Context:\s*(.*)$/i))) {
        cur.context = m[1].trim();
        const c = cur.context.match(/^\[(\d{1,2}(?::\d{1,2}){1,2})\]\s*(.*)$/);
        if (c) { cur.ts = c[1]; cur.contextKo = c[2].trim(); }
        else cur.contextKo = cur.context;
        continue;
      }
      if (!line.trim() || SEP_RE.test(line)) continue;
      if (cur) cur.extra.push(line.trim());
      else intro.push(line.trim());
    }
    return { header, intro, entries };
  }

  function parseVocab(raw) { return parseVocabPage(raw).entries; }

  // Transcript format: "[m:ss]" on its own line, then "KO: …", "FR: …", "EN: …".
  function parseTranscriptLines(raw) {
    const out = [];
    let ts = null, last = null;
    nfc(raw).replace(/\r\n?/g, '\n').split('\n').forEach(line => {
      const t = line.match(/^\s*\[(\d{1,2}(?::\d{1,2}){1,2})\]\s*$/);
      if (t) { ts = t[1]; last = null; return; }
      const k = line.match(/^\s*KO:\s*(.+)$/);
      if (k && ts) {
        const ko = k[1].trim();
        last = { ts, sec: tsToSeconds(ts), ko, koNs: ko.replace(/\s+/g, ''), fr: '', en: '' };
        out.push(last);
        ts = null;
        return;
      }
      const tr = line.match(/^\s*(FR|EN):\s*(.*)$/);
      if (tr && last) {
        const v = tr[2].trim();
        if (v && v !== 'None') last[tr[1].toLowerCase()] = v;
      }
    });
    out.sort((a, b) => a.sec - b.sec);
    return out;
  }

  // The transcript line at exactly this timestamp (for its FR / EN), or null.
  function lineAt(ts, lines) {
    const want = tsToSeconds(ts);
    return (lines || []).find(l => l.sec === want) || null;
  }

  function vocabForms(headword) {
    const forms = [headword];
    if (/하다$/.test(headword) && headword.length > 3) forms.push(headword.slice(0, -2));
    else if (/다$/.test(headword) && headword.length > 2) forms.push(headword.slice(0, -1));
    return forms.filter(f => f.replace(/\s+/g, '').length >= 2);
  }

  function hangulRuns(s) {
    return (nfc(s).match(/[가-힣][가-힣\s]*[가-힣]|[가-힣]/g) || [])
      .map(x => x.replace(/\s+/g, ' ').trim());
  }

  // Finds the line in the video that a question is about. null if none.
  function findContext(q, vocab, lines) {
    const hay = (stripMd(q.text) + ' ' + stripMd(q.answerText)).replace(/\s+/g, '');
    let best = null;
    (vocab || []).forEach(v => {
      if (!v.ts) return;
      vocabForms(v.headword).forEach(form => {
        const f = form.replace(/\s+/g, '');
        if (hay.includes(f) && (!best || f.length > best.len)) {
          best = { len: f.length, ts: v.ts, ko: v.contextKo, term: v.headword };
        }
      });
    });
    if (best) {
      const l = lineAt(best.ts, lines);
      return { ts: best.ts, ko: best.ko, term: best.term, fr: l ? l.fr : '', en: l ? l.en : '' };
    }

    if (lines && lines.length) {
      const runs = hangulRuns(stripMd(q.text))
        .filter(r => r.replace(/\s/g, '').length >= 3)
        .sort((a, b) => b.length - a.length);
      for (const r of runs) {
        const rn = r.replace(/\s+/g, '');
        const hit = lines.find(l => l.koNs.includes(rn));
        if (hit) return { ts: hit.ts, ko: hit.ko, term: '', fr: hit.fr, en: hit.en };
      }
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════
     PRACTICE QUESTIONS BUILT FROM VOCAB FILES (no LLM)
     One history per Korean word, shared by every exercise
     and every video.
     ══════════════════════════════════════════════════════ */
  function wordId(headword) { return 'w' + questionId('vocab ' + headword, ''); }

  // Turns vocab entries into practice words (dedupes by word).
  function vocabWords(entries, label, path) {
    const out = [];
    const seen = new Set();
    (entries || []).forEach(e => {
      if (!e.headword) return;
      const id = wordId(e.headword);
      if (seen.has(id)) return;
      seen.add(id);
      out.push({
        id, headword: e.headword, ko: e.ko, pos: e.pos, level: e.level,
        fr: e.fr, en: e.en, ts: e.ts, contextKo: e.contextKo,
        num: e.num, label: label || '', path: path || ''
      });
    });
    return out;
  }

  // Two meanings are "different enough" to be wrong options for each other.
  function distinctMeaning(a, b) {
    const x = normText(a), y = normText(b);
    if (!x || !y || x === y || x.includes(y) || y.includes(x)) return false;
    const words = new Set(x.split(' ').filter(w => w.length >= 4));
    return !y.split(' ').some(w => w.length >= 4 && words.has(w));
  }

  function pickDistractors(word, pool, field, rng, n, extraOk) {
    n = n || 3;
    const ok = w => w.id !== word.id && w[field] &&
      (field === 'headword' ? w.headword !== word.headword : distinctMeaning(w[field], word[field])) &&
      (!extraOk || extraOk(w));
    const same = shuffle(pool.filter(w => ok(w) && w.pos && w.pos === word.pos), rng);
    const rest = shuffle(pool.filter(w => ok(w) && !(w.pos && w.pos === word.pos)), rng);
    const out = [];
    for (const w of same.concat(rest)) {
      if (out.length >= n) break;
      const clash = out.some(o => field === 'headword' ? o.headword === w.headword : !distinctMeaning(o[field], w[field]));
      if (!clash) out.push(w);
    }
    return out.length >= n ? out : null;
  }

  function lettered(texts, rightText, rng) {
    const opts = shuffle(texts, rng).map((t, i) => ({ letter: 'ABCDEF'[i], text: t }));
    return { options: opts, answer: opts.find(o => o.text === rightText).letter };
  }

  // Forms of a word to look for (and blank) in its context sentence, longest first.
  function blankForms(headword) {
    const f = [headword];
    if (/하다$/.test(headword)) f.push(headword.slice(0, -2));
    if (/다$/.test(headword)) { f.push(headword.slice(0, -1)); f.push(headword.slice(0, -2)); }
    return Array.from(new Set(f)).filter(x => x.replace(/\s+/g, '').length >= 2).sort((a, b) => b.length - a.length);
  }
  function blankSentence(word) {
    const s = word.contextKo || '';
    if (!s) return null;
    const form = blankForms(word.headword).find(f => s.includes(f));
    if (!form) return null;
    const blanked = s.split(form).join('＿＿＿');
    // Keep only sentences with enough left to be a real clue.
    if ((blanked.match(/[가-힣]/g) || []).length < 2) return null;
    return blanked;
  }

  function wordInfo(w) {
    return { id: w.id, headword: w.headword, ko: w.ko, pos: w.pos, level: w.level,
             fr: w.fr, en: w.en, ts: w.ts, contextKo: w.contextKo };
  }

  /* makeQuestion(kind, word, pool, rng) → question or null
     kind: 'cards' | 'mc' (vocab quiz) | 'blank' | 'listen' */
  function makeQuestion(kind, word, pool, rng) {
    rng = rng || Math.random;
    const base = { id: word.id, kind, num: word.num, word: wordInfo(word), explanation: '' };

    if (kind === 'cards') {
      return Object.assign(base, {
        text: word.headword,
        options: [{ letter: 'A', text: 'Didn’t know' }, { letter: 'B', text: 'Knew it' }],
        answer: 'B', answerText: word.en || word.fr || word.headword
      });
    }

    if (kind === 'mc') {
      const dirs = [];
      if (word.en) dirs.push('ko-en', 'en-ko');
      if (word.fr) dirs.push('ko-fr');
      for (const dir of shuffle(dirs, rng)) {
        const field = dir === 'ko-en' ? 'en' : dir === 'ko-fr' ? 'fr' : 'headword';
        const wrong = pickDistractors(word, pool, field, rng, 3);
        if (!wrong) continue;
        const right = word[field];
        const text = dir === 'ko-en' ? `What does **${word.headword}** mean?`
                   : dir === 'ko-fr' ? `**${word.headword}**: which is the French translation?`
                   : `Which word means "${word.en}"?`;
        const L = lettered([right].concat(wrong.map(w => w[field])), right, rng);
        return Object.assign(base, { text, dir, options: L.options, answer: L.answer, answerText: right });
      }
      return null;
    }

    if (kind === 'blank') {
      const sentence = blankSentence(word);
      if (!sentence) return null;
      const ctx = word.contextKo || '';
      // Wrong options must not themselves appear in the sentence.
      const wrong = pickDistractors(word, pool, 'headword', rng, 3,
        w => !blankForms(w.headword).some(f => ctx.includes(f)));
      if (!wrong) return null;
      const L = lettered([word.headword].concat(wrong.map(w => w.headword)), word.headword, rng);
      return Object.assign(base, {
        text: `Fill in the blank: "${sentence}"`,
        hint: 'Options are in dictionary form.',
        options: L.options, answer: L.answer, answerText: word.headword
      });
    }

    if (kind === 'listen') {
      const field = word.en ? 'en' : word.fr ? 'fr' : null;
      if (!field) return null;
      const wrong = pickDistractors(word, pool, field, rng, 3);
      if (!wrong) return null;
      const L = lettered([word[field]].concat(wrong.map(w => w[field])), word[field], rng);
      return Object.assign(base, {
        text: 'Listen, then pick the meaning.',
        say: word.headword,
        options: L.options, answer: L.answer, answerText: word[field]
      });
    }
    return null;
  }

  // Can this word be used for this exercise at all? (cheap check, no randomness needed)
  function canPractice(kind, word, pool) {
    if (kind === 'cards') return true;
    if (kind === 'blank' && !blankSentence(word)) return false;
    return !!makeQuestion(kind, word, pool, () => 0.5);
  }

  // Seconds where the clip should stop: the next transcript line.
  function clipEnd(startSec, lines) {
    const next = (lines || []).find(l => l.sec > startSec + 0.5);
    let end = next ? next.sec : startSec + 5;
    if (end - startSec < 1.5) end = startSec + 1.5;
    if (end - startSec > 10)  end = startSec + 10;
    return end;
  }

  /* ══════════════════════════════════════════════════════
     SAVED PROGRESS
     One localStorage key. If storage is blocked, everything
     still works for this visit; .ok becomes false.
     ══════════════════════════════════════════════════════ */
  function browserStorage() {
    try {
      if (typeof localStorage === 'undefined') return null;
      const t = '__hwasa_test__';
      localStorage.setItem(t, '1');
      localStorage.removeItem(t);
      return localStorage;
    } catch (e) { return null; }
  }

  function emptyData() { return { v: 1, history: {}, sessions: {}, best: {} }; }

  function cleanData(d) {
    const out = emptyData();
    if (!d || typeof d !== 'object') return out;
    ['history', 'sessions', 'best'].forEach(k => {
      if (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k])) out[k] = d[k];
    });
    return out;
  }

  function Progress(backend) {
    this.backend = backend === undefined ? browserStorage() : backend;
    this.ok = !!this.backend;
    this.data = emptyData();
    this.reload();
  }

  Progress.prototype.reload = function () {
    if (!this.backend) return;
    try {
      const raw = this.backend.getItem(STORAGE_KEY);
      this.data = cleanData(raw ? JSON.parse(raw) : null);
    } catch (e) {
      this.data = emptyData();
    }
  };

  Progress.prototype.save = function () {
    if (!this.backend) return false;
    try {
      this.backend.setItem(STORAGE_KEY, JSON.stringify(this.data));
      return true;
    } catch (e) {
      this.ok = false;
      return false;
    }
  };

  Progress.prototype.history = function (id) { return this.data.history[id] || null; };

  Progress.prototype.record = function (id, correct, now) {
    now = now || Date.now();
    const h = this.data.history[id] || { seen: 0, missed: 0, streak: 0, last: 0, lastMiss: 0, lastRes: null };
    h.seen++;
    if (correct) { h.streak++; h.lastRes = 1; }
    else { h.missed++; h.streak = 0; h.lastMiss = now; h.lastRes = 0; }
    h.last = now;
    this.data.history[id] = h;
    this.save();
    return h;
  };

  Progress.prototype.group = function (id) { return groupOf(this.history(id)); };

  Progress.prototype.getSession = function (key) { return this.data.sessions[key] || null; };
  Progress.prototype.setSession = function (key, s) { this.data.sessions[key] = s; this.save(); };
  Progress.prototype.clearSession = function (key) { delete this.data.sessions[key]; this.save(); };

  // Best result per quiz key. Kept as the best percentage (ties: the longer quiz).
  Progress.prototype.recordBest = function (key, score, total) {
    if (!total) return null;
    const pct = score / total;
    const b = this.data.best[key];
    if (!b || pct > b.pct || (pct === b.pct && total > b.total)) {
      this.data.best[key] = { score, total, pct, at: Date.now() };
      this.save();
    }
    return this.data.best[key];
  };
  Progress.prototype.getBest = function (key) { return this.data.best[key] || null; };

  Progress.prototype.exportJSON = function () {
    return JSON.stringify({ app: 'hwasa-quiz', v: 1, exportedAt: new Date().toISOString(), data: this.data }, null, 1);
  };

  // Merges a backup into what is already saved. Returns counts, or throws on a bad file.
  Progress.prototype.importJSON = function (text) {
    const j = JSON.parse(text);
    if (!j || j.app !== 'hwasa-quiz' || !j.data) throw new Error('This file is not a Hwasa quiz backup.');
    const inc = cleanData(j.data);
    let words = 0;
    Object.keys(inc.history).forEach(id => {
      const a = this.data.history[id], b = inc.history[id];
      if (!b || typeof b !== 'object') return;
      if (!a || (b.last || 0) > (a.last || 0)) { this.data.history[id] = b; words++; }
    });
    Object.keys(inc.best).forEach(k => {
      const a = this.data.best[k], b = inc.best[k];
      if (b && (!a || b.pct > a.pct)) this.data.best[k] = b;
    });
    Object.keys(inc.sessions).forEach(k => {
      if (!this.data.sessions[k]) this.data.sessions[k] = inc.sessions[k];
    });
    this.save();
    return { words };
  };

  /* ══════════════════════════════════════════════════════
     REPETITION STRATEGY
     ══════════════════════════════════════════════════════ */
  function groupOf(h) {
    if (!h || !h.seen) return 'new';
    if (h.lastRes === 0) return 'shaky';
    if (h.missed > 0 && h.streak < SHAKY_EXIT) return 'shaky';
    if (h.streak >= KNOWN_AT) return 'known';
    return 'learning';
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function weightedSample(items, k, weight, rng) {
    const pool = items.map(x => ({ x, w: Math.max(weight(x), 0.0001) }));
    const out = [];
    while (out.length < k && pool.length) {
      const total = pool.reduce((s, p) => s + p.w, 0);
      let r = rng() * total, i = 0;
      while (i < pool.length - 1 && (r -= pool[i].w) > 0) i++;
      out.push(pool.splice(i, 1)[0].x);
    }
    return out;
  }

  /* buildQuiz(ids, n, { focus, history, rng }) → ordered list of ids
     focus off: plain random pick.
     focus on : ~40% Shaky, ~40% New+Learning, rest Known; short groups
                hand their slots on (New+Learning, then Known, then Shaky);
                ordered to start (and end) on a Known word with no two
                Shaky words back to back. */
  function buildQuiz(ids, n, opts) {
    opts = opts || {};
    const rng  = opts.rng || Math.random;
    const hist = opts.history || (() => null);
    ids = Array.from(new Set(ids));
    if (!ids.length) return [];
    n = Math.max(1, Math.min(Math.floor(n) || ids.length, ids.length));
    if (!opts.focus) return shuffle(ids, rng).slice(0, n);

    const G = { shaky: [], fresh: [], known: [] };
    const fresh = { new: [], learning: [] };
    ids.forEach(id => {
      const g = groupOf(hist(id));
      if (g === 'shaky') G.shaky.push(id);
      else if (g === 'known') G.known.push(id);
      else { G.fresh.push(id); fresh[g].push(id); }
    });

    const want = { shaky: Math.floor(n * MIX_SHAKY), fresh: Math.floor(n * MIX_FRESH) };
    want.known = n - want.shaky - want.fresh;
    const take = {};
    ['shaky', 'fresh', 'known'].forEach(g => { take[g] = Math.min(want[g], G[g].length); });
    let left = n - take.shaky - take.fresh - take.known;
    ['fresh', 'known', 'shaky'].forEach(g => {
      const extra = Math.min(left, G[g].length - take[g]);
      take[g] += extra; left -= extra;
    });

    // Shaky: more misses and more recent misses weigh more.
    const byRecent = G.shaky.slice().sort((a, b) => ((hist(b) || {}).lastMiss || 0) - ((hist(a) || {}).lastMiss || 0));
    const m = byRecent.length;
    const rank = new Map(byRecent.map((id, i) => [id, i]));
    const S = weightedSample(G.shaky, take.shaky, id => {
      const h = hist(id) || {};
      return (1 + (h.missed || 0)) * (1 + (m - 1 - rank.get(id)) / Math.max(1, m - 1));
    }, rng);

    // New first (random), then Learning seen longest ago.
    const lastOf = id => (hist(id) || {}).last || 0;
    const F = shuffle(fresh.new, rng)
      .concat(shuffle(fresh.learning, rng).sort((a, b) => lastOf(a) - lastOf(b)))
      .slice(0, take.fresh);

    // Known: seen longest ago.
    const K = shuffle(G.known, rng).sort((a, b) => lastOf(a) - lastOf(b)).slice(0, take.known);

    return arrange(S, F, K, rng);
  }

  function arrange(S, F, K, rng) {
    const ks = shuffle(K, rng);
    const first = ks.length ? ks[0] : null;
    const last  = ks.length >= 2 ? ks[1] : null;
    const mid = shuffle(F.concat(ks.slice(first === null ? 0 : (last === null ? 1 : 2))), rng);
    const seq = [];
    if (first !== null) seq.push(first);
    seq.push(...mid);
    if (last !== null) seq.push(last);
    if (!seq.length) return shuffle(S, rng);

    // Gaps where a Shaky word may go (index = "insert before seq[i]").
    let gaps = [];
    for (let i = 0; i <= seq.length; i++) {
      if (i === 0 && first !== null) continue;
      if (i === seq.length && last !== null) continue;
      gaps.push(i);
    }
    if (!gaps.length) gaps = [seq.length];
    gaps = shuffle(gaps, rng);
    const slot = new Map();
    shuffle(S, rng).forEach((id, i) => {
      const g = gaps[i % gaps.length];
      if (!slot.has(g)) slot.set(g, []);
      slot.get(g).push(id);
    });
    const out = [];
    for (let i = 0; i <= seq.length; i++) {
      if (slot.has(i)) out.push(...slot.get(i));
      if (i < seq.length) out.push(seq[i]);
    }
    return out;
  }

  return {
    STORAGE_KEY, SHAKY_EXIT, KNOWN_AT,
    nfc, stripMd, normText, questionId, tsToSeconds, normTs,
    parseQuiz, parseVocab, parseVocabPage, vocabTag, levelRank,
    parseTranscriptLines, lineAt, findContext, clipEnd,
    browserStorage, Progress, groupOf, buildQuiz, shuffle,
    wordId, vocabWords, vocabForms, makeQuestion, canPractice, blankSentence
  };
});
