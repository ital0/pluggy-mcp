/**
 * `getIdentityByItem` / `getIdentity` tools.
 *
 * Identity is the highest-PII surface in the entire Pluggy API. A single
 * call may return:
 *   - CPF / CNPJ / DNI (`document`, `taxNumber`)
 *   - Full legal name (`fullName`)
 *   - Date of birth
 *   - Phone numbers, emails
 *   - Physical addresses
 *   - Related parties (mother, father, spouse) with their names and
 *     documents
 *   - Informed salary (`Qualifications.informedIncome.amount`)
 *   - Informed patrimony
 *   - Financial-relationship account numbers & procurators
 *
 * Because of that, the tools are gated three ways:
 *
 *   1. Opt-IN env: `PLUGGY_MCP_ENABLE_IDENTITY=true` (default `false`).
 *      Until set, the tools refuse to make the SDK call — they return a
 *      hardcoded `FORBIDDEN` envelope. NO upstream round-trip occurs.
 *   2. Allowlist: `getIdentityByItem(itemId)` honors `PLUGGY_ITEM_IDS`.
 *      `getIdentity(identityId)` does NOT — we cannot cheaply map an
 *      identityId back to an itemId without an extra round-trip. Its
 *      description documents this loudly.
 *   3. Audit: every call emits `sensitive: true` so log-shipping pipelines
 *      can route the line to a narrower audience.
 *
 * When the toggle is enabled AND `PLUGGY_MCP_REDACT !== 'false'`, every
 * PII field is masked:
 *   - CPF / document → `redactCpf`
 *   - Name(s) (full, related parties, procurators) → `redactOwnerName`
 *   - Emails → `redactEmail`
 *   - Phones → `redactPhone`
 *   - Addresses → drop `fullAddress`, `primaryAddress`, `postalCode`;
 *     keep `city`, `state`, `country`, `type` (location signal without
 *     exposing the street).
 *   - Salary / patrimony amounts → pass through (the whole point of the
 *     tool); wrapped in `<untrusted>` is not appropriate for numerics.
 *   - Tax-payer name (`fullName`) → `redactOwnerName`
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { getPluggyClient } from '../pluggy/client.js';
import { dateToIso } from '../util/date.js';
import { ErrorCodeEnum, classifyAndReport } from '../util/errors.js';
import { loadSecurityConfig, isItemAllowed } from '../config.js';
import {
  audit,
  checkRateLimit,
  hashArgsSafely,
  redactAccountNumber,
  redactCpf,
  redactEmail,
  redactOwnerName,
  redactPhone,
  wrapUntrusted,
  UNTRUSTED_PREAMBLE,
  LOCAL_RATE_LIMITED_MESSAGE,
  ITEM_NOT_ALLOWED_MESSAGE,
} from '../security/index.js';

/**
 * Hardcoded user-facing message for the opt-in toggle. Lives in this
 * module (rather than `security/allowlist.ts`) because the message
 * documents a feature-toggle specific to identity, not a generic gate.
 * No interpolation — same posture as the other LLM-facing constants.
 */
const IDENTITY_DISABLED_MESSAGE =
  'Identity tools are disabled by default. Set PLUGGY_MCP_ENABLE_IDENTITY=true to enable. These tools return CPF, name, addresses, phones, emails, salary, and related-party data — review your threat model before enabling.';

// ---------------------------------------------------------------------------
// Schemas. We surface only the documented Pluggy IdentityResponse fields.
// `postalCode` / `fullAddress` / `primaryAddress` are deliberately ABSENT
// from the address schema because the redact pipeline drops them; keeping
// them out of the schema means an accidental code change that re-adds
// the field fails type-check immediately.
// ---------------------------------------------------------------------------

const PhoneNumberSchema = z.object({
  type: z.string().nullable(),
  value: z.string(),
});

const EmailSchema = z.object({
  type: z.string().nullable(),
  value: z.string(),
});

const IdentityRelationSchema = z.object({
  type: z.string().nullable(),
  name: z.string().nullable(),
  document: z.string().nullable(),
});

const AddressSchema = z.object({
  // Free-text city / state / country; wrap as <untrusted>.
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  type: z.string().nullable(),
  // additionalInfo passes through (city/neighborhood hint), wrapped.
  additionalInfo: z.string().nullable(),
});

const FinancialRelationshipAccountSchema = z.object({
  compeCode: z.string(),
  branchCode: z.string(),
  // Account numbers are PII — but the documented `FinancialRelationshipAccount`
  // type forces non-null strings, so the redactor's non-null branch keeps the
  // shape stable.
  number: z.string(),
  checkDigit: z.string(),
  type: z.string(),
  subtype: z.string(),
});

const ProcuratorSchema = z.object({
  type: z.string(),
  cpfNumber: z.string(),
  // Civil / social names — masked.
  civilName: z.string(),
  socialName: z.string().optional(),
});

const FinancialRelationshipsSchema = z.object({
  startDate: z.string(),
  productsServicesType: z.array(z.string()),
  procurators: z.array(ProcuratorSchema),
  accounts: z.array(FinancialRelationshipAccountSchema).optional(),
});

const InformedIncomeSchema = z.object({
  frequency: z.string(),
  amount: z.number(),
  date: z.string(),
});

const InformedPatrimonySchema = z.object({
  amount: z.number(),
  year: z.number(),
});

const QualificationsSchema = z.object({
  companyCnpj: z.string(),
  occupationCode: z.string().optional(),
  informedIncome: InformedIncomeSchema.optional(),
  informedPatrimony: InformedPatrimonySchema.optional(),
});

const IdentitySchema = z.object({
  id: z.string(),
  itemId: z.string(),
  birthDate: z.string().nullable(),
  // CPF / document fields — masked when redact is on.
  taxNumber: z.string().nullable(),
  document: z.string().nullable(),
  documentType: z.string().nullable(),
  // Free-text job/company — wrapped.
  jobTitle: z.string().nullable(),
  companyName: z.string().nullable(),
  // Full legal name — masked.
  fullName: z.string().nullable(),
  phoneNumbers: z.array(PhoneNumberSchema).nullable(),
  emails: z.array(EmailSchema).nullable(),
  addresses: z.array(AddressSchema).nullable(),
  relations: z.array(IdentityRelationSchema).nullable(),
  investorProfile: z.string().nullable(),
  // Free-text establishment fields — wrapped.
  establishmentName: z.string().nullable(),
  establishmentCode: z.string().nullable(),
  financialRelationships: FinancialRelationshipsSchema.nullable(),
  qualifications: QualificationsSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Mapper. Structural typedef mirrors the SDK's `IdentityResponse` for the
// fields we touch (same approach as the other PR4 modules).
// ---------------------------------------------------------------------------

type IdentityLike = {
  id: string;
  itemId: string;
  birthDate: Date | string | null;
  taxNumber: string | null;
  document: string | null;
  documentType: string | null;
  jobTitle: string | null;
  companyName: string | null;
  fullName: string | null;
  phoneNumbers: Array<{ type: string | null; value: string }> | null;
  emails: Array<{ type: string | null; value: string }> | null;
  addresses: Array<{
    fullAddress: string | null;
    primaryAddress: string | null;
    city: string | null;
    postalCode: string | null;
    state: string | null;
    country: string | null;
    type: string | null;
    additionalInfo: string | null;
  }> | null;
  relations: Array<{
    type: string | null;
    name: string | null;
    document: string | null;
  }> | null;
  investorProfile: string | null;
  establishmentName: string | null;
  establishmentCode: string | null;
  financialRelationships: {
    startDate: Date | string;
    productsServicesType: string[];
    procurators: Array<{
      type: string;
      cpfNumber: string;
      civilName: string;
      socialName?: string;
    }>;
    accounts?: Array<{
      compeCode: string;
      branchCode: string;
      number: string;
      checkDigit: string;
      type: string;
      subtype: string;
    }>;
  } | null;
  qualifications: {
    companyCnpj: string;
    occupationCode?: string;
    informedIncome?: { frequency: string; amount: number; date: Date | string };
    informedPatrimony?: { amount: number; year: number };
  } | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function mapIdentity(
  i: IdentityLike,
  redact: boolean,
): z.infer<typeof IdentitySchema> {
  return {
    id: i.id,
    itemId: i.itemId,
    birthDate: dateToIso(i.birthDate),
    taxNumber: redact ? redactCpf(i.taxNumber) : i.taxNumber,
    document: redact ? redactCpf(i.document) : i.document,
    documentType: i.documentType,
    jobTitle: wrapUntrusted(i.jobTitle),
    companyName: wrapUntrusted(i.companyName),
    fullName: redact ? redactOwnerName(i.fullName) : i.fullName,
    phoneNumbers: i.phoneNumbers
      ? i.phoneNumbers.map((p) => ({
          type: p.type,
          value: redact ? (redactPhone(p.value) as string) : p.value,
        }))
      : null,
    emails: i.emails
      ? i.emails.map((e) => ({
          type: e.type,
          value: redact ? (redactEmail(e.value) as string) : e.value,
        }))
      : null,
    // Addresses: drop `fullAddress`, `primaryAddress`, and `postalCode`
    // entirely from the output. Keep only city / state / country / type
    // so the LLM can still reason about location without the street-level
    // detail. When redact is off, we still drop these fields — the masked
    // address schema is the public contract; operators who need raw values
    // should call the SDK directly outside the MCP path.
    addresses: i.addresses
      ? i.addresses.map((a) => ({
          city: wrapUntrusted(a.city),
          state: wrapUntrusted(a.state),
          country: wrapUntrusted(a.country),
          type: a.type,
          additionalInfo: wrapUntrusted(a.additionalInfo),
        }))
      : null,
    relations: i.relations
      ? i.relations.map((r) => ({
          type: r.type,
          name: redact ? redactOwnerName(r.name) : r.name,
          document: redact ? redactCpf(r.document) : r.document,
        }))
      : null,
    investorProfile: i.investorProfile,
    establishmentName: wrapUntrusted(i.establishmentName),
    establishmentCode: i.establishmentCode,
    financialRelationships: i.financialRelationships
      ? {
          startDate: dateToIso(i.financialRelationships.startDate) ?? '',
          productsServicesType: i.financialRelationships.productsServicesType,
          procurators: i.financialRelationships.procurators.map((p) => ({
            type: p.type,
            cpfNumber: redact ? (redactCpf(p.cpfNumber) as string) : p.cpfNumber,
            civilName: redact
              ? (redactOwnerName(p.civilName) as string)
              : p.civilName,
            socialName:
              p.socialName !== undefined
                ? redact
                  ? (redactOwnerName(p.socialName) ?? undefined)
                  : p.socialName
                : undefined,
          })),
          // accounts is optional; when present, the four-piece bank
          // identifier (compe, branch, number, digit) is a full account
          // address — we still drop the raw `number` and emit a last-4
          // mask through the account-number redactor for the same
          // posture as `getAccounts`.
          accounts: i.financialRelationships.accounts
            ? i.financialRelationships.accounts.map((a) => ({
                compeCode: a.compeCode,
                branchCode: a.branchCode,
                // Centralized redactor handles null/undefined/empty inputs
                // safely; fall back to `****` if it returns null so the
                // schema's non-null `number` contract stays intact.
                number: redact
                  ? (redactAccountNumber(a.number) ?? '****')
                  : a.number,
                checkDigit: a.checkDigit,
                type: a.type,
                subtype: a.subtype,
              }))
            : undefined,
        }
      : null,
    qualifications: i.qualifications
      ? {
          companyCnpj: i.qualifications.companyCnpj,
          occupationCode: i.qualifications.occupationCode,
          // Salary / patrimony amounts pass through unmasked when
          // qualifications are present — that's the whole point of
          // surfacing the field. The opt-in gate above means the operator
          // explicitly took on the risk.
          informedIncome: i.qualifications.informedIncome
            ? {
                frequency: i.qualifications.informedIncome.frequency,
                amount: i.qualifications.informedIncome.amount,
                date:
                  dateToIso(i.qualifications.informedIncome.date) ?? '',
              }
            : undefined,
          informedPatrimony: i.qualifications.informedPatrimony
            ? {
                amount: i.qualifications.informedPatrimony.amount,
                year: i.qualifications.informedPatrimony.year,
              }
            : undefined,
        }
      : null,
    createdAt: dateToIso(i.createdAt) ?? '',
    updatedAt: dateToIso(i.updatedAt) ?? '',
  };
}

// ---------------------------------------------------------------------------
// Output shape & tools
// ---------------------------------------------------------------------------

const IdentityOutputShape = {
  ok: z.boolean(),
  identity: IdentitySchema.optional(),
  errorCode: ErrorCodeEnum.optional(),
  requestId: z.string().optional(),
  message: z.string().optional(),
};

export function registerGetIdentityByItemTool(server: McpServer): void {
  const toolName = 'getIdentityByItem';
  server.registerTool(
    toolName,
    {
      description:
        UNTRUSTED_PREAMBLE +
        '\n\n' +
        'DESTRUCTIVE FOR PRIVACY: returns the identity record (CPF, full ' +
        'name, addresses, phones, emails, salary, related parties) for the ' +
        'natural person attached to a Pluggy Item. ' +
        'Disabled by default; set PLUGGY_MCP_ENABLE_IDENTITY=true to ' +
        'enable. Every call is audit-logged with sensitive=true. ' +
        'When an allowlist (PLUGGY_ITEM_IDS) is configured, only itemIds ' +
        'in the list will be fetched; others return FORBIDDEN without ' +
        'calling the SDK. PII fields are masked when PLUGGY_MCP_REDACT is ' +
        'true (default).',
      inputSchema: {
        itemId: z
          .string()
          .uuid()
          .describe('The Pluggy Item id (UUID) whose identity should be fetched.'),
      },
      outputSchema: IdentityOutputShape,
      annotations: {
        title: 'Get Pluggy Identity By Item',
        // Read-only with respect to upstream data; "destructive" in the
        // description refers to privacy. Mirrors `getRawAccountDetails`.
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ itemId }) => {
      const start = performance.now();
      let outcome: 'success' | 'error' = 'success';
      let errorCode: string | undefined;
      let requestId: string | undefined;
      let rateLimitReason: 'PER_MINUTE' | 'PER_DAY' | undefined;
      // Default false; flipped to true ONLY when we reach the SDK call.
      // Gate denials (toggle off, allowlist, rate-limit) emit a
      // non-sensitive line — no PII was at risk for those paths.
      let sensitive = false;
      try {
        const sec = loadSecurityConfig();
        const rl = sec.rateLimit
          ? checkRateLimit(toolName)
          : { allowed: true as const };
        if (!rl.allowed) {
          outcome = 'error';
          errorCode = 'LOCAL_RATE_LIMITED';
          rateLimitReason = rl.reason;
          const errorOutput = {
            ok: false as const,
            errorCode: 'LOCAL_RATE_LIMITED' as const,
            message: LOCAL_RATE_LIMITED_MESSAGE,
          };
          return {
            isError: true,
            structuredContent: errorOutput,
            content: [{ type: 'text' as const, text: LOCAL_RATE_LIMITED_MESSAGE }],
          };
        }

        // Identity toggle check BEFORE the allowlist — we want NEITHER
        // an upstream call nor a leak of allowlist membership through
        // a different error code when identity is disabled.
        if (!sec.enableIdentity) {
          outcome = 'error';
          errorCode = 'FORBIDDEN';
          const errorOutput = {
            ok: false as const,
            errorCode: 'FORBIDDEN' as const,
            message: IDENTITY_DISABLED_MESSAGE,
          };
          return {
            isError: true,
            structuredContent: errorOutput,
            content: [{ type: 'text' as const, text: IDENTITY_DISABLED_MESSAGE }],
          };
        }

        if (!isItemAllowed(itemId)) {
          outcome = 'error';
          errorCode = 'FORBIDDEN';
          const errorOutput = {
            ok: false as const,
            errorCode: 'FORBIDDEN' as const,
            message: ITEM_NOT_ALLOWED_MESSAGE,
          };
          return {
            isError: true,
            structuredContent: errorOutput,
            content: [{ type: 'text' as const, text: ITEM_NOT_ALLOWED_MESSAGE }],
          };
        }

        // Past all gates — an SDK call is about to happen (success or
        // upstream error). From here on, the audit line is sensitive.
        sensitive = true;
        const client = getPluggyClient();
        const i = await client.fetchIdentityByItemId(itemId);
        const identity = mapIdentity(i as unknown as IdentityLike, sec.redact);

        const output = { ok: true as const, identity };
        return {
          structuredContent: output,
          content: [
            {
              type: 'text' as const,
              // Generic — every PII field is in `structuredContent`. The
              // free-text channel deliberately stays minimal so transcripts
              // don't accumulate identifying detail.
              text: 'Returned identity record.',
            },
          ],
        };
      } catch (err) {
        outcome = 'error';
        const safe = classifyAndReport(err, {
          tool: toolName,
          operation: 'fetchIdentityByItemId',
        });
        errorCode = safe.errorCode;
        requestId = safe.requestId;
        const errorOutput = {
          ok: false as const,
          errorCode: safe.errorCode,
          requestId: safe.requestId,
          message: safe.message,
        };
        return {
          isError: true,
          structuredContent: errorOutput,
          content: [{ type: 'text' as const, text: safe.message }],
        };
      } finally {
        audit({
          tool: toolName,
          outcome,
          errorCode,
          durationMs: Math.round(performance.now() - start),
          ...hashArgsSafely({ itemId }, ['itemId']),
          // sensitive=true is unbypassable on the SDK-touched path —
          // even when the operator disables non-sensitive audit
          // globally, that line always emits to stderr.
          sensitive,
          requestId,
          rateLimitReason,
        });
      }
    },
  );
}

export function registerGetIdentityTool(server: McpServer): void {
  const toolName = 'getIdentity';
  server.registerTool(
    toolName,
    {
      description:
        UNTRUSTED_PREAMBLE +
        '\n\n' +
        'DESTRUCTIVE FOR PRIVACY: returns an identity record (CPF, full ' +
        'name, addresses, phones, emails, salary, related parties) by its ' +
        'opaque identity id. ' +
        'Disabled by default; set PLUGGY_MCP_ENABLE_IDENTITY=true to ' +
        'enable. Every call is audit-logged with sensitive=true. ' +
        'Note: This tool takes a direct identityId and is NOT gated by ' +
        'PLUGGY_ITEM_IDS — we cannot map an identityId back to an itemId ' +
        'without an extra round-trip. Use only with IDs you trust. PII ' +
        'fields are masked when PLUGGY_MCP_REDACT is true (default).',
      inputSchema: {
        identityId: z
          .string()
          .uuid()
          .describe('The Pluggy identity id (UUID) to fetch.'),
      },
      outputSchema: IdentityOutputShape,
      annotations: {
        title: 'Get Pluggy Identity',
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ identityId }) => {
      const start = performance.now();
      let outcome: 'success' | 'error' = 'success';
      let errorCode: string | undefined;
      let requestId: string | undefined;
      let rateLimitReason: 'PER_MINUTE' | 'PER_DAY' | undefined;
      // Default false; flipped to true ONLY when we reach the SDK call.
      // Gate denials (toggle off, rate-limit) emit a non-sensitive line.
      let sensitive = false;
      try {
        const sec = loadSecurityConfig();
        const rl = sec.rateLimit
          ? checkRateLimit(toolName)
          : { allowed: true as const };
        if (!rl.allowed) {
          outcome = 'error';
          errorCode = 'LOCAL_RATE_LIMITED';
          rateLimitReason = rl.reason;
          const errorOutput = {
            ok: false as const,
            errorCode: 'LOCAL_RATE_LIMITED' as const,
            message: LOCAL_RATE_LIMITED_MESSAGE,
          };
          return {
            isError: true,
            structuredContent: errorOutput,
            content: [{ type: 'text' as const, text: LOCAL_RATE_LIMITED_MESSAGE }],
          };
        }

        if (!sec.enableIdentity) {
          outcome = 'error';
          errorCode = 'FORBIDDEN';
          const errorOutput = {
            ok: false as const,
            errorCode: 'FORBIDDEN' as const,
            message: IDENTITY_DISABLED_MESSAGE,
          };
          return {
            isError: true,
            structuredContent: errorOutput,
            content: [{ type: 'text' as const, text: IDENTITY_DISABLED_MESSAGE }],
          };
        }

        // Past all gates — an SDK call is about to happen.
        sensitive = true;
        const client = getPluggyClient();
        const i = await client.fetchIdentity(identityId);
        const identity = mapIdentity(i as unknown as IdentityLike, sec.redact);

        const output = { ok: true as const, identity };
        return {
          structuredContent: output,
          content: [
            { type: 'text' as const, text: 'Returned identity record.' },
          ],
        };
      } catch (err) {
        outcome = 'error';
        const safe = classifyAndReport(err, {
          tool: toolName,
          operation: 'fetchIdentity',
        });
        errorCode = safe.errorCode;
        requestId = safe.requestId;
        const errorOutput = {
          ok: false as const,
          errorCode: safe.errorCode,
          requestId: safe.requestId,
          message: safe.message,
        };
        return {
          isError: true,
          structuredContent: errorOutput,
          content: [{ type: 'text' as const, text: safe.message }],
        };
      } finally {
        audit({
          tool: toolName,
          outcome,
          errorCode,
          durationMs: Math.round(performance.now() - start),
          ...hashArgsSafely({ identityId }, ['identityId']),
          sensitive,
          requestId,
          rateLimitReason,
        });
      }
    },
  );
}
