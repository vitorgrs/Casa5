import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestReconciliation } from "../src/lib/wallet-reconciliation.ts";

const members = [
  { id: "vitor", name: "Vitor Gabriel", email: "vitor@exemplo.com", payer_identifiers: [] },
  { id: "belo", name: "Gabriel Belo", email: "belo@exemplo.com", payer_identifiers: ["123.456.789-09"] },
  { id: "patrick", name: "Patrick Camara", email: null, payer_identifiers: [] },
];
const shares = [
  { id: "belo-aluguel", member_id: "belo", amount: 1183.11 },
  { id: "belo-luz", member_id: "belo", amount: 80.5 },
  { id: "patrick-aluguel", member_id: "patrick", amount: 1183.11 },
  { id: "vitor-luz", member_id: "vitor", amount: 80.5 },
];
const movement = (overrides: Partial<Parameters<typeof suggestReconciliation>[0]>) => ({
  available: 0,
  payer_name: null,
  payer_email: null,
  payer_document: null,
  ...overrides,
});

test("CPF cadastrado identifica o morador e a parcela de valor exato", () => {
  const result = suggestReconciliation(
    movement({ available: 80.5, payer_document: "12345678909" }),
    members,
    shares,
  );
  assert.equal(result.memberId, "belo");
  assert.equal(result.reason, "identifier");
  assert.deepEqual(result.suggestedShareIds, ["belo-luz"]);
  // Parcelas do morador identificado vêm antes das dos outros.
  assert.deepEqual(result.candidateShareIds, ["belo-luz", "vitor-luz"]);
});

test("Pix que cobre todas as parcelas do morador sugere todas", () => {
  const result = suggestReconciliation(
    movement({ available: 1263.61, payer_email: "BELO@exemplo.com" }),
    members,
    shares,
  );
  assert.deepEqual(result.suggestedShareIds.sort(), ["belo-aluguel", "belo-luz"]);
});

test("nome parcial ambíguo não identifica ninguém", () => {
  const result = suggestReconciliation(
    movement({ available: 80.5, payer_name: "Gabriel" }),
    members,
    shares,
  );
  assert.equal(result.memberId, null);
  // Duas parcelas de 80,50: valor sozinho também é ambíguo.
  assert.deepEqual(result.suggestedShareIds, []);
});

test("nome completo com acentos identifica o morador", () => {
  const result = suggestReconciliation(
    movement({ available: 1183.11, payer_name: "PATRICK CÂMARA DA SILVA" }),
    members,
    shares,
  );
  assert.equal(result.memberId, "patrick");
  assert.deepEqual(result.suggestedShareIds, ["patrick-aluguel"]);
});

test("sem identificação, valor único sugere a parcela", () => {
  const result = suggestReconciliation(
    movement({ available: 1183.11 }),
    members,
    shares.filter((share) => share.id !== "patrick-aluguel"),
  );
  assert.equal(result.reason, "amount");
  assert.deepEqual(result.suggestedShareIds, ["belo-aluguel"]);
});

test("parcelas maiores que o Pix não aparecem como candidatas", () => {
  const result = suggestReconciliation(movement({ available: 100 }), members, shares);
  assert.deepEqual(result.candidateShareIds.sort(), ["belo-luz", "vitor-luz"]);
});
