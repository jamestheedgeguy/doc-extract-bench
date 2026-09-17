/**
 * Packet Intake adapter — fromRaw mapping + availability skip.
 * No network, no Python required for these tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PACKET_INTAKE_UNIT_PRICE_USD,
  costFromRaw,
  packetintake,
} from "./packetintake.js";
import type { CanonicalInvoice } from "../schemas/invoice.js";
import type { CanonicalReceipt } from "../schemas/receipt.js";
import type { CanonicalTable } from "../schemas/table.js";

/** Synthetic ExtractionResult as `python -m packet_intake.extract --json` dumps it
 *  (Pydantic model_dump(mode="json") — Decimals as strings, {value, confidence} wrappers). */
const FIXTURE = {
  header: {
    invoice_number: { value: "INV-1001", confidence: 0.95 },
    invoice_date: { value: "2026-04-14", confidence: 0.9 },
    due_date: { value: "2026-05-14", confidence: 0.88 },
    vendor_name: { value: "Acme Supplies", confidence: 0.97 },
    vendor_address: { value: "12 Orchard Rd, Singapore", confidence: 0.8 },
    vendor_tax_id: { value: "GST-123", confidence: 0.5 },
    customer_name: { value: "Northwind", confidence: 0.9 },
    po_number: { value: "PO-9", confidence: 0.7 },
    currency: { value: "USD", confidence: 0.99 },
    payment_terms: { value: "Net 30", confidence: 0.6 },
    iban: { value: null, confidence: null },
  },
  line_items: [
    {
      description: { value: "Widget A", confidence: 0.9 },
      sku: { value: "W-A", confidence: 0.7 },
      quantity: { value: "2", confidence: 0.9 },
      unit_price: { value: "3.50", confidence: 0.9 },
      amount: { value: "7.00", confidence: 0.9 },
      currency: { value: "USD", confidence: 0.9 },
    },
    {
      description: { value: "Gadget B", confidence: 0.8 },
      sku: { value: null, confidence: null },
      quantity: { value: "1", confidence: 0.8 },
      unit_price: { value: "15.25", confidence: 0.8 },
      amount: { value: "15.25", confidence: 0.8 },
      currency: { value: "USD", confidence: 0.8 },
    },
  ],
  totals: {
    subtotal: { value: "22.25", confidence: 0.9 },
    tax: { value: "1.78", confidence: 0.85 },
    freight: { value: "0.00", confidence: 0.5 },
    discount: { value: null, confidence: null },
    total: { value: "24.03", confidence: 0.95 },
  },
  table_html: {
    value:
      "<table><thead><tr><th>description</th><th>qty</th><th>unit_price</th><th>amount</th></tr></thead><tbody><tr><td>Widget A</td><td>2</td><td>3.50</td><td>7.00</td></tr></tbody></table>",
    confidence: 0.8,
  },
  table_html_raw: {
    value: '<table class="x"><tr><td>Widget A</td></tr></table>',
    confidence: 0.8,
  },
  page_types: ["digital"],
  validator_flags: [],
  confidence_tier: "high",
  model_id: "openrouter/mock",
  prompt_version: "1.2",
  model_runs: [
    { model_id: "openai/gpt-4o-mini", purpose: "extract", cost_usd: 0.012, latency_ms: 1100 },
    { model_id: "openai/gpt-4o-mini", purpose: "agree", cost_usd: 0.011, latency_ms: 980 },
  ],
};

test("name is packetintake", () => {
  assert.equal(packetintake.name, "packetintake");
});

test("fromRaw maps ExtractionResult → CanonicalInvoice", () => {
  const got = packetintake.fromRaw(FIXTURE, "invoice") as CanonicalInvoice;
  assert.equal(got.vendorName, "Acme Supplies");
  assert.equal(got.customerName, "Northwind");
  assert.equal(got.invoiceNumber, "INV-1001");
  assert.equal(got.issueDate, "2026-04-14");
  assert.equal(got.dueDate, "2026-05-14");
  assert.equal(got.currency, "USD");
  assert.equal(got.subtotal, 22.25);
  assert.equal(got.tax, 1.78);
  assert.equal(got.total, 24.03);
  assert.equal(got.lineItems.length, 2);
  assert.deepEqual(got.lineItems[0], {
    description: "Widget A",
    quantity: 2,
    unitPrice: 3.5,
    amount: 7,
  });
  assert.deepEqual(got.lineItems[1], {
    description: "Gadget B",
    quantity: 1,
    unitPrice: 15.25,
    amount: 15.25,
  });
});

test("fromRaw maps ExtractionResult → CanonicalReceipt (serviceCharge stays null)", () => {
  const got = packetintake.fromRaw(FIXTURE, "receipt") as CanonicalReceipt;
  assert.equal(got.merchant, "Acme Supplies");
  assert.equal(got.address, "12 Orchard Rd, Singapore");
  assert.equal(got.date, "2026-04-14");
  assert.equal(got.subtotal, 22.25);
  assert.equal(got.tax, 1.78);
  assert.equal(got.serviceCharge, null);
  assert.equal(got.total, 24.03);
  assert.equal(got.items.length, 2);
  assert.equal(got.items[0].description, "Widget A");
  assert.equal(got.items[0].amount, 7);
});

test("fromRaw maps table_html.value to CanonicalTable (prefer minimal HTML)", () => {
  const got = packetintake.fromRaw(FIXTURE, "tables") as CanonicalTable;
  assert.equal(got.tableCount, 1);
  assert.ok(got.html?.startsWith("<table>"));
  assert.ok(got.html?.includes("Widget A"));
  assert.equal(got.html?.includes('class="x"'), false);
});

test("fromRaw tableCount is 0 when no HTML", () => {
  const got = packetintake.fromRaw({ header: {}, totals: {}, line_items: [] }, "tables") as CanonicalTable;
  assert.equal(got.html, null);
  assert.equal(got.tableCount, 0);
});

test("fromRaw leaves missing fields null and does not invent dates", () => {
  const got = packetintake.fromRaw(
    {
      header: {
        vendor_name: { value: null, confidence: null },
        invoice_date: { value: "", confidence: null },
      },
      totals: {},
      line_items: [],
    },
    "invoice",
  ) as CanonicalInvoice;
  assert.equal(got.vendorName, null);
  assert.equal(got.issueDate, null);
  assert.equal(got.dueDate, null);
  assert.equal(got.subtotal, null);
  assert.equal(got.tax, null);
  assert.equal(got.total, null);
  assert.deepEqual(got.lineItems, []);
});

test("fromRaw passes through extracted date strings as-is", () => {
  const got = packetintake.fromRaw(
    { header: { invoice_date: { value: "14-Apr-2022" } }, totals: {}, line_items: [] },
    "invoice",
  ) as CanonicalInvoice;
  assert.equal(got.issueDate, "14-Apr-2022");
});

test("costFromRaw sums model_runs.cost_usd", () => {
  assert.equal(costFromRaw(FIXTURE), 0.023);
  assert.equal(costFromRaw({}), null);
});

test("unitPriceUsd is the documented conservative estimate", () => {
  assert.equal(packetintake.unitPriceUsd("invoice", 1), PACKET_INTAKE_UNIT_PRICE_USD);
  assert.equal(packetintake.unitPriceUsd("receipt", 1), PACKET_INTAKE_UNIT_PRICE_USD);
  assert.equal(packetintake.unitPriceUsd("tables", 1), PACKET_INTAKE_UNIT_PRICE_USD);
  assert.ok(PACKET_INTAKE_UNIT_PRICE_USD > 0 && PACKET_INTAKE_UNIT_PRICE_USD <= 0.1);
});

test("available() reports no product for statements", () => {
  const why = packetintake.available("statement");
  assert.ok(why);
  assert.match(why!, /no product/i);
});

test("available() skips cleanly when the CLI python is missing", () => {
  const prev = process.env.PACKET_INTAKE_PYTHON;
  process.env.PACKET_INTAKE_PYTHON = "/no/such/packet-intake-python-binary";
  try {
    const why = packetintake.available("invoice");
    assert.ok(why);
    assert.match(why!, /not configured|CLI/i);
  } finally {
    if (prev === undefined) delete process.env.PACKET_INTAKE_PYTHON;
    else process.env.PACKET_INTAKE_PYTHON = prev;
  }
});

test("run() does not invent success when the CLI is missing", async () => {
  const prev = process.env.PACKET_INTAKE_PYTHON;
  process.env.PACKET_INTAKE_PYTHON = "/no/such/packet-intake-python-binary";
  try {
    await assert.rejects(
      () => packetintake.run(Buffer.from("not-a-document"), "image/jpeg", "invoice"),
      /not configured|CLI/i,
    );
  } finally {
    if (prev === undefined) delete process.env.PACKET_INTAKE_PYTHON;
    else process.env.PACKET_INTAKE_PYTHON = prev;
  }
});
