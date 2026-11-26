import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Run the real component's handlers with isolated state/ref hooks. Only its JSX
// return is replaced; validation, RPC payloads, retries and response checks remain intact.
const filename = new URL("../../app/operator-cash-day.tsx", import.meta.url);
const source = ts.createSourceFile(filename.pathname, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "OperatorCashDay");
assert.ok(component?.body, "OperatorCashDay must have a function body");
const stateNames = component.body.statements.flatMap((statement) => ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap((declaration) => ts.isArrayBindingPattern(declaration.name) && ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(source) === "useState" ? [declaration.name.elements[0].getText(source)] : []) : []);
const handlerReturn = ts.factory.createReturnStatement(ts.factory.createObjectLiteralExpression(["save", "refresh", "chooseForm"].map((name) => ts.factory.createShorthandPropertyAssignment(name))));
const replacement = ts.factory.updateFunctionDeclaration(component, component.modifiers, component.asteriskToken, component.name, component.typeParameters, component.parameters, component.type, ts.factory.updateBlock(component.body, component.body.statements.map((node) => ts.isReturnStatement(node) ? handlerReturn : node)));
const isolated = ts.factory.updateSourceFile(source, source.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node === component ? replacement : node));
const compiled = ts.transpileModule(ts.createPrinter().printFile(isolated), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const load = new Function("deps", "exports", `${"const {useState,useRef,useEffect,useCallback,useId,createClient,window,crypto}=deps;"}\n${compiled}\nexports.readDay=readDay;`);

const locationId = "11111111-1111-4111-8111-111111111111";
function day(overrides = {}) { return { business_date: "2026-11-26", timezone: "Asia/Jakarta", day_id: "day-1", opening_cash: 100000, opened_at: "2026-11-26T01:00:00Z", is_open: true, is_closed: false, income_total: 0, expense_total: 0, movements: [], ...overrides }; }
function savedMovement(payload) { return day({ expense_total: payload.p_amount, movements: [{ id: "movement-1", kind: payload.p_kind, amount: payload.p_amount, reason: payload.p_reason, occurred_at: "2026-11-26T02:00:00Z", request_id: payload.p_request_id }] }); }
const submit = { preventDefault() {} };
function harness(handler = () => ({ data: day(), error: null })) {
  const states = [], refs = [], calls = [];
  let stateCursor = 0, refCursor = 0, uuids = 0, commits = 0;
  const api = {};
  load({
    useState(initial) { const index = stateCursor++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial; return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
    useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial }; },
    useEffect() {}, useCallback(callback) { return callback; }, useId() { return "cash-test"; },
    window: { setTimeout() { return 1; }, clearTimeout() {} },
    crypto: { randomUUID() { return `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`; } },
    createClient() { return { rpc(name, payload) { calls.push({ name, payload: structuredClone(payload) }); return { async abortSignal() { return handler(name, payload, calls.length); } }; } }; },
  }, api);
  function render() { stateCursor = 0; refCursor = 0; return api.OperatorCashDay({ locationId, onCommitted() { commits++; } }); }
  function set(values) { for (const [name, value] of Object.entries(values)) { const index = stateNames.indexOf(name); assert.notEqual(index, -1, `Unknown component state ${name}`); states[index] = value; } return render(); }
  render();
  set({ day: day(), loading: false, formKind: "expense", amount: "5000", reason: "Beli es batu" });
  return { calls, render, set, readDay: api.readDay, get(name) { return states[stateNames.indexOf(name)]; }, get commits() { return commits; } };
}

test("cash state accepts saved zero opening and rejects malformed financial or timezone data", () => {
  const h = harness();
  assert.equal(h.readDay(day({ opening_cash: "0", income_total: "0", expense_total: "0" })).opening_cash, 0);
  for (const invalid of [null, [], day({ opening_cash: null }), day({ income_total: "not money" }), day({ timezone: "not/a_timezone" }), day({ movements: [{ id: "bad", kind: "expense", amount: -1 }] })]) assert.throws(() => h.readDay(invalid));
});

test("opening requires explicit input and saved zero is confirmed without a second opening write", async () => {
  const h = harness((_name, payload) => ({ data: day({ opening_cash: payload.p_opening_cash }), error: null }));
  let handlers = h.set({ day: day({ day_id: null, opening_cash: null, is_open: false, opened_at: null }), formKind: null, amount: "" });
  await handlers.save(submit);
  assert.equal(h.calls.length, 0);
  handlers = h.set({ amount: "0" }); await handlers.save(submit);
  assert.equal(h.calls[0].name, "begin_operator_day");
  assert.equal(h.calls[0].payload.p_opening_cash, 0);
  assert.equal(h.get("day").opening_cash, 0);
  assert.equal(h.commits, 1);
  await h.render().save(submit);
  assert.equal(h.calls.length, 1, "saved opening must not be implicitly sent again");
});

test("invalid or overflowing cash amounts and missing reasons never reach the RPC", async () => {
  const h = harness();
  for (const amount of ["", " ", "0", "-1", "1.5", "1000000000000", "9007199254740992", "not money"]) {
    await h.set({ amount }).save(submit);
    assert.equal(h.calls.length, 0, `must reject ${JSON.stringify(amount)}`);
    assert.ok(h.get("formError"));
  }
  await h.set({ amount: "5000", reason: "   " }).save(submit);
  assert.equal(h.calls.length, 0);
  assert.match(h.get("formError"), /keperluan/);
});

test("closed, unavailable, loading or failed-read state blocks cash writes", async () => {
  for (const guard of [{ day: day({ is_closed: true, is_open: false }) }, { unavailable: true }, { readError: "Data kas belum dapat dimuat" }, { loading: true }, { day: null }]) {
    const h = harness(); await h.set(guard).save(submit);
    assert.equal(h.calls.length, 0);
    assert.equal(h.commits, 0);
  }
});

test("uncertain network result retains identical UUID and payload through retry", async () => {
  const h = harness((_name, payload, attempt) => { if (attempt === 1) throw new TypeError("network lost"); return { data: savedMovement(payload), error: null }; });
  await h.render().save(submit);
  assert.equal(h.get("retryLocked"), true);
  assert.equal(h.get("pending"), false);
  assert.equal(h.commits, 0);
  assert.equal(h.get("status"), "");
  await h.render().save(submit);
  assert.deepEqual(h.calls[0], h.calls[1], "retry must not create another payment identity");
  assert.equal(h.get("retryLocked"), false);
  assert.equal(h.commits, 1);
  assert.equal(h.get("amount"), "");
  assert.match(h.get("status"), /tersimpan/);
});

test("confirmed PostgreSQL validation rejection unlocks editing and uses a new ID after correction", async () => {
  for (const code of ["P0001", "22003"]) {
    const h = harness((_name, payload, attempt) => attempt === 1 ? { data: null, error: { code, message: "invalid amount PROVIDER_DETAIL" } } : { data: savedMovement(payload), error: null });
    await h.render().save(submit);
    assert.equal(h.get("retryLocked"), false);
    assert.equal(h.get("pending"), false);
    assert.equal(h.commits, 0);
    assert.doesNotMatch(h.get("formError"), /PROVIDER_DETAIL/);
    await h.set({ amount: "6000" }).save(submit);
    assert.notEqual(h.calls[0].payload.p_request_id, h.calls[1].payload.p_request_id);
    assert.equal(h.calls[1].payload.p_amount, 6000);
    assert.equal(h.commits, 1);
  }
});

test("a successful HTTP response without the saved request UUID is never claimed as a confirmed save", async () => {
  const h = harness(() => ({ data: day(), error: null }));
  await h.render().save(submit);
  assert.equal(h.commits, 0);
  assert.equal(h.get("status"), "");
  assert.equal(h.get("retryLocked"), true);
  assert.match(h.get("formError"), /belum terkonfirmasi/);
  await h.render().save(submit);
  assert.equal(h.calls[0].payload.p_request_id, h.calls[1].payload.p_request_id);
});

test("missing cash RPC is unavailable rather than fabricated success or an empty working ledger", async () => {
  const h = harness(() => ({ data: null, error: { code: "PGRST202", message: "provider internal function detail" } }));
  await h.render().refresh();
  assert.equal(h.calls[0].name, "get_operator_cash_day");
  assert.equal(h.get("unavailable"), true);
  assert.match(h.get("readError"), /belum tersedia/);
  assert.doesNotMatch(h.get("readError"), /provider internal/);
  await h.render().save(submit);
  assert.equal(h.calls.length, 1);
  assert.equal(h.commits, 0);
  assert.equal(h.get("status"), "");
});
