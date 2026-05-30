'use strict';

/**
 * Normalise a player name for fuzzy matching:
 * lowercase, strip accents, collapse whitespace.
 */
function normaliseName(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/**
 * Extract the surname from a normalised player name.
 *
 * Handles two formats:
 *   Betfair-abbreviated  "tsitsipas s"           → "tsitsipas"
 *   Betfair compound     "van de zandschulp b"   → "zandschulp"  (token before initial)
 *   Betfair compound     "del potro j"            → "potro"
 *   Full name            "stefanos tsitsipas"     → "tsitsipas"   (last token)
 *   Full compound        "botic van de zandschulp"→ "zandschulp"  (last token)
 *
 * Detection: if the last token is ≤ 2 chars it is a Betfair initial.
 * Return the token immediately before the initial (not the first token)
 * so compound surnames like "Van De Zandschulp" are resolved correctly.
 */
function extractSurname(normalisedName) {
  const tokens = normalisedName.split(' ').filter(Boolean);
  if (tokens.length === 0) return normalisedName;
  const first = tokens[0];
  const last  = tokens[tokens.length - 1];
  // api-tennis format: "Initial Surname[s]" — first token is 1-2 char initial
  // (e.g. "a li", "j del potro", "ka pliskova"). Surname is the LAST token.
  // Handles short real surnames like Li, Bu, Wu that would otherwise be
  // misread as Betfair initials.
  if (tokens.length >= 2 && first.length <= 2) {
    return last;
  }
  // Betfair "Surname Initial" format — only when the trailing token is exactly
  // 1 char (real initials). 2-char trailing tokens like "li"/"bu" are surnames.
  if (tokens.length >= 2 && last.length === 1) {
    return tokens[tokens.length - 2];
  }
  // Full name format: surname is the last token.
  return last;
}

/**
 * Returns true if two player names are likely the same person.
 * Handles these formats:
 *   "Novak Djokovic"          vs  "Djokovic N"          (Betfair abbreviated)
 *   "Stefanos Tsitsipas"      vs  "Tsitsipas S"
 *   "Botic Van de Zandschulp" vs  "Van De Zandschulp B" (compound surname)
 *   "Juan Martin Del Potro"   vs  "Del Potro J"
 *   "Djokovic"                vs  "Novak Djokovic"
 */
function playerNamesMatch(nameA, nameB) {
  const a = normaliseName(nameA);
  const b = normaliseName(nameB);
  if (a === b) return true;

  // Contains check: only when the shorter string is > 3 chars to avoid
  // single-initial false positives (e.g. "d" matching "djokovic d").
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length > 3 && longer.includes(shorter)) return true;

  // Surname-based matching — handles abbreviated vs full name and compound surnames.
  // extractSurname returns the token before the initial for Betfair format,
  // and the last token for full names, so compound surnames resolve correctly.
  const surnameA = extractSurname(a);
  const surnameB = extractSurname(b);
  if (surnameA.length >= 2 && surnameA === surnameB) return true;

  // Prefix match for truncated surnames (e.g. Betfair "gonzal" vs API "gonzalez").
  // Require at least 5 chars to avoid spurious matches.
  const [shorterSurname, longerSurname] = surnameA.length <= surnameB.length
    ? [surnameA, surnameB] : [surnameB, surnameA];
  if (shorterSurname.length >= 5 && longerSurname.startsWith(shorterSurname)) return true;

  // Multi-token overlap: extract all meaningful tokens (≥ 4 chars) from both names
  // and check if any appear in both. Handles API Tennis abbreviated format
  // "T. Barrios Vera" vs Betfair "Marcelo Tomas Barrios V" where "barrios" is shared.
  const tokensA = a.split(' ').filter(t => t.length >= 4);
  const tokensB = b.split(' ').filter(t => t.length >= 4);
  if (tokensA.length > 0 && tokensB.length > 0) {
    const setA = new Set(tokensA);
    if (tokensB.some(t => setA.has(t))) return true;
  }

  return false;
}

/**
 * Clamp a number between min and max.
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Convert decimal odds to implied probability.
 */
function oddsToImpliedProb(decimalOdds) {
  return 1 / decimalOdds;
}

/**
 * Sleep for ms milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { normaliseName, extractSurname, playerNamesMatch, clamp, oddsToImpliedProb, sleep };
