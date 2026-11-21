// grammar-engine.js — stage 4 (grammar rules) and stage 5 (word order rules).
//
// Both stages work on a "doc": { lead, tokens }, where each token is
//   { src, orig, out, pos, status, locked, after }
// Tokens with status "unknown" or locked:true (exact phrase / exception matches)
// are never touched and act as barriers: a rule cannot match across them.
// A rule also cannot match across punctuation (text between tokens must be blank).
//
// GRAMMAR RULE      { direction, find, replace, pos? }
//   find: a word or word sequence ("the cat"), or /regex/flags applied to each token.
//   replace: text ($1 etc. allowed for regex). Empty = delete.
//   pos: optional part of speech given to the replacement token.
// WORD ORDER RULE   { direction, pattern, order }
//   pattern: part-of-speech tags to find, e.g. ["adj","noun"]; "*" matches any token.
//   order: new arrangement as 0-based indexes, e.g. [1,0] swaps the two.
//   Part of speech comes from the optional "pos" field on dictionary words/affixes.

import { phraseKey, isBlank } from "./tokenizer.js";

const canMatch = (t) => t.status !== "unknown" && !t.locked;
const normPos = (p) => (p ? String(p).trim().toLowerCase() : null);

function spanOk(tokens, i, n) {
  for (let k = 0; k < n; k++) {
    if (!canMatch(tokens[i + k])) return false;
    if (k < n - 1 && !isBlank(tokens[i + k].after)) return false;
  }
  return true;
}

// Replace `count` tokens at i with `repl` (or delete them when repl is null),
// keeping punctuation and spacing sensible.
function splice(doc, i, count, repl) {
  const lastAfter = doc.tokens[i + count - 1].after;
  if (repl) {
    repl.after = lastAfter;
    doc.tokens.splice(i, count, repl);
    return;
  }
  doc.tokens.splice(i, count);
  if (i >= doc.tokens.length) {
    if (i > 0) doc.tokens[i - 1].after = lastAfter;
    else doc.lead += lastAfter;
  } else if (!isBlank(lastAfter)) {
    if (i > 0) doc.tokens[i - 1].after = lastAfter;
    else doc.lead += lastAfter;
  }
}

export function applyGrammarRules(doc, rules, warnings) {
  rules.forEach((r, idx) => {
    const find = String(r.find ?? "");
    const rep = String(r.replace ?? "");
    const label = `Grammar rule ${idx + 1}`;
    if (!find.trim()) return;

    const rx = /^\/(.+)\/([a-z]*)$/.exec(find);
    if (rx) {
      let re;
      try { re = new RegExp(rx[1], "gu" + rx[2].replace(/[gu]/g, "")); }
      catch (e) { warnings.push(`${label}: invalid pattern ${find} (skipped)`); return; }
      for (let i = 0; i < doc.tokens.length; ) {
        const tok = doc.tokens[i];
        if (!canMatch(tok)) { i++; continue; }
        const next = tok.out.replace(re, rep);
        if (next === tok.out) { i++; continue; }
        if (!next.trim()) { splice(doc, i, 1, null); continue; }
        tok.out = next;
        tok.status = "rule";
        i++;
      }
      return;
    }

    const key = phraseKey(find);
    if (!key) { warnings.push(`${label}: nothing to find (skipped)`); return; }
    const wanted = key.split(" ").length;
    for (let i = 0; i < doc.tokens.length; ) {
      let hit = 0;
      for (let n = 1; n <= wanted && i + n <= doc.tokens.length; n++) {
        if (!spanOk(doc.tokens, i, n)) break;
        const have = doc.tokens.slice(i, i + n).map((t) => phraseKey(t.out)).join(" ");
        if (have === key) { hit = n; break; }
      }
      if (!hit) { i++; continue; }
      if (!rep.trim()) { splice(doc, i, hit, null); continue; }
      const span = doc.tokens.slice(i, i + hit);
      splice(doc, i, hit, {
        ...span[0],
        src: span.map((t) => t.src).join(" "),
        out: rep.trim(),
        pos: r.pos ? normPos(r.pos) : hit === 1 ? span[0].pos : null,
        status: "rule",
      });
      i++;
    }
  });
}

function validOrder(pattern, order) {
  return Array.isArray(pattern) && Array.isArray(order) &&
    pattern.length >= 2 && pattern.length === order.length &&
    order.every((n) => Number.isInteger(n) && n >= 0 && n < pattern.length) &&
    new Set(order).size === order.length;
}

export function applyWordOrder(doc, rules, warnings) {
  rules.forEach((r, idx) => {
    if (!validOrder(r.pattern, r.order)) {
      warnings.push(`Word order rule ${idx + 1}: pattern and order must be the same length, and order must use each index once (skipped)`);
      return;
    }
    const pattern = r.pattern.map((p) => String(p).trim().toLowerCase());
    const n = pattern.length;
    for (let i = 0; i + n <= doc.tokens.length; ) {
      const block = doc.tokens.slice(i, i + n);
      const match = spanOk(doc.tokens, i, n) &&
        block.every((t, k) => pattern[k] === "*" || t.pos === pattern[k]);
      if (!match) { i++; continue; }
      // Words move; capitalisation and punctuation stay in their original slots.
      for (let k = 0; k < n; k++) {
        doc.tokens[i + k] = { ...block[r.order[k]], orig: block[k].orig, after: block[k].after };
      }
      i += n;
    }
  });
}
