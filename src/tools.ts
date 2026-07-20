/**
 * Tool definitions + handlers exposed to Claude.
 *
 * Every handler shells out to dd-cli via the sanitizing wrapper and returns a
 * JSON string. The one exception to "tools just do what they're told" is
 * submit_order, which blocks on a typed human confirmation in the terminal —
 * that gate lives here in code, not in the model's judgment.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { ddJson, ddBeautify, getDefaultAddress, DdCliError } from "./ddcli.js";
import { addPreference, removePreference, listPreferences } from "./prefs.js";
import { confirmOrderPlacement, confirmAction } from "./confirm.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const trunc = (s: unknown, n: number): string | undefined =>
  typeof s === "string" ? (s.length > n ? s.slice(0, n) + "…" : s) : undefined;

function j(value: unknown): string {
  return JSON.stringify(value);
}

interface MenuItemWire {
  item_id?: string;
  name?: string;
  description?: string;
  price?: number;
  price_varies?: boolean;
  category_name?: string;
  has_modifiers?: boolean;
  has_required_modifiers?: boolean;
  is_orderable?: boolean;
  unavailability_reason?: string;
}

function trimMenuItem(it: MenuItemWire) {
  return {
    item_id: it.item_id,
    name: it.name,
    description: trunc(it.description, 160),
    price: it.price,
    ...(it.price_varies ? { price_varies: true } : {}),
    category: it.category_name,
    ...(it.has_required_modifiers ? { has_required_modifiers: true } : {}),
    ...(it.is_orderable === false
      ? { is_orderable: false, unavailability_reason: it.unavailability_reason }
      : {}),
  };
}

const MENU_ITEM_CAP = 160;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type Handler = (input: Record<string, any>) => Promise<string>;

export const toolHandlers: Record<string, Handler> = {
  async list_addresses() {
    const res = await ddJson(["address", "list"], { retryOnce: true });
    const addresses = ((res.addresses as any[]) ?? []).map((a) => ({
      address_id: a.address_id,
      printable_address: a.printable_address,
      label: a.label,
      is_default: a.is_default,
    }));
    return j({ addresses });
  },

  async set_default_address({ address_id, printable_address }) {
    const ok = await confirmAction(
      `The agent wants to change your ACCOUNT-WIDE default delivery address to:\n  ${printable_address ?? address_id}\n(This persists across the DoorDash app/web until changed again.)`,
    );
    if (!ok) return j({ success: false, declined_by_user: true });
    const res = await ddJson(["address", "set", "--address-id", String(address_id), "--yes"]);
    return j(res);
  },

  async search_restaurants({ query, lat, lng, limit }) {
    const args = ["search", "-q", String(query)];
    let usedDefault = false;
    if (lat == null || lng == null) {
      const def = await getDefaultAddress();
      if (def) {
        lat = def.lat;
        lng = def.lng;
        usedDefault = true;
      }
    }
    if (lat != null && lng != null) args.push("--lat", String(lat), "--lng", String(lng));
    args.push("--limit", String(limit ?? 8));
    const res = await ddJson(args, { retryOnce: true });
    const stores = ((res.stores as any[]) ?? []).map((s) => ({
      store_id: s.store_id,
      name: s.name,
      distance: s.distance,
      delivery_time: s.delivery_time,
      rating: s.rating,
      review_count: s.review_count,
      ...(String(s.is_link_out) === "True" || s.is_link_out === true
        ? { is_link_out: true }
        : {}),
    }));
    return j({ stores, searched_near: usedDefault ? "default saved address" : "provided coords" });
  },

  async get_menu({ store_id, filter }) {
    const res = await ddJson(["menu", "--store-id", String(store_id)], { retryOnce: true });
    let items = ((res.items as MenuItemWire[]) ?? []).map(trimMenuItem);
    const total = items.length;
    if (filter) {
      const needle = String(filter).toLowerCase();
      items = items.filter(
        (it) =>
          it.name?.toLowerCase().includes(needle) ||
          it.description?.toLowerCase().includes(needle) ||
          it.category?.toLowerCase().includes(needle),
      );
    }
    let note: string | undefined;
    if (items.length > MENU_ITEM_CAP) {
      note = `showing ${MENU_ITEM_CAP} of ${items.length} matching items — pass a narrower filter to see the rest`;
      items = items.slice(0, MENU_ITEM_CAP);
    }
    return j({
      store_id: res.store_id,
      store_name: res.store_name,
      menu_id: res.menu_id,
      store_is_open: res.store_is_open,
      total_items: total,
      returned_items: items.length,
      ...(note ? { note } : {}),
      items,
    });
  },

  async get_restaurant_item_details({ store_id, menu_id, item_id }) {
    const cleanId = String(item_id).replace(/^i_/, "");
    const res = await ddJson([
      "restaurant-item-details",
      "--store-id",
      String(store_id),
      "--menu-id",
      String(menu_id),
      "--item-id",
      cleanId,
    ], { retryOnce: true });
    return j(res);
  },

  async get_store_details({ store_id }) {
    const res = await ddJson(["store-details", "--store-id", String(store_id)], { retryOnce: true });
    return j(res);
  },

  async list_carts({ store_id }) {
    const args = ["cart", "list"];
    if (store_id != null) args.push("--store-id", String(store_id));
    return j(await ddJson(args, { retryOnce: true }));
  },

  async add_items_to_cart({ store_id, menu_id, items, cart_uuid, fulfillment }) {
    const cleaned = (items as any[]).map((it) => ({
      ...it,
      item_id: String(it.item_id).replace(/^i_/, ""),
    }));
    const args = [
      "cart",
      "add-items",
      "--store-id",
      String(store_id),
      "--menu-id",
      String(menu_id),
      "--items-json",
      JSON.stringify(cleaned),
    ];
    if (cart_uuid) args.push("--cart-uuid", String(cart_uuid));
    if (fulfillment) args.push("--fulfillment", String(fulfillment));
    return j(await ddJson(args));
  },

  async show_cart({ cart_uuid }) {
    return j(await ddJson(["cart", "show", "--cart-uuid", String(cart_uuid)], { retryOnce: true }));
  },

  async remove_cart_item({ cart_uuid, cart_item_id }) {
    return j(
      await ddJson([
        "cart",
        "remove-item",
        "--cart-uuid",
        String(cart_uuid),
        "--cart-item-id",
        String(cart_item_id),
      ]),
    );
  },

  async delete_cart({ cart_uuid }) {
    return j(await ddJson(["cart", "delete", "--cart-uuid", String(cart_uuid)]));
  },

  async preview_order({ cart_uuid, scheduled_time, include_work_benefits, selected_budget_id, fulfillment }) {
    const base = ["order", "preview", "--cart-uuid", String(cart_uuid)];
    if (scheduled_time) base.push("--scheduled-time", String(scheduled_time));
    if (include_work_benefits) base.push("--include-work-benefits");
    if (selected_budget_id) base.push("--selected-budget-id", String(selected_budget_id));

    // Canonical human-facing summary first (per dd-cli guidance), then the
    // structured quote for programmatic fields, then the default card.
    // --fulfillment mutates the cart's mode, so it rides only on the first
    // call; the JSON re-read then reflects the already-updated mode.
    const summary = await ddBeautify(
      fulfillment ? [...base, "--fulfillment", String(fulfillment)] : base,
    );
    const raw = await ddJson(base, { retryOnce: true });
    const quote = (raw.quote ?? {}) as Record<string, any>;

    const trimmedQuote = {
      net_total_before_tip: quote.net_total_before_tip?.display_string,
      is_dashpass_applied: quote.is_dashpass_applied,
      is_pre_tippable: quote.is_pre_tippable,
      line_items: ((quote.line_items as any[]) ?? []).map((li) => ({
        label: li.label,
        amount: li.final_money?.display_string,
      })),
      tips_suggestion: (() => {
        const g = ((quote.tips_suggestion_details as any[]) ?? [])[0];
        if (!g) return null;
        const idx = g.default_index;
        const amounts = g.percentage_to_amount_monetary_values as any[] | undefined;
        if (idx == null || !amounts || !amounts[idx]) return null;
        return {
          suggested_cents: amounts[idx].unit_amount,
          suggested_percent: (g.percentage_values as any[] | undefined)?.[idx],
          recipient: g.tip_recipient,
        };
      })(),
      credits_applied: quote.credit_details?.total_credits_applied?.display_string,
      delivery_address: quote.delivery_address?.printable_address,
      fulfillment_type: quote.store_order_cart?.fulfillment_type,
      delivery_availability: quote.delivery_availability
        ? {
            asap_available: quote.delivery_availability.asap_available,
            asap_minutes: quote.delivery_availability.asap_minutes_range_string,
            asap_pickup_available: quote.delivery_availability.asap_pickup_available,
            scheduled_delivery_available: quote.delivery_availability.scheduled_delivery_available,
            is_within_delivery_region: quote.delivery_availability.is_within_delivery_region,
          }
        : undefined,
      pin_code_required: ((quote.dropoff_options as any[]) ?? []).some(
        (o) => o?.proof_of_delivery_type === "PIN_CODE",
      ),
      expense_order_options: quote.expense_order_options,
      team_id: quote.company_payment_info?.team_order_info?.team_id,
    };

    // Default card (dd-cli guidance: surface brand + last4 with every preview)
    let default_card: unknown = null;
    let payment_note: string | undefined;
    try {
      const pm = await ddJson(["payment-method", "list"], { retryOnce: true });
      const cards = (pm.cards as any[]) ?? [];
      const def = cards.find((c) => c.payment_method_id === pm.default_payment_method_id);
      default_card = def
        ? { brand: def.brand, last4: def.last4 }
        : null;
      if (!def)
        payment_note =
          "Default payment method is not a visible card (may be a wallet like Apple Pay). Confirm generically or offer checkout-url.";
    } catch {
      payment_note = "payment-method list failed — offer checkout-url so the user can verify their payment method.";
    }

    return j({
      display_summary: summary,
      quote: trimmedQuote,
      default_card,
      ...(payment_note ? { payment_note } : {}),
      success: raw.success,
      message: raw.message,
    });
  },

  async submit_order({
    cart_uuid,
    tip_cents,
    confirmation_summary,
    scheduled_time,
    fulfillment,
    team_id,
    budget_id,
    team_account_id,
    expense_code,
    expense_notes,
  }) {
    // ── HARD HUMAN GATE ────────────────────────────────────────────────────
    const approved = await confirmOrderPlacement(
      String(confirmation_summary ?? `Cart ${cart_uuid}, tip ${tip_cents ?? 0}¢`),
    );
    if (!approved) {
      return j({
        success: false,
        declined_by_user: true,
        note: "The user declined at the terminal confirmation prompt. Do NOT retry submit unless they explicitly ask again.",
      });
    }
    const args = ["order", "submit", "--cart-uuid", String(cart_uuid), "--yes"];
    args.push("--tip-cents", String(tip_cents ?? 0));
    if (scheduled_time) args.push("--scheduled-time", String(scheduled_time));
    if (fulfillment) args.push("--fulfillment", String(fulfillment));
    if (team_id) args.push("--team-id", String(team_id));
    if (budget_id) args.push("--budget-id", String(budget_id));
    if (team_account_id) args.push("--team-account-id", String(team_account_id));
    if (expense_code) args.push("--expense-code", String(expense_code));
    if (expense_notes) args.push("--expense-notes", String(expense_notes));

    let submitRes: Record<string, unknown>;
    try {
      submitRes = await ddJson(args);
    } catch (err) {
      if (err instanceof DdCliError) {
        return j({
          success: false,
          error: err.message,
          detail: err.detail,
          note: "Submit is NOT idempotent. Check order_status / order history before any retry — the order may still have gone through.",
        });
      }
      throw err;
    }

    // Poll status until it leaves `pending` (bounded), per dd-cli guidance.
    const orderUuid = (submitRes.order_uuid ?? submitRes.order_id) as string | undefined;
    let finalStatus: Record<string, unknown> | null = null;
    if (orderUuid) {
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          finalStatus = await ddJson(["order", "status", "--order-uuid", orderUuid], {
            retryOnce: true,
          });
          const s = String(finalStatus.status ?? "").toLowerCase();
          if (s && s !== "pending") break;
        } catch {
          break;
        }
      }
    }
    return j({
      submit_response: submitRes,
      final_status: finalStatus,
      note: "Only report the order as placed if final_status.status is 'successful'. On 'action_required' the user must finish verification in the DoorDash app; on 'failed' it did not go through.",
    });
  },

  async get_checkout_url({ cart_uuid }) {
    return j(await ddJson(["order", "checkout-url", "--cart-uuid", String(cart_uuid)], { retryOnce: true }));
  },

  async get_order_history({ max, days }) {
    const args = ["order", "history"];
    if (max != null) args.push("--max", String(max));
    if (days != null) args.push("--days", String(days));
    const res = await ddJson(args, { retryOnce: true });
    const orders = ((res.orders as any[]) ?? []).map((o) => ({
      order_uuid: o.order_uuid,
      store_id: o.store_id,
      store_name: o.store_name,
      created_at: o.created_at,
      items: ((o.items as any[]) ?? []).map((it: any) =>
        typeof it === "string" ? it : { name: it.name, quantity: it.quantity, price: it.price },
      ),
      total: o.total ?? o.order_total,
      is_reorderable: o.is_reorderable,
      fulfillment_type: o.fulfillment_type,
      order_target: o.order_target,
    }));
    return j({ orders, page_full: res.page_full });
  },

  async reorder({ order_uuid }) {
    return j(await ddJson(["order", "reorder", "--order-uuid", String(order_uuid)]));
  },

  async get_order_status({ order_uuid }) {
    return j(await ddJson(["order", "status", "--order-uuid", String(order_uuid)], { retryOnce: true }));
  },

  async get_receipt({ order_uuid }) {
    return j(await ddJson(["order", "receipt", "--order-uuid", String(order_uuid)], { retryOnce: true }));
  },

  async list_payment_methods() {
    const res = await ddJson(["payment-method", "list"], { retryOnce: true });
    const cards = ((res.cards as any[]) ?? []).map((c) => ({
      payment_method_id: c.payment_method_id,
      brand: c.brand,
      last4: c.last4,
      is_default: c.payment_method_id === res.default_payment_method_id,
    }));
    return j({
      cards,
      note: "cards[] shows credit/debit cards only — wallets (Apple Pay etc.) and gift cards are not visible here. Never conclude 'no payment method on file' from an empty list.",
    });
  },

  async list_promos({ store_id }) {
    return j(await ddJson(["promo", "list", "--store-id", String(store_id)], { retryOnce: true }));
  },

  async apply_promo({ cart_uuid, promo_code, campaign_id, ad_group_id, ad_id }) {
    const args = ["promo", "apply", "--cart-uuid", String(cart_uuid), "--promo-code", String(promo_code)];
    if (campaign_id) args.push("--campaign-id", String(campaign_id));
    if (ad_group_id) args.push("--ad-group-id", String(ad_group_id));
    if (ad_id) args.push("--ad-id", String(ad_id));
    return j(await ddJson(args));
  },

  async remove_promo({ cart_uuid, promo_code, campaign_id, ad_group_id, ad_id }) {
    const args = ["promo", "remove", "--cart-uuid", String(cart_uuid), "--promo-code", String(promo_code)];
    if (campaign_id) args.push("--campaign-id", String(campaign_id));
    if (ad_group_id) args.push("--ad-group-id", String(ad_group_id));
    if (ad_id) args.push("--ad-id", String(ad_id));
    return j(await ddJson(args));
  },

  async find_stores({ vertical, max, lat, lng }) {
    const args = ["find-nearby-stores"];
    if (vertical) args.push("--vertical", String(vertical));
    if (max != null) args.push("--max", String(max));
    if (lat != null && lng != null) args.push("--lat", String(lat), "--lng", String(lng));
    return j(await ddJson(args, { retryOnce: true }));
  },

  async find_items({ store_id, queries }) {
    const args = ["find-items", "--store-id", String(store_id)];
    for (const q of queries as string[]) args.push("-q", String(q));
    return j(await ddJson(args, { retryOnce: true }));
  },

  async get_grocery_item_details({ store_id, item_id }) {
    return j(
      await ddJson(["item-details", "--store-id", String(store_id), "--item-id", String(item_id)], {
        retryOnce: true,
      }),
    );
  },

  async build_grocery_list({ items, store_id, desired_mx_name, servings }) {
    const args = ["build-grocery-list", "--items-json", JSON.stringify(items)];
    if (store_id) args.push("--store-id", String(store_id));
    if (desired_mx_name) args.push("--desired-mx-name", String(desired_mx_name));
    if (servings != null) args.push("--servings", String(servings));
    return j(await ddJson(args));
  },

  async save_preference({ note }) {
    return j({ preferences: addPreference(String(note)) });
  },

  async remove_preference({ note }) {
    return j({ preferences: removePreference(String(note)) });
  },
};

// ---------------------------------------------------------------------------
// Tool schemas (Anthropic.Tool[])
// ---------------------------------------------------------------------------

const str = (description: string) => ({ type: "string" as const, description });
const num = (description: string) => ({ type: "number" as const, description });
const int = (description: string) => ({ type: "integer" as const, description });
const bool = (description: string) => ({ type: "boolean" as const, description });

export const tools: Anthropic.Tool[] = [
  {
    name: "list_addresses",
    description:
      "List the user's saved DoorDash delivery addresses (label, printable address, default flag). Use to resolve 'home'/'work' references. Delivery always uses the account default address.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_default_address",
    description:
      "Change the ACCOUNT-WIDE default delivery address (persists across app/web). Prompts the user y/N in the terminal before applying. Only call when the user asked to deliver somewhere else.",
    input_schema: {
      type: "object",
      properties: {
        address_id: str("addresses[].address_id from list_addresses"),
        printable_address: str("Human-readable address, shown in the confirmation prompt"),
      },
      required: ["address_id", "printable_address"],
    },
  },
  {
    name: "search_restaurants",
    description:
      "Search nearby restaurants by free-text query. Defaults to the user's default saved address location when lat/lng omitted. Returns store_id, name, distance, delivery_time estimate, rating. Stores with is_link_out=true cannot be ordered through this agent. Restaurant-focused — use find_stores for grocery/retail/pharmacy/pets/alcohol.",
    input_schema: {
      type: "object",
      properties: {
        query: str("Search text, e.g. 'grilled chicken bowls'"),
        lat: num("Optional latitude override"),
        lng: num("Optional longitude override"),
        limit: int("Max results (default 8)"),
      },
      required: ["query"],
    },
  },
  {
    name: "get_menu",
    description:
      "Fetch a restaurant's menu: returns menu_id (needed for cart adds and item details), store_is_open, and items with item_id, name, description, price, category, has_required_modifiers, orderability. Large menus are capped — pass `filter` (case-insensitive substring on name/description/category) to narrow.",
    input_schema: {
      type: "object",
      properties: {
        store_id: str("Store ID from search_restaurants or order history"),
        filter: str("Optional substring filter, e.g. 'chicken'"),
      },
      required: ["store_id"],
    },
  },
  {
    name: "get_restaurant_item_details",
    description:
      "Full details for one restaurant menu item: price, description, and extras[] customization groups (each with options[] holding option_id choices, min/max selections). REQUIRED before adding any item with has_required_modifiers. Pass selected options[].option_id values as nested_options when adding to cart (never extra_id).",
    input_schema: {
      type: "object",
      properties: {
        store_id: str("Restaurant store ID"),
        menu_id: str("menu_id from get_menu"),
        item_id: str("Item ID from get_menu (i_ prefix handled automatically)"),
      },
      required: ["store_id", "menu_id", "item_id"],
    },
  },
  {
    name: "get_store_details",
    description:
      "Store business metadata incl. printable_address — use when the user needs to know WHICH physical location a store is ('which Starbucks?').",
    input_schema: {
      type: "object",
      properties: { store_id: str("Store ID") },
      required: ["store_id"],
    },
  },
  {
    name: "list_carts",
    description:
      "List the user's open (unsubmitted) carts: cart_uuid, store, items, timestamps (epoch ms). ALWAYS check this before creating a cart at a store — only one open cart per store is allowed; if one exists, ask the user whether to extend or replace it.",
    input_schema: {
      type: "object",
      properties: { store_id: str("Optional: filter to one store") },
      required: [],
    },
  },
  {
    name: "add_items_to_cart",
    description:
      "Add items to a cart (creates one if no cart_uuid passed and none open at the store). APPEND semantics: re-adding an item_id SUMS quantities. Items need item_id + item_name + quantity; customizations go in nested_options[] (entries: id, name, quantity, optional recursive options[]). On required-options failure the response lists required_options[] — ask the user to choose, then retry. Check list_carts first.",
    input_schema: {
      type: "object",
      properties: {
        store_id: str("Store ID the items belong to"),
        menu_id: str("Menu ID from get_menu (restaurants) or build_grocery_list/item details (grocery)"),
        items: {
          type: "array",
          description:
            'Items to add, e.g. [{"item_id":"123","item_name":"Salad","quantity":1,"nested_options":[{"id":"456","name":"Ranch","quantity":1}]}]',
          items: {
            type: "object",
            properties: {
              item_id: str("Menu item id"),
              item_name: str("Item display name"),
              quantity: num("Quantity (integer for count items)"),
              nested_options: {
                type: "array",
                description: "Selected customization option objects {id, name, quantity, options?}",
                items: { type: "object" },
              },
            },
            required: ["item_id", "item_name", "quantity"],
          },
        },
        cart_uuid: str("Existing cart to append to (omit to create/append to store's open cart)"),
        fulfillment: { type: "string", enum: ["delivery", "pickup"], description: "Mode for a NEW cart (default delivery)" },
      },
      required: ["store_id", "menu_id", "items"],
    },
  },
  {
    name: "show_cart",
    description:
      "Show cart contents (no pricing — use preview_order for that). items[].id is the cart-LINE id used by remove_cart_item; items[].item_id is the menu item id. Don't swap them.",
    input_schema: {
      type: "object",
      properties: { cart_uuid: str("Cart UUID") },
      required: ["cart_uuid"],
    },
  },
  {
    name: "remove_cart_item",
    description: "Remove one line item from a cart. cart_item_id = items[].id from show_cart (NOT the menu item_id).",
    input_schema: {
      type: "object",
      properties: {
        cart_uuid: str("Cart UUID"),
        cart_item_id: str("Cart-line id from show_cart items[].id"),
      },
      required: ["cart_uuid", "cart_item_id"],
    },
  },
  {
    name: "delete_cart",
    description:
      "Empty a cart and abandon it (cart_uuid becomes invalid). Only on user request/consent — e.g. replacing a stale cart at the same store.",
    input_schema: {
      type: "object",
      properties: { cart_uuid: str("Cart UUID to abandon") },
      required: ["cart_uuid"],
    },
  },
  {
    name: "preview_order",
    description:
      "Authoritative pricing + logistics for a cart (read-only, no charge): display_summary (show VERBATIM to the user), quote {net_total_before_tip = the real total, line_items fee breakdown, tips_suggestion (cents), delivery_availability ETAs, credits, PIN requirement, work budgets}, and the default card (brand+last4). Re-run after ANY cart change. Pass include_work_benefits when the user mentions work/office/company/team/expense or delivers to a Work address. Budget checks: compare the user's cap against net_total_before_tip (tip adds on top).",
    input_schema: {
      type: "object",
      properties: {
        cart_uuid: str("Cart UUID"),
        scheduled_time: str("ISO 8601 UTC (e.g. 2026-07-19T23:00:00Z) for scheduled delivery; omit for ASAP"),
        include_work_benefits: bool("Set on ANY work/company/team/expense signal"),
        selected_budget_id: str("Apply a specific work budget id from a prior preview"),
        fulfillment: {
          type: "string",
          enum: ["delivery", "pickup"],
          description: "MUTATES the cart's mode before pricing — only pass when the user explicitly asked to switch",
        },
      },
      required: ["cart_uuid"],
    },
  },
  {
    name: "submit_order",
    description:
      "Place the order — charges the user's real payment method. HARD GATE: the terminal asks the user to type 'yes'; a decline returns declined_by_user. Call ONLY after: (1) preview shown, (2) tip explicitly confirmed (delivery; pickup = 0 without asking), (3) payment method named to the user, (4) the user clearly said to place it. NOT idempotent — never retry without checking get_order_status first. Report success only when final_status.status == 'successful'.",
    input_schema: {
      type: "object",
      properties: {
        cart_uuid: str("Cart UUID"),
        tip_cents: int("Dasher tip in CENTS (500 = $5.00). 0 only on explicit decline or pickup."),
        confirmation_summary: str(
          "Short human-readable summary shown at the terminal gate: store, items, total, tip, card (brand+last4), ETA",
        ),
        scheduled_time: str("Must match the value used in preview, if any"),
        fulfillment: { type: "string", enum: ["delivery", "pickup"], description: "Only to match a mode explicitly set at preview" },
        team_id: str("Work benefits: quote.team_id from preview"),
        budget_id: str("Work benefits: chosen budget id"),
        team_account_id: str("Work benefits: budget's team_account_id when present"),
        expense_code: str("Required when budget expense_code_mode != NONE"),
        expense_notes: str("Required when budget is_expense_note_required"),
      },
      required: ["cart_uuid", "tip_cents", "confirmation_summary"],
    },
  },
  {
    name: "get_checkout_url",
    description:
      "Browser checkout URL for a cart — FALLBACK ONLY, for edits the CLI can't make: swap payment method, opt out of credits, change address mid-checkout, enter a promo code, or finish an age-restricted order. Do not offer by default after previews.",
    input_schema: {
      type: "object",
      properties: { cart_uuid: str("Cart UUID") },
      required: ["cart_uuid"],
    },
  },
  {
    name: "get_order_history",
    description:
      "Past orders (default 50 orders / 90 days, max 100 / 365): store, items, total, order_uuid, is_reorderable, fulfillment_type. Use to analyze habits ('my usual'), find reorder targets, or locate a specific past order (scan all results; if page_full, re-query higher/wider).",
    input_schema: {
      type: "object",
      properties: {
        max: int("Max orders 1-100 (default 50)"),
        days: int("Window in days, up to 365 (default 90)"),
      },
      required: [],
    },
  },
  {
    name: "reorder",
    description:
      "Create a NEW cart from a past order. Check list_carts for the store first (one open cart per store). Afterwards ALWAYS preview_order and diff items vs the original — out-of-stock items drop silently; call out any drops before asking about submitting.",
    input_schema: {
      type: "object",
      properties: { order_uuid: str("From get_order_history orders[].order_uuid") },
      required: ["order_uuid"],
    },
  },
  {
    name: "get_order_status",
    description:
      "Check whether a submitted order went through: successful | pending (check again) | action_required (user must verify in app) | failed | not_found.",
    input_schema: {
      type: "object",
      properties: { order_uuid: str("From submit response or order history") },
      required: ["order_uuid"],
    },
  },
  {
    name: "get_receipt",
    description: "Itemized receipt for one past order (subtotal, fees, tax, tip, total, card last4). Sensitive — show only to the user.",
    input_schema: {
      type: "object",
      properties: { order_uuid: str("Order UUID") },
      required: ["order_uuid"],
    },
  },
  {
    name: "list_payment_methods",
    description:
      "Saved cards + which is default. Cards ONLY — wallets/gift cards are invisible here; never conclude 'no payment method' from an empty list (offer checkout-url instead).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_promos",
    description:
      "Campaign promos eligible at a store for this user (may be empty — that's normal). To apply one to a cart use apply_promo with all four ids; preview_order shows what's actually discounting a cart.",
    input_schema: {
      type: "object",
      properties: { store_id: str("Store ID") },
      required: ["store_id"],
    },
  },
  {
    name: "apply_promo",
    description:
      "Apply a promo to a cart. Campaign promos from list_promos need promo_code + campaign_id + ad_group_id + ad_id; user-typed codes need only promo_code. On failure: check subtotal vs the promo's stated minimum. Re-preview after.",
    input_schema: {
      type: "object",
      properties: {
        cart_uuid: str("Cart UUID"),
        promo_code: str("Code string"),
        campaign_id: str("Campaign promos only"),
        ad_group_id: str("Campaign promos only"),
        ad_id: str("Campaign promos only"),
      },
      required: ["cart_uuid", "promo_code"],
    },
  },
  {
    name: "remove_promo",
    description: "Remove an applied promo (pass the same ids used at apply). Re-preview after.",
    input_schema: {
      type: "object",
      properties: {
        cart_uuid: str("Cart UUID"),
        promo_code: str("Code to remove"),
        campaign_id: str("If used at apply"),
        ad_group_id: str("If used at apply"),
        ad_id: str("If used at apply"),
      },
      required: ["cart_uuid", "promo_code"],
    },
  },
  {
    name: "find_stores",
    description:
      "Discover NON-restaurant stores near the default address (16-mile radius): grocery (default), alcohol, convenience, pets, retail, or nv (all non-restaurant). distance_meters is meters — divide by 1609 for miles. Restaurant queries belong in search_restaurants.",
    input_schema: {
      type: "object",
      properties: {
        vertical: {
          type: "string",
          enum: ["grocery", "alcohol", "convenience", "pets", "retail", "nv"],
          description: "Merchant type (default grocery)",
        },
        max: int("Max stores (default 10)"),
        lat: num("Optional latitude override (pass with lng)"),
        lng: num("Optional longitude override (pass with lat)"),
      },
      required: [],
    },
  },
  {
    name: "find_items",
    description:
      "Search items inside ONE retail/grocery store by name — returns item_ids for cart adds, keyed per query. Empty for restaurants (use get_menu there).",
    input_schema: {
      type: "object",
      properties: {
        store_id: str("Retail/grocery store ID"),
        queries: {
          type: "array",
          items: { type: "string" },
          description: "One or more item names, e.g. ['milk','eggs']",
        },
      },
      required: ["store_id", "queries"],
    },
  },
  {
    name: "get_grocery_item_details",
    description:
      "Details for a retail/grocery item (pricing, options) + menu_id fallback source for grocery cart adds. Restaurants: use get_restaurant_item_details.",
    input_schema: {
      type: "object",
      properties: {
        store_id: str("Store ID"),
        item_id: str("Item ID from find_items or build_grocery_list"),
      },
      required: ["store_id", "item_id"],
    },
  },
  {
    name: "build_grocery_list",
    description:
      "Resolve a grocery/pantry list to real products at one store (raw ingredients only — NOT restaurant food). STATELESS: every call REPLACES the list, so always send the complete list. Weight items take decimal quantity (0.5 = half lb) only when purchase_type is MEASUREMENT; eggs are per dozen. Verify resolved items[].name with the user before carting. Vague asks: cap at 20 items and show your picks.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: '[{"name":"milk"},{"name":"ground beef","quantity":0.5}]',
          items: {
            type: "object",
            properties: { name: str("Item name"), quantity: num("Count, or weight for measurement items (default 1)") },
            required: ["name"],
          },
        },
        store_id: str("Pin to a store (takes precedence over desired_mx_name)"),
        desired_mx_name: str("Preferred merchant name, e.g. 'Whole Foods'"),
        servings: int("Only when the user says 'for N people' — display-only"),
      },
      required: ["items"],
    },
  },
  {
    name: "save_preference",
    description:
      "Persist a durable user preference across sessions (dietary rule, allergy, budget habit, tip default). Save when the user states one ('no mushrooms ever', 'I usually tip 20%'). Keep each note short and self-contained.",
    input_schema: {
      type: "object",
      properties: { note: str("The preference, e.g. 'Avoid mushrooms in all dishes'") },
      required: ["note"],
    },
  },
  {
    name: "remove_preference",
    description: "Delete a saved preference note (exact text match).",
    input_schema: {
      type: "object",
      properties: { note: str("Exact note text to remove") },
      required: ["note"],
    },
  },
];

export function preferencesForPrompt(): string {
  const notes = listPreferences();
  return notes.length ? notes.map((n) => `- ${n}`).join("\n") : "(none saved yet)";
}
