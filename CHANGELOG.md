# Changelog

All notable changes to Peckish. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow semver (0.x: minor = features, patch = fixes). Each release on
[GitHub Releases](https://github.com/CydVilla/peckish/releases) carries this
file's section for that version, every downloadable artifact, and a
`SHA256SUMS.txt` to verify them.

## [Unreleased]

### Added
- **Sign-in assist**: when DoorDash sign-in is missing or expired, Peckish now
  offers to fix it instead of sending you to a terminal. The terminal app asks
  before launching `dd-cli login` (which opens your browser) and waits for it;
  the web app serves a sign-in card instead of refusing to boot; and a new
  `start_signin` tool lets the agent offer the same assist mid-conversation on
  every surface — always behind an explicit approval prompt, and it never
  opens a second sign-in window while one is pending.

### Fixed
- The extension manifest's version is now read from `extension/package.json`
  and its tool list from the repo's own build (previously a hardcoded version
  and the installed npm package could both drift).

## [0.4.0] - 2026-07-28

Compatibility release for **dd-cli v0.2.1** (required — older dd-cli versions
no longer work with Peckish 0.4.0, and vice versa). After upgrading dd-cli,
run `dd-cli login` again: new CLI versions can require fresh sign-in scopes.

### Added
- **Group carts**: "start a group order, $25 each" — creates a shareable cart
  link (`group_cart_url`), optional per-person spend limit, join someone
  else's cart by its id; the host previews and submits.
- **Priority (express) delivery**: request the paid faster option; Peckish
  verifies the cart actually offers it before promising, and carries the same
  choice through to submit so the charge matches the quote.
- **Credits control**: DoorDash credits apply by default; "don't use my
  credits" opts a single order out (preview and submit stay consistent).
- **Enterprise chains**: Domino's, Sweetgreen, Dave's Hot Chicken and other
  large chains are now orderable.
- Dockerfile for registry/CI introspection (the MCP server boots and lists
  its tools without dd-cli, which is only executed at tool-call time).

### Changed
- Every dd-cli call now carries the CLI's new required `--intent` note —
  with a **privacy-preserving default**: Peckish sends a generic goal summary
  and explicitly withholds your verbatim prompt unless you set
  `PECKISH_INTENT_VERBATIM=1`. See README → "What Peckish shares with
  DoorDash".
- Preview results now include the cart's delivery options (so express
  availability is visible to the agent).

### Fixed
- dd-cli v0.2.1's new authentication-failure message is recognized and
  surfaced as a clear "run `dd-cli login`" instruction instead of a generic
  error.

## [0.3.0] - 2026-07-23

### Added
- Rotating suggestion prompts on the web app's start screen.

### Changed
- Coordinated version bump across all packages (`peckish`, `peckish-mcp`,
  desktop, extension) with dependency ranges moved to `^0.3.0`.

## [0.2.2] - 2026-07-21

### Added
- `peckish-mcp` npm package — one-line MCP install:
  `claude mcp add peckish -- npx -y peckish-mcp`.
- Listed in the official MCP Registry as `io.github.CydVilla/peckish`.
- Claude Desktop `.mcpb` bundle (double-click install) attached to releases.

## [0.2.1] - 2026-07-21

### Added
- Address switcher in the web app: click the address chip to change your
  default delivery address (text edits happen on doordash.com; Peckish picks
  them up automatically).

## [0.2.0] - 2026-07-21

First public release.

### Added
- Three surfaces over one tool layer: terminal chat (`peckish`), local web
  app (`peckish-web`), and MCP server for Claude Desktop / Claude Code.
- Full ordering flow on DoorDash's official dd-cli: search, menus and
  customizations, carts, real fee-included quotes, promos, reorders, order
  history and receipts, groceries/retail, work benefits, scheduled delivery.
- Safety model: placing an order always requires an explicit human approval
  rendered by the surface (typed `yes` / web modal / MCP elicitation dialog,
  fail closed); tip confirmed and payment card named before any submit ask;
  submissions never auto-retry; JSONL audit log of every tool call.
- Cost-lean defaults: claude-sonnet-5 at medium effort, prompt caching,
  per-session cost meter.
- Mac app (.dmg) with guided no-terminal setup.
