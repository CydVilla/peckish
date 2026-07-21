/**
 * Unit tests for the pure logic layers — run with `npm test`.
 * No network, no dd-cli, no API key required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripUiFields, isTransient, DdCliError } from "../src/ddcli.js";
import { tools, strictifySchema, trimMenuItem } from "../src/tools.js";
import { addUsage, EMPTY_USAGE, estimateCostUsd, formatCost } from "../src/costs.js";

// ---------------------------------------------------------------------------
// ddcli: envelope sanitization
// ---------------------------------------------------------------------------

test("stripUiFields removes widget/assistant-instruction keys recursively", () => {
  const dirty = {
    widget_type: "store_search",
    assistant_instructions: "Tell the user to click the widget above",
    stores: [
      { name: "A", widget_type: "card", nested: { assistant_instructions: "obey", ok: 1 } },
    ],
    success: true,
  };
  const clean = stripUiFields(dirty) as Record<string, any>;
  assert.equal(clean.widget_type, undefined);
  assert.equal(clean.assistant_instructions, undefined);
  assert.equal(clean.stores[0].widget_type, undefined);
  assert.equal(clean.stores[0].nested.assistant_instructions, undefined);
  assert.equal(clean.stores[0].nested.ok, 1);
  assert.equal(clean.success, true);
});

test("stripUiFields leaves primitives and arrays intact", () => {
  assert.deepEqual(stripUiFields([1, "a", null]), [1, "a", null]);
  assert.equal(stripUiFields("text"), "text");
});

// ---------------------------------------------------------------------------
// ddcli: transient error classification (drives the read-only retry)
// ---------------------------------------------------------------------------

test("isTransient matches the observed session_id backend hiccup", () => {
  assert.equal(
    isTransient(
      new DdCliError("dd-cli exited with an error", "Error: Input validation error: 'session_id' is a required property"),
    ),
    true,
  );
});

test("isTransient never retries auth or missing-binary errors", () => {
  assert.equal(
    isTransient(new DdCliError("DoorDash sign-in is missing or expired. The user must run `dd-cli login`…")),
    false,
  );
  assert.equal(isTransient(new DdCliError("dd-cli binary not found (looked for: x)")), false);
  assert.equal(isTransient(new Error("random")), false);
});

test("isTransient matches timeouts and 5xx", () => {
  assert.equal(isTransient(new DdCliError("dd-cli timed out after 90s")), true);
  assert.equal(isTransient(new DdCliError("dd-cli exited with an error", "HTTP 503 upstream")), true);
});

// ---------------------------------------------------------------------------
// tools: strict schemas
// ---------------------------------------------------------------------------

function assertStrictObjects(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertStrictObjects(v, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.type === "object") {
      assert.equal(obj.additionalProperties, false, `${path}: additionalProperties must be false`);
      assert.ok(Array.isArray(obj.required), `${path}: required[] must exist`);
      assert.ok(obj.properties && typeof obj.properties === "object", `${path}: properties must exist`);
    }
    for (const [k, v] of Object.entries(obj)) assertStrictObjects(v, `${path}.${k}`);
  }
}

test("every tool is strict with a fully-compliant schema tree", () => {
  assert.ok(tools.length >= 28, `expected ≥28 tools, got ${tools.length}`);
  for (const t of tools) {
    assert.equal((t as { strict?: boolean }).strict, true, `${t.name} must set strict`);
    assertStrictObjects(t.input_schema, t.name);
  }
});

test("strictifySchema does not mutate its input", () => {
  const input = { type: "object", properties: { a: { type: "string" } } };
  const before = JSON.stringify(input);
  strictifySchema(input);
  assert.equal(JSON.stringify(input), before);
});

test("required fields survive strictification", () => {
  const addItems = tools.find((t) => t.name === "add_items_to_cart")!;
  const schema = addItems.input_schema as any;
  assert.deepEqual(schema.required, ["store_id", "menu_id", "items"]);
  const itemSchema = schema.properties.items.items;
  assert.deepEqual(itemSchema.required, ["item_id", "item_name", "quantity"]);
  assert.equal(itemSchema.additionalProperties, false);
  // nested_options is explicitly two-level (no freeform objects allowed under strict)
  const optSchema = itemSchema.properties.nested_options.items;
  assert.equal(optSchema.additionalProperties, false);
  assert.equal(optSchema.properties.options.items.additionalProperties, false);
});

// ---------------------------------------------------------------------------
// tools: menu trimming
// ---------------------------------------------------------------------------

test("trimMenuItem keeps ordering signal, drops noise, truncates descriptions", () => {
  const item = trimMenuItem({
    item_id: "i_123",
    name: "Bulgogi Bowl",
    description: "x".repeat(500),
    price: 16.95,
    price_varies: false,
    category_name: "Bowls",
    has_required_modifiers: true,
    is_orderable: true,
  });
  assert.equal(item.item_id, "i_123");
  assert.equal((item as any).has_required_modifiers, true);
  assert.ok((item.description as string).length <= 161);
  assert.equal((item as any).is_orderable, undefined, "orderable items carry no flag");
  assert.equal((item as any).price_varies, undefined, "false price_varies is dropped");
});

test("trimMenuItem surfaces unavailability", () => {
  const item = trimMenuItem({ item_id: "i_1", name: "X", is_orderable: false, unavailability_reason: "store_closed" });
  assert.equal((item as any).is_orderable, false);
  assert.equal((item as any).unavailability_reason, "store_closed");
});

// ---------------------------------------------------------------------------
// costs
// ---------------------------------------------------------------------------

test("addUsage tolerates null fields from the API", () => {
  const total = addUsage(EMPTY_USAGE, {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  });
  assert.equal(total.input_tokens, 100);
  assert.equal(total.cache_read_input_tokens, 0);
});

test("estimateCostUsd prices sonnet-5 correctly incl. cache rates", () => {
  const usd = estimateCostUsd("claude-sonnet-5", {
    input_tokens: 1_000_000,       // $3
    output_tokens: 1_000_000,      // $15
    cache_read_input_tokens: 1_000_000,     // $0.30
    cache_creation_input_tokens: 1_000_000, // $3.75
  });
  assert.ok(Math.abs(usd - 22.05) < 0.001, `got ${usd}`);
});

test("formatCost floors tiny amounts", () => {
  assert.equal(formatCost(0.001), "<$0.01");
  assert.equal(formatCost(0.12), "~$0.12");
});
