// translator.js — the translation pipeline. Uses only the data you give it.
//
// Order of use for every word, first match wins:
//   1. exact matches   phrases and exceptions (longest first); locked afterwards
//   2. dictionary      single words
//   3. affixes         prefix/suffix removed, stem looked up, affix swapped
//   4. grammar rules   (grammar-engine.js)
//   5. word order      (grammar-engine.js)
// Anything not found is kept as typed and marked as unknown.
//
// DATA (one object; merge dictionary.json and grammar.json with {...a, ...b}):
//   words:      { source, meanings: ["a","b"], pos? }   first meaning is used toward English
//   phrases:    { source, english }
//   exceptions: { source, english }                     win over phrases and words
//   affixes:    { kind: "prefix"|"suffix", affix, english, pos? }
//   rules:      grammar rules      (see grammar-engine.js)
//   wordOrder:  word order rules   (see grammar-engine.js)
// Every rule/entry may have direction: "both" (default) | "toEnglish" | "fromEnglish"
// (only used by rules, wordOrder).

import { tokenize, normalize, phraseKey, isBlank, matchCase } from "./tokenizer.js";
import { applyGrammarRules, applyWordOrder } from "./grammar-engine.js";

export const DIRECTIONS = ["toEnglish", "fromEnglish"];

const list = (v) => (Array.isArray(v) ? v : []);
const toList = (v) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((s) => String(s).trim()).filter(Boolean);
const trimDash = (s) => String(s ?? "").replace(/^-+|-+$/g, "");
const normPos = (p) => (p ? String(p).trim().toLowerCase() : null);

// ---- lookup tables (one set per direction) ---------------------------------
export function buildTables(data, dir) {
  const toEn = dir === "toEnglish";
  const words = new Map(), exact = new Map(), prefixes = [], suffixes = [];
  const addOnce = (map, key, val) => { if (key && !map.has(key)) map.set(key, val); };
  const sides = (a, b) => (toEn ? [a, b] : [b, a]);   // [from, to]
  const forDir = (r) => !r.direction || r.direction === "both" || r.direction === dir;

  // Exceptions first, then phrases: earlier entries win.
  for (const list_ of [data.exceptions, data.phrases]) {
    for (const e of list(list_)) {
      if (!e.source || !e.english) continue;
      const [from, to] = sides(e.source, e.english);
      addOnce(exact, phraseKey(from), { out: String(to).trim(), pos: null });
    }
  }
  for (const w of list(data.words)) {
    const ms = toList(w.meanings);
    if (!w.source || !ms.length) continue;
    const pos = normPos(w.pos);
    const pairs = toEn ? [[w.source, ms[0]]] : ms.map((m) => [m, w.source]);
    for (const [from, to] of pairs) {
      const key = phraseKey(from);
      addOnce(key.includes(" ") ? exact : words, key, { out: to, pos });  // multi-word = phrase
    }
  }
  for (const a of list(data.affixes)) {
    const src = normalize(trimDash(toEn ? a.affix : a.english));
    const dst = trimDash(toEn ? a.english : a.affix);
    if (!src) continue;
    (a.kind === "prefix" ? prefixes : suffixes).push({ src, dst, pos: normPos(a.pos) });
  }
  const longest = (a, b) => b.src.length - a.src.length;
  prefixes.sort(longest);
  suffixes.sort(longest);

  const maxExact = Math.max(1, ...Array.from(exact.keys(), (k) => k.split(" ").length));
  return {
    words, exact, maxExact, prefixes, suffixes,
    rules: list(data.rules).filter(forDir),
    wordOrder: list(data.wordOrder).filter(forDir),
  };
}

// ---- stages 1–3 ------------------------------------------------------------
function findExact(tokens, i, t) {
  for (let n = Math.min(t.maxExact, tokens.length - i); n >= 1; n--) {
    let blank = true;
    for (let k = 0; k < n - 1; k++) if (!isBlank(tokens[i + k].after)) { blank = false; break; }
    if (!blank) continue;
    const key = tokens.slice(i, i + n).map((x) => normalize(x.text)).join(" ");
    const hit = t.exact.get(key);
    if (hit) return { n, hit };
  }
  return null;
}

function lookupWord(key, t) {
  const direct = t.words.get(key);
  if (direct) return { ...direct, status: "word" };

  const withPrefix = (stem) => {
    for (const p of t.prefixes) {
      if (stem.length > p.src.length && stem.startsWith(p.src)) {
        const h = t.words.get(stem.slice(p.src.length));
        if (h) return { out: p.dst + h.out, pos: p.pos ?? h.pos };
      }
    }
    return null;
  };
  for (const s of t.suffixes) {
    if (key.length <= s.src.length || !key.endsWith(s.src)) continue;
    const stem = key.slice(0, -s.src.length);
    const h = t.words.get(stem) ?? withPrefix(stem);
    if (h) return { out: h.out + s.dst, pos: s.pos ?? h.pos, status: "affix" };
  }
  const p = withPrefix(key);
  return p ? { ...p, status: "affix" } : null;
}

function lookupAll(source, t) {
  const { lead, tokens } = tokenize(source);
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    const ex = findExact(tokens, i, t);
    if (ex) {
      const span = tokens.slice(i, i + ex.n);
      const src = span.map((x, k) => x.text + (k < ex.n - 1 ? x.after : "")).join("");
      out.push({ src, orig: src, out: ex.hit.out, pos: null, status: "exact", locked: true, after: span[ex.n - 1].after });
      i += ex.n;
      continue;
    }
    const tok = tokens[i++];
    const hit = lookupWord(normalize(tok.text), t);
    if (hit) {
      out.push({ src: tok.text, orig: tok.text, out: hit.out, pos: hit.pos ?? null, status: hit.status, locked: false, after: tok.after });
    } else if (/^\p{N}+$/u.test(tok.text)) {
      // Numbers are not words: keep them as typed, without an unknown mark.
      out.push({ src: tok.text, orig: tok.text, out: tok.text, pos: null, status: "number", locked: true, after: tok.after });
    } else {
      out.push({ src: tok.text, orig: tok.text, out: tok.text, pos: null, status: "unknown", locked: false, after: tok.after });
    }
  }
  return { lead, tokens: out };
}

// ---- public API ------------------------------------------------------------
export function createTranslator(data = {}, options = {}) {
  const markUnknown = options.markUnknown ?? ((w) => `[${w}?]`);
  let current = data;
  let cache = {};

  function translate(text, direction) {
    if (!DIRECTIONS.includes(direction)) throw new Error(`Unknown direction "${direction}"`);
    const t = (cache[direction] ??= buildTables(current, direction));
    const warnings = [];
    const doc = lookupAll(text, t);
    applyGrammarRules(doc, t.rules, warnings);
    applyWordOrder(doc, t.wordOrder, warnings);

    const tokens = doc.tokens.map((tok) => ({
      source: tok.src,
      output: tok.status === "unknown" ? markUnknown(tok.out) : matchCase(tok.out, tok.orig),
      status: tok.status,            // exact | word | affix | rule | number | unknown
      pos: tok.pos,
      after: tok.after,
    }));
    return {
      text: doc.lead + tokens.map((x) => x.output + x.after).join(""),
      tokens,
      unknown: doc.tokens.filter((x) => x.status === "unknown").map((x) => x.src),
      warnings,
    };
  }

  return {
    translate,
    toEnglish: (text) => translate(text, "toEnglish"),
    fromEnglish: (text) => translate(text, "fromEnglish"),
    setData(next) { current = next; cache = {}; },   // call after the data is edited
    getData: () => current,
  };
}
