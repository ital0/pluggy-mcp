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
 * Already-masked inputs (already containing `***`) are returned unchanged.
 */
export function redactCpf(cpf?: string | null): string | null {
  if (cpf === null || cpf === undefined) return null;
  if (cpf === '') return cpf;
  // Idempotent guard: an already-masked CPF starts with the mask prefix.
  if (cpf.startsWith('***')) return cpf;

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
 * The input may already be masked (`****1234`), in which case we leave it
 * alone. We strip the mask prefix before counting digits so something like
 * `"****1234"` doesn't get re-masked to `"****"` + 4 stars.
 */
export function redactAccountNumber(number?: string | null): string | null {
  if (number === null || number === undefined) return null;
  if (number === '') return number;
  if (number.startsWith('****')) return number;

  const last4 = number.slice(-4);
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
  if (pan.startsWith('****')) return pan;

  const last4 = pan.slice(-4);
  return `****${last4}`;
}

/**
 * Account-holder full name: first name + last initial (e.g. `"Italo M."`).
 * Single-token names pass through — there's no last name to abbreviate
 * and we don't want to drop the only signal the model has.
 *
 * Already-redacted names (matching `Foo X.`) are returned unchanged.
 */
export function redactOwnerName(name?: string | null): string | null {
  if (name === null || name === undefined) return null;
  if (name === '') return name;

  const trimmed = name.trim();
  if (trimmed === '') return name; // preserve whitespace-only as-is (rare)
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) return tokens[0];

  // Idempotent guard: pattern `FirstName X.` where X is a single letter.
  if (
    tokens.length === 2 &&
    tokens[1].length === 2 &&
    tokens[1].endsWith('.') &&
    /^[A-Za-zÀ-ÿ]$/.test(tokens[1][0])
  ) {
    return trimmed;
  }

  const first = tokens[0];
  const lastInitial = tokens[tokens.length - 1][0]?.toUpperCase() ?? '';
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
export function redactEmail(email?: string | null): string | null {
  if (email === null || email === undefined) return null;
  if (email === '') return email;
  if (email.includes('***@')) return email;

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
  if (phone.startsWith('****')) return phone;

  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return phone;
  const last4 = digits.slice(-4);
  return `****${last4}`;
}
