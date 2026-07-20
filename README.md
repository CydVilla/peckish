# Peckish 🍜

**Feeling peckish? Just ask.** An AI ordering agent for DoorDash — it searches,
compares fees, builds the cart, and *you* approve the order. Built on
[Claude](https://platform.claude.com) and DoorDash's official
[`dd-cli`](https://github.com/doordash-oss/doordash-cli).

One tool layer, three surfaces:

| Surface | Start | Best for |
|---|---|---|
| **Terminal chat** | `npm run dev` | Living in the terminal |
| **Local web app** | `npm run web` → http://localhost:4747 | Consumer-friendly UI: store cards, live quote, order-confirm modal |
| **MCP server** | `npm run mcp` (via an MCP client) | Claude Desktop / Claude Code users — **no API key needed**; your Claude subscription powers the model |

```
you › Find me a high-protein dinner under $25 that can arrive within 45
      minutes. Avoid mushrooms and excessive fees.

⚙ search_restaurants {"query":"grilled chicken bowls","limit":8}  ✓ 2.1s
⚙ get_menu {"store_id":"35406455","filter":"chicken"}             ✓ 1.8s
⚙ list_carts {"store_id":"35406455"}                              ✓ 1.2s
⚙ add_items_to_cart {…}                                           ✓ 2.4s
⚙ preview_order {"cart_uuid":"…"}                                 ✓ 3.9s

Best fit: Sharon Korean Kitchen (4.8★, ~24 min) — Grilled Chicken Bulgogi
Bowl, $16.95. No mushrooms listed. Total with fees: $21.40 on your Visa
ending 1234. Suggested Dasher tip is $3.50 — that, another amount, or none?
```

## Architecture

```
terminal REPL          local web app           MCP client (Claude Desktop…)
 src/index.ts           src/web.ts + public/    src/mcp.ts
      └────────────┬─────────┘                       │  (client's model reasons;
                   ↓                                 │   server instructions guide it)
     Claude agent loop, streaming                    │
     src/agent.ts (claude-sonnet-5)                  │
                   └───────────────┬─────────────────┘
                                   ↓
                 28 typed tools — src/tools.ts
                                   ↓
                 sanitizing wrapper — src/ddcli.ts
                                   ↓
                 dd-cli --json-output  →  DoorDash
```

- **Search → menus → cart → preview → confirm → submit**, with the real
  fee/ETA quote (`order preview`) driving every recommendation.
- **Preference memory** — "never mushrooms", "I tip 20%" persist in
  `~/.peckish/preferences.json` across sessions and surfaces.
- **Order-history awareness** — "reorder my usual" works.
- Work benefits, promos, scheduled delivery, pickup, and grocery/retail all wired.

## Safety model

Placing an order **always requires an explicit human approval rendered by the
surface, not by the model**:

| Surface | The gate |
|---|---|
| Terminal | Type `yes` at a prompt |
| Web | "Place order" modal (declines automatically after 5 min) |
| MCP | Client elicitation dialog; clients without elicitation support **cannot place orders at all** (fail closed) |

Plus, on every surface: the agent must confirm the tip and name the payment
card before asking to submit; submit is never auto-retried (it's not
idempotent) and success is only reported after `order status` confirms it;
merchant text is treated as data (DoorDash's widget/assistant-instruction
fields are stripped in the wrapper); read-only CLI calls retry once on
transient errors, mutating calls never do.

## Setup

Prereqs: Node 20+, `dd-cli` installed (`~/.local/bin/dd-cli`) and signed in
(`dd-cli login`).

```sh
npm install

# Terminal or web app — needs an Anthropic API key:
export ANTHROPIC_API_KEY=sk-ant-…
npm run dev     # terminal
npm run web     # http://localhost:4747
```

### MCP (Claude Desktop) — no API key required

```sh
npm run build
```

Then add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "peckish": {
      "command": "node",
      "args": ["/Users/YOU/Desktop/doordash/dist/mcp.js"]
    }
  }
}
```

Restart Claude Desktop and ask it to find you dinner. The order confirmation
appears as a native dialog (elicitation).

Env vars: `DD_AGENT_MODEL` (default `claude-sonnet-5`), `DD_AGENT_EFFORT`
(`low`–`max`, default `medium`), `DD_CLI_PATH` (default `~/.local/bin/dd-cli`),
`PECKISH_PORT` (default `4747`).

**Cost:** defaults are tuned for low spend at decent quality — Sonnet 5 at
medium effort, with prompt caching on both the tool/system prefix and the
conversation tail (tool-loop rounds re-read history at ~10% price). For maximum
quality: `DD_AGENT_MODEL=claude-opus-4-8 DD_AGENT_EFFORT=high`. Haiku is not
recommended: this agent handles carts and money rules. (On MCP, the client —
e.g. Claude Desktop — chooses and pays for the model.)

## Repo map

| File | What it is |
|---|---|
| `src/index.ts` | Terminal REPL surface |
| `src/web.ts` + `public/index.html` | Local web surface: SSE streaming, store/quote cards, confirm modal (localhost-only) |
| `src/mcp.ts` | MCP stdio server: 28 tools + session-context tool, operating instructions, elicitation gates |
| `src/agent.ts` | System prompt + streaming tool loop (terminal + web) |
| `src/tools.ts` | Tool schemas + handlers; menu trimming/filtering |
| `src/ddcli.ts` | `execFile` wrapper: envelope parsing, UI-field stripping, error mapping, bounded read-only retry |
| `src/confirm.ts` | Pluggable confirmation gates (fail closed) |
| `src/prefs.ts` | Preference persistence (`~/.peckish/`) |

## Notes & limitations

- Local-first by design: dd-cli is a macOS (Apple Silicon) binary authenticated
  against your keychain — your Mac is the backend on every surface. Hosted
  delivery (SMS bots, voice) would require DoorDash's partner API.
- One open cart per store (DoorDash rule) — the agent collision-checks and asks.
- `payment-method list` sees cards only; wallet defaults (Apple Pay etc.) are
  confirmed generically or via the browser checkout URL.
- Age-restricted items can't be submitted by an agent — checkout URL fallback.
- Popularity data is deliberately unused (per dd-cli guidance).
