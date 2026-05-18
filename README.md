# pluggy-mcp

> A Model Context Protocol (MCP) server for the [Pluggy API](https://pluggy.ai)
> — Brazil's Open Finance data aggregator. Gives your LLM read-only access to
> your bank accounts, transactions, investments, credit cards, loans, and
> identity data.

## What it does

- Wraps Pluggy's REST API as an MCP server over the **stdio** transport.
- Exposes **24 read-only tools** spanning accounts, transactions, bills,
  investments, loans, identity, and Pluggy's premium intelligence APIs.
- **PII redaction on by default** — CPF, full account numbers, card numbers,
  owner names, emails, phones, boleto digitable lines, and CNPJ are masked
  before any data reaches the LLM context.
- **Per-tool rate limits** with conservative defaults (30/min, 200/day) so a
  runaway agent can't burn through your Pluggy quota.
- **Structured audit log** to stderr (one JSON line per call); high-risk
  tools (raw account, identity) emit `sensitive: true` events that **cannot
  be suppressed** by the audit toggle.
- **Untrusted-content wrapping** of every free-text field that originated
  from a third party (merchant, institution, OFX memo). Every tool
  description carries a preamble instructing the LLM never to follow
  instructions found inside `<untrusted>...</untrusted>` delimiters.
- **Optional allowlist** (`PLUGGY_ITEM_IDS`) restricts which Pluggy items
  the LLM can query — empty value means **deny all** (fail-closed).
- **Identity tools are opt-in**: the two tools that return CPF, addresses,
  phones, emails, salary, and related-party data are disabled until you
  explicitly set `PLUGGY_MCP_ENABLE_IDENTITY=true`.

```
MCP client (Cursor / Claude Desktop / Codex CLI)
        │  stdio JSON-RPC
        ▼
   pluggy-mcp
        │
        ▼
   rate-limit  ──▶  allowlist  ──▶  Pluggy SDK / rawFetch  ──▶  Pluggy REST API
                       (gated tools)         │                     │
                                             ▼                     ▼
                              redact → wrap <untrusted>      Open Finance /
                                             │              institution data
                                             ▼
                                  audit (emitted in `finally`)
```

## Quick start

### Option A: run from npm (when published)

```bash
npx -y pluggy-mcp
```

### Option B: run from a local clone

```bash
git clone https://github.com/pluggyai/pluggy-mcp.git
cd pluggy-mcp
npm install        # also runs `npm run build` via the `prepare` script
node dist/index.js
```

You will normally not invoke the server directly — your MCP client
([Cursor](#cursor), [Claude Desktop](#claude-desktop),
[OpenAI Codex CLI](#openai-codex-cli)) will launch it on demand.

## Configuration

### Get Pluggy credentials

1. Sign in to the [Pluggy dashboard](https://dashboard.pluggy.ai/).
2. Navigate to **Settings → API** to retrieve your `Client ID` and
   `Client Secret`.
3. (Optional) Use the dashboard to create or import **Items** — each item
   represents one user-institution connection. Copy the item UUIDs if you
   plan to scope the server with [`PLUGGY_ITEM_IDS`](#items-allowlist-pluggy_item_ids).

### Environment variables

| Variable | Required | Default | What it does | Security implication |
| --- | --- | --- | --- | --- |
| `PLUGGY_CLIENT_ID` | yes | — | Pluggy API client id. | Deleted from `process.env` after first read. |
| `PLUGGY_CLIENT_SECRET` | yes | — | Pluggy API client secret. | Deleted from `process.env` after first read. Treat as a password. |
| `PLUGGY_MCP_REDACT` | no | `true` | Mask PII (CPF, account numbers, card numbers, owner names, emails, phones, boleto lines, CNPJ) before returning to the LLM. | Setting `false` logs a loud startup `WARN`. Raw values then reach the LLM context. |
| `PLUGGY_MCP_AUDIT` | no | `true` | Emit one JSON audit line per tool call to stderr. | Setting `false` only suppresses **non-sensitive** lines. `sensitive: true` events are unbypassable. |
| `PLUGGY_MCP_RATELIMIT` | no | `true` | Enforce in-memory per-tool rate limits. | Setting `false` removes the only local guard against agent loops blowing your Pluggy quota. |
| `PLUGGY_MCP_RATELIMIT_PER_MIN` | no | `30` | Per-tool budget over a 60-second sliding window. | Non-positive or non-numeric falls back to the default and logs `config_invalid`. |
| `PLUGGY_MCP_RATELIMIT_PER_DAY` | no | `200` | Per-tool budget over a 24-hour sliding window. | Same fallback behavior as above. |
| `PLUGGY_MCP_DEBUG` | no | `0` | When `1`, also dumps raw upstream error bodies and stacks to stderr. | Error bodies can contain customer data — keep off in production. |
| `PLUGGY_ITEM_IDS` | no | unset | Comma-separated allowlist of Pluggy Item UUIDs. | Unset = no restriction. Present-but-empty = **deny all** (fail-closed). See below. |
| `PLUGGY_MCP_ENABLE_IDENTITY` | no | `false` | Opt-in switch for `getIdentityByItem` and `getIdentity`. Only the literal string `"true"` enables them. | Identity is the highest-PII surface. Every enabled call emits `sensitive: true` regardless of the audit toggle. |

A working `.env.example` is included in the repo.

### Items allowlist (`PLUGGY_ITEM_IDS`)

`PLUGGY_ITEM_IDS` is an optional, comma-separated list of Pluggy Item UUIDs
the operator wants this MCP server scoped to. Get the UUIDs from the Items
list in the [Pluggy dashboard](https://dashboard.pluggy.ai/).

| Value | Meaning |
| --- | --- |
| Unset (no env var) | No restriction — every item is queryable. |
| Set, empty/whitespace | **Deny all.** Every gated tool returns `FORBIDDEN`. A `items_allowlist_empty` event is logged at startup so the misconfig is discoverable. |
| `uuid-a,uuid-b` | Only the listed items are queryable by gated tools. Case-insensitive. |

**Gated tools** (allowlist checked *before* any SDK call):

`getItem`, `listConsents`, `getAccounts`, `listInvestments`, `listLoans`,
`getIdentityByItem`, `getRecurringPayments`, `getInsightsBook` (every
itemId in the input array is validated; any denial returns `FORBIDDEN`
without calling the SDK).

**Not gated** (tools that take an `accountId`, `transactionId`,
`consentId`, `billId`, `investmentId`, `loanId`, or `identityId` —
because mapping those back to a parent item would require an extra
upstream round-trip): `getAccount`, `getRawAccountDetails`,
`getRealTimeBalance`, `listTransactions`, `getTransaction`,
`getConsent` (response is filtered after fetch),
`listBills`, `getBill`, `getInvestment`,
`listInvestmentTransactions`, `getLoan`, `getIdentity`.

The allowlist is **cached at process startup**. Changes require a server
restart.

## MCP client setup

### Cursor

Cursor reads MCP server config from `~/.cursor/mcp.json` (or per-project
under `.cursor/mcp.json`). Add a `pluggy` entry:

```json
{
  "mcpServers": {
    "pluggy": {
      "command": "npx",
      "args": ["-y", "pluggy-mcp"],
      "env": {
        "PLUGGY_CLIENT_ID": "your-client-id",
        "PLUGGY_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

To run against a local clone instead:

```json
{
  "mcpServers": {
    "pluggy": {
      "command": "node",
      "args": ["/absolute/path/to/pluggy-mcp/dist/index.js"],
      "env": {
        "PLUGGY_CLIENT_ID": "your-client-id",
        "PLUGGY_CLIENT_SECRET": "your-client-secret",
        "PLUGGY_ITEM_IDS": "uuid-1,uuid-2"
      }
    }
  }
}
```

Then open **Settings → MCP** in Cursor and verify the server is listed
and connected.

### Claude Desktop

Claude Desktop reads from a per-OS config file:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "pluggy": {
      "command": "npx",
      "args": ["-y", "pluggy-mcp"],
      "env": {
        "PLUGGY_CLIENT_ID": "your-client-id",
        "PLUGGY_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

Restart Claude Desktop after editing the file. Add the optional env vars
(`PLUGGY_ITEM_IDS`, `PLUGGY_MCP_ENABLE_IDENTITY`, etc.) the same way.

### OpenAI Codex CLI

Codex reads from `~/.codex/config.toml`. Add an `[mcp_servers.pluggy]`
table:

```toml
[mcp_servers.pluggy]
command = "npx"
args = ["-y", "pluggy-mcp"]

[mcp_servers.pluggy.env]
PLUGGY_CLIENT_ID = "your-client-id"
PLUGGY_CLIENT_SECRET = "your-client-secret"
# Optional:
# PLUGGY_ITEM_IDS = "uuid-1,uuid-2"
# PLUGGY_MCP_ENABLE_IDENTITY = "true"
```

Restart Codex after editing the file.

## Available tools

PII levels: **none** (no personal data), **low** (institution-controlled
free text, wrapped in `<untrusted>`), **high** (PII redacted by default;
raw available behind explicit opt-in).

### Connectors (reference data — no PII)

| Tool | Input | Returns | PII | Notes |
| --- | --- | --- | --- | --- |
| `listConnectors` | — | All available institutions (banks, brokers, etc.) and their products / health. | none | Free-text names wrapped in `<untrusted>`. |
| `getConnector` | `connectorId` (number) | Single connector by id. | none | Same wrapping. |

### Items and consents

| Tool | Input | Returns | PII | Notes |
| --- | --- | --- | --- | --- |
| `getItem` | `itemId` (UUID) | One user-institution connection; `status` / `executionStatus` indicate freshness. | none | **Allowlist-gated.** |
| `listConsents` | `itemId` (UUID) | Open Finance consents for the item (products, permissions, expiry, revocation). | none | **Allowlist-gated.** |
| `getConsent` | `consentId` | Single consent. | none | Not gated before fetch; response filtered after — denied items return `FORBIDDEN`. |

### Accounts and balances

| Tool | Input | Returns | PII | Notes |
| --- | --- | --- | --- | --- |
| `getAccounts` | `itemId` (UUID) | All accounts for the item. | high (masked) | **Allowlist-gated.** CPF / account number / owner name masked by default. |
| `getAccount` | `accountId` (UUID) | One account. | high (masked) | Not gated. |
| `getRawAccountDetails` | `accountId` (UUID) | Unmasked CPF, full account number, holder name. | **high (UNMASKED)** | Not gated. Every call emits `sensitive: true` audit event. Use only on explicit user request. |
| `getRealTimeBalance` | `accountId` (UUID) | Live balance fetched directly from the institution. | none | Open Finance connectors only; counts against institution rate limit. Not gated. |

### Transactions

| Tool | Input | Returns | PII | Notes |
| --- | --- | --- | --- | --- |
| `listTransactions` | `accountId` (UUID), optional date range, pagination | Paginated transactions. | high (masked) | Payer/receiver CPF + names masked; descriptions and merchant names wrapped in `<untrusted>`. Not gated. |
| `getTransaction` | `transactionId` (UUID) | Single transaction. | high (masked) | Same masking and wrapping. Not gated. |

### Categories

| Tool | Input | Returns | PII | Notes |
| --- | --- | --- | --- | --- |
| `listCategories` | — | Pluggy's global category taxonomy. | none | Resolves `categoryId` values on transactions. |
| `getCategory` | `categoryId` (string) | One category by id. | none | — |

### Credit-card bills

| Tool | Input | Returns | PII | Notes |
| --- | --- | --- | --- | --- |
| `listBills` | `accountId` (credit-card UUID) | Bills (faturas) — due date, total, minimum, charges. | low | Free-text `additionalInfo` on charges wrapped in `<untrusted>`. Not gated. |
| `getBill` | `billId` (UUID) | Single bill. | low | Same wrapping. Not gated. |

### Investments

| Tool | Input | Returns | PII | Notes |
| --- | --- | --- | --- | --- |
| `listInvestments` | `itemId` (UUID) | Investment positions (funds, equities, fixed income, etc.). | high (masked) | **Allowlist-gated.** Owner name masked; asset/issuer/institution wrapped. |
| `getInvestment` | `investmentId` (UUID) | Single position. | high (masked) | Not gated. |
| `listInvestmentTransactions` | `investmentId` (UUID) | BUY / SELL / TAX / TRANSFER movements. | low | Descriptions wrapped. Not gated. |

### Loans

| Tool | Input | Returns | PII | Notes |
| --- | --- | --- | --- | --- |
| `listLoans` | `itemId` (UUID) | Loan / financing contracts with rates, installments, warranties. | low | **Allowlist-gated.** Free text wrapped throughout. |
| `getLoan` | `loanId` (UUID) | Single loan including full installment schedule. | low | Not gated. |

### Identity (opt-in)

These tools are **disabled by default**. Set
`PLUGGY_MCP_ENABLE_IDENTITY=true` to enable.

| Tool | Input | Returns | PII | Notes |
| --- | --- | --- | --- | --- |
| `getIdentityByItem` | `itemId` (UUID) | CPF, full name, addresses, phones, emails, salary, related parties. | **highest** | **Allowlist-gated.** SDK calls emit `sensitive: true`. Masking applies when `PLUGGY_MCP_REDACT=true`. |
| `getIdentity` | `identityId` | Same as above by opaque identity id. | **highest** | Not gated. Same audit + masking behavior. |

### Intelligence (premium)

Premium Pluggy feature — calls return `403` if your account plan does
not include enrichment / insights.

| Tool | Input | Returns | PII | Notes |
| --- | --- | --- | --- | --- |
| `getRecurringPayments` | `itemId` (UUID) | Detected subscription-like recurring payments. | low | **Allowlist-gated.** Free text wrapped. |
| `getInsightsBook` | `itemIds` (UUID array) | Aggregated KPIs (cash flow, recurring income/expenses, account summaries) across one or many items. | low | **Allowlist-gated** — *any* denial in the input list returns `FORBIDDEN` without calling the SDK. |

## Security defaults

The defaults are tuned for a household / single-operator setup that wants
fast onboarding without giving the LLM raw PII. Highlights:

- PII redacted by default; opt-out logs a loud startup `WARN`.
- Audit log is **always on for `sensitive: true` events** even when
  `PLUGGY_MCP_AUDIT=false`.
- Identity tools are **opt-in** and additionally audit every SDK call.
- Pluggy credentials are removed from `process.env` after the first read.
- Items can be scoped via `PLUGGY_ITEM_IDS`; an explicitly empty value
  means **deny all** (fail-closed).

Read [SECURITY.md](./SECURITY.md) for the full threat model before
exposing this server to any LLM client.

## Development

Requirements: **Node.js 22+**, npm.

```bash
git clone https://github.com/pluggyai/pluggy-mcp.git
cd pluggy-mcp
npm install        # `prepare` script also builds
npm run build      # tsc + chmod the entry script
npm run watch      # tsc --watch for active development
npm run inspect    # @modelcontextprotocol/inspector against the built server
```

The project deliberately ships **without an automated test suite**.
Verification is performed manually against the
[`@modelcontextprotocol/inspector`](https://www.npmjs.com/package/@modelcontextprotocol/inspector)
and a live Pluggy sandbox.

## Disclaimer

This project is **not officially affiliated with Pluggy**. It is a
community-maintained MCP server. Financial data is sensitive — review
[SECURITY.md](./SECURITY.md) before exposing this server to any LLM
client. Operators are responsible for safeguarding their Pluggy
credentials and for whatever is written to the audit log stream
(stderr).
