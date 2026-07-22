# peckish-mcp 🍜

**Let Claude order your dinner.** An MCP server that gives Claude Desktop or
Claude Code real DoorDash ordering — it searches, compares *actual*
fee-included totals, builds the cart, and hands the final "place this order?"
decision back to you as a native approval dialog.

No API key needed: your Claude subscription powers the model.

```
you › Find me a high-protein dinner under $25 that arrives within 45 minutes.
      No mushrooms, and don't bleed me on fees.

⚙ search_restaurants · get_menu · add_items_to_cart · preview_order

Best fit: Sharon Korean Kitchen (4.8★, ~24 min) — Grilled Chicken Bulgogi
Bowl, $16.95. Total with fees: $21.40 on your Visa ending 1234. Suggested
tip $3.50 — that, another amount, or none?
```

## Install

```sh
claude mcp add peckish -- npx -y peckish-mcp
```

Or in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "peckish": {
      "command": "npx",
      "args": ["-y", "peckish-mcp"]
    }
  }
}
```

Claude Desktop users can also install the double-click
[`.mcpb` extension](https://github.com/CydVilla/peckish/releases/latest).

## Requirements

- **A Mac with Apple Silicon** — Peckish is local-first; your machine is the
  backend, because DoorDash sign-in lives in your keychain.
- **Node.js 20+**
- **DoorDash CLI access** (currently waitlist-gated by DoorDash). Install
  [`dd-cli`](https://github.com/doordash-oss/doordash-cli), verify the
  published SHA256, run `bash install.sh`, then `dd-cli login`.

Set `DD_CLI_PATH` if `dd-cli` isn't at `~/.local/bin/dd-cli` — GUI apps don't
inherit your shell `PATH`.

## Safety model

Placing an order **always** requires an explicit approval rendered by your MCP
client, not by the model:

- `submit_order` opens a client **elicitation dialog** you must approve.
  Clients that don't support elicitation **cannot place orders at all**
  (fail closed) — they can still browse, compare, and build carts.
- The model must show you the itemized quote, confirm the Dasher tip, and name
  the card being charged before it may even ask.
- Order submission **never auto-retries** (it isn't idempotent); success is
  reported only after `order status` confirms it.
- Merchant text is treated as data — widget and assistant-instruction fields
  are stripped so store content can't steer the model.
- Every tool call, argument set, and confirmation outcome is written to
  `~/.peckish/logs/*.jsonl`.

## What it can do

28 tools covering search → menus → carts → preview → confirm → submit, plus
comparison shopping across up to 3 finalists with true totals, promo scanning,
pickup-vs-delivery comparison, order history and honest spend breakdowns,
reorders with silent-drop detection, saved dietary preferences, work benefits
(company budgets, expense codes), scheduled delivery, and
groceries/retail/pets/alcohol.

## Other surfaces

`peckish-mcp` is one of three surfaces over the same tool layer. The
[`peckish`](https://www.npmjs.com/package/peckish) package adds a terminal chat
REPL and a local web app (both use your own `ANTHROPIC_API_KEY`), and there's a
double-clickable [Mac app](https://github.com/CydVilla/peckish/releases/latest).

Full docs: [github.com/CydVilla/peckish](https://github.com/CydVilla/peckish)

MIT © Cyd Villavicencio
