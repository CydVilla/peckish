#!/usr/bin/env node
/**
 * A stand-in for the real dd-cli binary, so the tool layer can be exercised
 * end-to-end without a DoorDash account.
 *
 * It cannot tell us what dd-cli's real flags are — only DoorDash's binary can
 * do that. What it does prove is the half Peckish owns: that the handlers
 * build the argv they claim to, that version gating actually gates, and that
 * the response trimmers keep what they promise to keep.
 *
 * Driven by two environment variables:
 *   FAKE_DD_CLI_LOG      file to append each invocation's argv to, as JSON lines
 *   FAKE_DD_CLI_VERSION  what `--version` reports (empty => exit non-zero, as
 *                        a binary too old to have the flag would)
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);

if (process.env.FAKE_DD_CLI_LOG) {
  appendFileSync(process.env.FAKE_DD_CLI_LOG, JSON.stringify(argv) + "\n");
}

if (argv.includes("--version")) {
  const version = process.env.FAKE_DD_CLI_VERSION ?? "";
  if (!version) {
    process.stderr.write("unknown flag: --version\n");
    process.exit(2);
  }
  process.stdout.write(`dd-cli ${version}\n`);
  process.exit(0);
}

/** Value of a flag in the recorded argv, or undefined. */
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

// The command is the first non-flag token(s): "search", "cart add-items", …
// `--json-output` leads the argv, so it is skipped rather than terminating.
const words = [];
for (const a of argv) {
  if (a === "--json-output") continue;
  if (a.startsWith("-")) break;
  words.push(a);
}
const command = words.join(" ");

/** dd-cli answers in an MCP envelope; Peckish reads structuredContent. */
const reply = (structuredContent) => {
  process.stdout.write(JSON.stringify({ content: [], structuredContent, isError: false }));
  process.exit(0);
};

const RESPONSES = {
  "address list": () => ({
    addresses: [
      {
        address_id: "addr_default",
        printable_address: "500 Main St, Springfield",
        label: "Home",
        lat: 37.77,
        lng: -122.42,
        is_default: true,
      },
      {
        address_id: "addr_work",
        printable_address: "1 Office Plaza, Springfield",
        label: "Work",
        lat: 37.79,
        lng: -122.4,
        is_default: false,
      },
    ],
  }),

  "address find": () => ({
    candidates: [
      { place_id: "place_abc", printable_address: "742 Evergreen Terrace, Springfield" },
    ],
  }),

  "address add": () => ({ success: true, address_id: "addr_new", is_default: true }),

  search: () => ({
    stores: [
      {
        store_id: "store_1",
        name: "Ramen House",
        distance: "0.4 mi",
        delivery_time: "25 min",
        rating: 4.7,
        review_count: 1200,
        // dd-cli >=0.2.5 pickup availability
        offers_pickup: true,
        asap_pickup_availability: "available",
        scheduled_pickup_availability: "available",
        next_open_time_asap_pickup_ms: 1790000000000,
        // dd-cli >=0.2.5 order-ahead
        order_ahead_available: true,
        // noise the trimmer should still drop
        internal_ranking_score: 0.91,
        community_rating: 4.2,
      },
    ],
  }),

  menu: () => ({
    store_id: "store_1",
    store_name: "Ramen House",
    menu_id: "menu_1",
    store_is_open: true,
    // dd-cli >=0.2.4 store promotions
    promotions: [{ id: "promo_1", text: "20% off orders over $25" }],
    schedule_ahead_windows: [{ start_ms: 1790000000000, end_ms: 1790003600000 }],
    internal_experiment_bucket: "b7",
    items: [
      {
        item_id: "i_100",
        name: "Tonkotsu Ramen",
        description: "Pork broth, chashu, egg",
        price: 1695,
        category_name: "Ramen",
        has_required_modifiers: true,
        is_orderable: true,
        qualifying_promotion_id: "promo_1",
        telemetry_blob: "x".repeat(400),
      },
      {
        item_id: "i_200",
        name: "Sliced Pork Belly",
        description: "Sold by weight",
        price: 899,
        price_varies: true,
        category_name: "Butcher",
        is_orderable: true,
        weight_unit: "lb",
        purchase_type: "MEASUREMENT",
      },
    ],
  }),

  "restaurant-item-details": () => ({
    item_id: "100",
    name: "Tonkotsu Ramen",
    promotion: { id: "promo_1", text: "20% off orders over $25" },
    extras: [],
  }),

  "cart add-items": (flag) => {
    const base = process.env.FAKE_DD_CLI_NO_CART_UUID
      ? { success: true }
      : { cart_uuid: "cart_1", success: true, order_ahead_available: true };
    const guest = flag("--guest-json");
    if (!guest) return base;
    const parsed = JSON.parse(guest);
    // dd-cli returns the one-time guest_token only on a new guest's first add,
    // nested on the sub-cart it just created.
    if (parsed.first_name) {
      return {
        ...base,
        guest_cart: { name: `${parsed.first_name} ${parsed.last_name}`, guest_token: "gtok_secret_abc123" },
      };
    }
    return { ...base, guest_cart: { acted_for: "existing guest" } };
  },

  "cart list": () => ({ carts: [] }),

  "cart delete": () => ({ success: true }),

  "order history": () => ({
    orders: [
      {
        order_uuid: "order_1",
        store_id: "store_1",
        store_name: "Ramen House",
        created_at: 1780000000000,
        items: [{ name: "Tonkotsu Ramen", quantity: 1, price: 1695 }],
        total: 2210,
        is_reorderable: true,
        fulfillment_type: "DELIVERY",
        // dd-cli >=0.2.3 group-order participation
        is_group_order: true,
        group_order_role: "HOST",
      },
    ],
    page_full: false,
  }),

  "order status": () => ({
    status: "successful",
    eta_minutes: 12,
    is_running_late: false,
    actual_delivery_time_ms: 1780000600000,
  }),

  "find-nearby-stores": () => ({ stores: [] }),
};

const handler = RESPONSES[command];
if (!handler) {
  process.stderr.write(`fake dd-cli: no canned response for "${command}"\n`);
  process.exit(3);
}
reply(handler(flag));
