/**
 * PII redactors.
 *
 * Every redactor returns:
 *   - `null` when the input is `null` or `undefined`
 *   - the input unchanged when the input is the empty string
 *   - a masked string otherwise
 *
 * Each redactor is idempotent: feeding an already-masked value back in
 * either returns the same string or a value that is itself already masked,
 * so accidental double-redaction never silently strips more data.
 *
 * The goal of these helpers is to give the LLM enough signal to disambiguate
 * different accounts / cards / contacts (e.g. last-4 of an account number)
 * while never exposing the full identifier in the LLM context window.
 */

/**
 * Brazilian CPF: 11 digits, conventionally rendered `NNN.NNN.NNN-NN`.
 * We keep the last 2 digits (the check-digits) so the model can still
 * disambiguate accounts visually without exposing the identifier.
 *
 * Already-masked inputs (matching the exact redactor output shape) are
 * returned unchanged.
 */
const REDACTED_CPF_RE = /^\*{3}\.\*{3}\.\*{3}-\d{2}$/;
export function redactCpf(cpf?: string | null): string | null {
  if (cpf === null || cpf === undefined) return null;
  if (cpf === '') return cpf;
  // Structural idempotent guard: only short-circuit on the exact output shape.
  if (REDACTED_CPF_RE.test(cpf)) return cpf;

  const digits = cpf.replace(/\D/g, '');
  if (digits.length < 2) {
    // Nothing useful to keep — fully mask.
    return '***.***.***-**';
  }
  const last2 = digits.slice(-2);
  return `***.***.***-${last2}`;
}

/**
 * Bank account number: keep only the last 4 digits.
 *
 * Already-masked inputs (exact `****` + 0-4 trailing digits) pass through
 * unchanged. We match the exact redactor output shape, not just a `****`
 * prefix, so values that merely start with stars don't bypass redaction.
 */
const REDACTED_LAST4_RE = /^\*{4}\d{0,4}$/;
export function redactAccountNumber(number?: string | null): string | null {
  if (number === null || number === undefined) return null;
  if (number === '') return number;
  if (REDACTED_LAST4_RE.test(number)) return number;

  const digits = number.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  const last4 = digits.slice(-4);
  return `****${last4}`;
}

/**
 * PAN (card number): keep the last 4 digits only.
 * Mirrors `redactAccountNumber` — kept as its own function so call sites
 * read clearly at the redaction point ("we are masking a card here").
 */
export function redactCardNumber(pan?: string | null): string | null {
  if (pan === null || pan === undefined) return null;
  if (pan === '') return pan;
  if (REDACTED_LAST4_RE.test(pan)) return pan;

  const digits = pan.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  const last4 = digits.slice(-4);
  return `****${last4}`;
}

/**
 * Account-holder full name: first name + last initial (e.g. `"Italo M."`).
 *
 * Policy:
 *  - Single-token names (e.g. `"Madonna"`) return first char + `***`
 *    (e.g. `"M***"`). The token itself is identifying enough that we
 *    can't just pass it through.
 *  - Multi-token names return `"FirstName X."` where `X` is the initial
 *    of the LAST meaningful surname token. Brazilian generational suffixes
 *    (Filho, Neto, Junior/Júnior, Sobrinho) and noble particles
 *    (da, de, do, dos, das) are skipped when picking the surname token,
 *    so `"Pedro Almeida Filho"` becomes `"Pedro A."` (not `"Pedro F."`)
 *    and `"João da Silva"` becomes `"João S."` (not `"João d."`).
 *  - Already-redacted values (matching the exact output shape) pass
 *    through.
 */
const REDACTED_OWNER_RE = /^[A-Z][a-záéíóúâêôãõç]* [A-Z]\.$/;
const NAME_SUFFIXES = new Set([
  'filho',
  'neto',
  'junior',
  'júnior',
  'sobrinho',
]);
const NAME_PARTICLES = new Set(['da', 'de', 'do', 'dos', 'das']);

export function redactOwnerName(name?: string | null): string | null {
  if (name === null || name === undefined) return null;
  if (name === '') return name;

  const trimmed = name.trim();
  if (trimmed === '') return name; // preserve whitespace-only as-is (rare)

  // Structural idempotent guard: match the exact redactor output shape
  // (capitalized first name + single uppercase initial + period).
  if (REDACTED_OWNER_RE.test(trimmed)) return trimmed;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) {
    // Single-token names are too identifying to pass through verbatim.
    const initial = tokens[0][0] ?? '';
    return `${initial}***`;
  }

  const first = tokens[0];

  // Walk from the right, skipping suffixes and particles, until we find
  // a token we can extract a surname initial from. Fall back to the very
  // last token if everything was filtered.
  let surnameToken = tokens[tokens.length - 1];
  for (let i = tokens.length - 1; i > 0; i--) {
    const lower = tokens[i].toLowerCase();
    if (NAME_SUFFIXES.has(lower) || NAME_PARTICLES.has(lower)) continue;
    surnameToken = tokens[i];
    break;
  }

  const lastInitial = surnameToken[0]?.toUpperCase() ?? '';
  return `${first} ${lastInitial}.`;
}

/**
 * Email address: keep first 3 chars of local-part + domain
 * (`"italo@example.com" -> "ita***@example.com"`). Local-parts shorter
 * than 4 chars keep only their first char (`"al@x.com" -> "a***@x.com"`).
 *
 * If the input doesn't contain `@`, we treat the whole string as a local
 * part and apply the same rule. Already-masked emails (containing `***@`)
 * are returned unchanged.
 */
const REDACTED_EMAIL_RE = /^([^@]{0,3})\*{3}@.+$/;
const REDACTED_EMAIL_NO_LOCAL_RE = /^\*{3}@.+$/;
export function redactEmail(email?: string | null): string | null {
  if (email === null || email === undefined) return null;
  if (email === '') return email;
  // Structural idempotent guards: match the exact two output shapes.
  if (REDACTED_EMAIL_NO_LOCAL_RE.test(email)) return email;
  if (REDACTED_EMAIL_RE.test(email)) return email;

  const atIdx = email.indexOf('@');
  const local = atIdx >= 0 ? email.slice(0, atIdx) : email;
  const domain = atIdx >= 0 ? email.slice(atIdx) : '';

  if (local.length === 0) return `***${domain}`;
  if (local.length < 4) {
    return `${local[0]}***${domain}`;
  }
  return `${local.slice(0, 3)}***${domain}`;
}

/**
 * Phone number: digits-only, keep the last 4 (`****1234`).
 * Non-digit formatting (`+55 (11) 9 ...`) is stripped before counting so
 * inputs with international prefixes still mask cleanly.
 */
export function redactPhone(phone?: string | null): string | null {
  if (phone === null || phone === undefined) return null;
  if (phone === '') return phone;
  if (REDACTED_LAST4_RE.test(phone)) return phone;

  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return phone;
  if (digits.length <= 4) return '****';
  const last4 = digits.slice(-4);
  return `****${last4}`;
}
