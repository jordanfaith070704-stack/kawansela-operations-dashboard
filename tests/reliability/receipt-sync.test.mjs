import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Run on Node 24 with:
// node --test tests/reliability/receipt-sync.test.mjs
// The actual importer executes against a network-free Supabase double. These
// tests cover its validation and retry contract, not PostgreSQL locks or RLS.
let source = readFileSync(new URL("../../lib/loyverse/sync.ts", import.meta.url), "utf8");
source = source.replace('import "server-only";', "");
source = source.replace(
  'import { createAdminClient } from "@/lib/supabase/admin";',
  "const createAdminClient = () => globalThis.__receiptSyncTestDatabase;",
);
const javascript = stripTypeScriptTypes(source, { mode: "strip" });
const { processLoyverseReceipts } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

class Query {
  constructor(database, table) {
    this.database = database;
    this.table = table;
    this.operation = "select";
    this.filters = [];
  }
  select() { return this; }
  eq(key, value) { this.filters.push([key, value]); return this; }
  insert(value) { this.operation = "insert"; this.value = value; return this; }
  update(value) { this.operation = "update"; this.value = value; return this; }
  maybeSingle() { return this.execute(true); }
  single() { return this.execute(true); }
  then(resolve, reject) { return this.execute(false).then(resolve, reject); }
  async execute(single) {
    const table = this.database.tables[this.table] ??= [];
    let rows;
    if (this.operation === "insert") {
      const row = {
        id: `${this.table}-${this.database.nextId++}`,
        processed_at: null,
        ...structuredClone(this.value),
      };
      table.push(row);
      rows = [row];
    } else {
      rows = table.filter(row => this.filters.every(([key, value]) => row[key] === value));
      if (this.operation === "update") {
        if (this.table === "pos_receipt_events" && this.value.processed_at && this.database.failEventFinishOnce) {
          this.database.failEventFinishOnce = false;
          return { data: null, error: { message: "simulated failed event-finalization write" } };
        }
        rows.forEach(row => Object.assign(row, structuredClone(this.value)));
      }
    }
    return { data: single ? rows[0] ?? null : structuredClone(rows), error: null };
  }
}

const initialWatermark = "2026-11-25T00:00:00Z";
function database() {
  const db = {
    nextId: 1,
    rpcCalls: [],
    sales: new Map(),
    tables: {
      pos_connections: [{
        id: "connection-1", location_id: "cart-1", external_store_id: "store-1",
        provider: "loyverse", is_active: true, last_processed_receipt_at: initialWatermark,
      }],
      pos_product_mappings: [{
        pos_connection_id: "connection-1", external_item_id: "coffee",
        recipe_id: "recipe-coffee", is_active: true,
      }],
    },
    from(table) { return new Query(this, table); },
    async rpc(name, args) {
      assert.equal(name, "record_pos_sale");
      this.rpcCalls.push(structuredClone(args));
      // Models the RPC's documented idempotent return. Database execution is
      // deliberately out of scope; assert that retries send the same key.
      if (!this.sales.has(args.p_external_id)) {
        this.sales.set(args.p_external_id, { id: `sale-${this.sales.size + 1}`, ...args });
      }
      return { data: this.sales.get(args.p_external_id).id, error: null };
    },
  };
  globalThis.__receiptSyncTestDatabase = db;
  return db;
}
function receipt(overrides = {}) {
  return {
    receipt_number: "receipt-1", store_id: "store-1",
    created_at: "2026-11-26T02:00:00Z", receipt_date: "2026-11-26T01:00:00Z",
    payments: [{ name: "Cash", amount: 12000 }],
    line_items: [{ id: "line-1", item_id: "coffee", quantity: 1, total_money: 12000 }],
    ...overrides,
  };
}

test("an empty receipt stays pending, does not advance the watermark, and can be retried after correction", async () => {
  const db = database();
  const incomplete = await processLoyverseReceipts("connection-1", [receipt({ line_items: [] })]);
  assert.equal(incomplete.pending, 1);
  assert.equal(incomplete.processed, 0);
  assert.equal(db.rpcCalls.length, 0);
  assert.equal(db.tables.pos_connections[0].last_processed_receipt_at, initialWatermark);
  assert.ok(incomplete.warnings.some(message => message.includes("data receipt tidak lengkap")));

  const corrected = await processLoyverseReceipts("connection-1", [receipt()]);
  assert.equal(corrected.processed, 1);
  assert.equal(db.rpcCalls.length, 1);
});

test("a missing total stays pending rather than importing a free sale", async () => {
  const db = database();
  const r = receipt();
  delete r.line_items[0].total_money;
  const result = await processLoyverseReceipts("connection-1", [r]);
  assert.equal(result.pending, 1);
  assert.equal(result.processed, 0);
  assert.equal(db.rpcCalls.length, 0);
  assert.equal(db.tables.pos_connections[0].last_processed_receipt_at, initialWatermark);
  assert.equal(db.tables.pos_receipt_events[0].processed_at, null);
  assert.match(db.tables.pos_receipt_events[0].processing_error, /total harga yang valid/);
});

test("an explicit zero total remains valid for a complimentary drink", async () => {
  const db = database();
  const r = receipt({ payments: [{ name: "Cash", amount: 0 }] });
  r.line_items[0].total_money = 0;
  const result = await processLoyverseReceipts("connection-1", [r]);
  assert.equal(result.processed, 1);
  assert.equal(result.pending, 0);
  assert.equal(db.rpcCalls[0].p_total, 0);
  assert.equal(db.rpcCalls[0].p_quantity, 1);
});

for (const [label, total] of [
  ["null", null], ["NaN", NaN], ["Infinity", Infinity],
  ["negative", -1], ["numeric string", "12000"],
]) {
  test(`${label} total stays pending without a sales RPC call`, async () => {
    const db = database();
    const r = receipt();
    r.line_items[0].total_money = total;
    const result = await processLoyverseReceipts("connection-1", [r]);
    assert.equal(result.pending, 1);
    assert.equal(result.processed, 0);
    assert.equal(db.rpcCalls.length, 0);
    assert.equal(db.tables.pos_connections[0].last_processed_receipt_at, initialWatermark);
  });
}

test("a partial receipt keeps valid lines and retries corrected money with stable line keys", async () => {
  const db = database();
  const r = receipt();
  r.line_items.push({ id: "line-2", item_id: "coffee", quantity: 1 });
  const incomplete = await processLoyverseReceipts("connection-1", [r]);
  assert.equal(incomplete.pending, 1);
  assert.equal(db.rpcCalls.length, 1);
  assert.equal(db.tables.pos_connections[0].last_processed_receipt_at, initialWatermark);

  r.line_items[1].total_money = 10000;
  const corrected = await processLoyverseReceipts("connection-1", [r]);
  assert.equal(corrected.processed, 1);
  assert.equal(corrected.pending, 0);
  assert.equal(db.rpcCalls.length, 3);
  assert.equal(db.rpcCalls[0].p_external_id, db.rpcCalls[1].p_external_id);
  assert.notEqual(db.rpcCalls[1].p_external_id, db.rpcCalls[2].p_external_id);
  assert.equal(db.rpcCalls[2].p_total, 10000);
  assert.equal(db.sales.size, 2);
});

test("unmapped valid-price lines remain retryable after a mapping is added", async () => {
  const db = database();
  const r = receipt(); r.line_items[0].item_id = "tea";
  assert.equal((await processLoyverseReceipts("connection-1", [r])).pending, 1);
  assert.equal(db.rpcCalls.length, 0);
  db.tables.pos_product_mappings.push({
    pos_connection_id: "connection-1", external_item_id: "tea",
    recipe_id: "recipe-tea", is_active: true,
  });
  assert.equal((await processLoyverseReceipts("connection-1", [r])).processed, 1);
  assert.equal(db.rpcCalls[0].p_recipe_id, "recipe-tea");
});

test("a finished receipt is skipped on retry", async () => {
  const db = database();
  await processLoyverseReceipts("connection-1", [receipt()]);
  const retry = await processLoyverseReceipts("connection-1", [receipt()]);
  assert.equal(retry.duplicated, 1);
  assert.equal(db.rpcCalls.length, 1);
});

test("a failed receipt-finalization write retries the same sale key", async () => {
  const db = database(); db.failEventFinishOnce = true;
  await assert.rejects(() => processLoyverseReceipts("connection-1", [receipt()]));
  assert.equal((await processLoyverseReceipts("connection-1", [receipt()])).processed, 1);
  assert.equal(db.rpcCalls[0].p_external_id, db.rpcCalls[1].p_external_id);
  assert.equal(db.sales.size, 1);
});

test("store mismatch and refunds still do not import a sale", async () => {
  const db = database();
  assert.equal((await processLoyverseReceipts("connection-1", [receipt({ store_id: "other-store" })])).pending, 1);
  assert.equal((await processLoyverseReceipts("connection-1", [receipt({ receipt_type: "REFUND" })])).pending, 1);
  assert.equal(db.rpcCalls.length, 0);
});
