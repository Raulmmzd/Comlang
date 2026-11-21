// tokenizer.js — splits text into words and keeps every separator, so
// spacing and punctuation can be put back exactly as the user typed it.

const WORD_RE = "[\\p{L}\\p{M}\\p{N}]+(?:['\\u2019\\-][\\p{L}\\p{M}\\p{N}]+)*";

// "Hi, you!" -> { lead: "", tokens: [{text:"Hi", after:", "}, {text:"you", after:"!"}] }
export function tokenize(text) {
  text = String(text);
  const found = Array.from(text.matchAll(new RegExp(WORD_RE, "gu")));
  if (!found.length) return { lead: text, tokens: [] };
  const tokens = found.map((m, i) => {
    const end = m.index + m[0].length;
    const next = i + 1 < found.length ? found[i + 1].index : text.length;
    return { text: m[0], after: text.slice(end, next) };
  });
  return { lead: text.slice(0, found[0].index), tokens };
}

export function normalize(s) {
  // NFC: "e" + combining accent and the single accented letter count as the same.
  return String(s).normalize("NFC").toLowerCase().replace(/\u2019/g, "'");
}

// Lookup key for a word or phrase: lowercase words joined by single spaces.
export function phraseKey(s) {
  return tokenize(s).tokens.map((t) => normalize(t.text)).join(" ");
}

export function isBlank(s) {
  return /^\s*$/.test(s);
}

// Copies the capitalisation of `original` (Word / WORD / word) onto `result`.
export function matchCase(result, original) {
  if (!result || !original) return result;
  if (original.length > 1 && original === original.toUpperCase() && original !== original.toLowerCase()) {
    return result.toUpperCase();
  }
  const first = original.charAt(0);
  if (first !== first.toLowerCase()) return result.charAt(0).toUpperCase() + result.slice(1);
  return result;
}
