// Receipt reading, run in the main process.
//   local   Tesseract (offline, free): returns raw text; the renderer parses it into lines.
//   claude  Claude vision (needs an API key): returns the receipt already structured, with
//           lines matched to our items and quantities converted to each item's unit.
const path = require('node:path');
const { app } = require('electron');
const store = require('./store.cjs');

const MODEL = 'claude-opus-5-5';

// ── Tesseract ────────────────────────────────────────────────────────────────

let workerPromise = null;

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Packaged builds unpack node_modules out of app.asar: worker threads can't load from inside it
const unpacked = p => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, PSM } = require('tesseract.js');
      const workerPath = unpacked(require.resolve('tesseract.js/src/worker-script/node/index.js'));
      // Indonesian + English traineddata, downloaded once and cached in userData/tessdata.
      // A worker that can't start never answers, so give up after a while instead of hanging.
      const worker = await withTimeout(createWorker(['ind', 'eng'], 1, {
        workerPath,
        cachePath: path.join(app.getPath('userData'), 'tessdata'),
        errorHandler: err => console.error('tesseract worker:', err),
      }), 180_000, 'The OCR engine did not start. Check the internet connection (the first scan downloads language files) and try again.');
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_COLUMN, // receipts: one column of variable-size text
        preserve_interword_spaces: '1',           // keeps the gap between name and price columns
      });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; }); // let the next scan retry (e.g. after going online)
  }
  return workerPromise;
}

async function readLocal(bytes) {
  const worker = await getWorker();
  const { data } = await worker.recognize(Buffer.from(bytes));
  return { text: data.text, confidence: data.confidence };
}

async function shutdown() {
  if (workerPromise) await (await workerPromise).terminate().catch(() => {});
}

// ── Claude ───────────────────────────────────────────────────────────────────

const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier', 'date', 'reference', 'total', 'lines'],
  properties: {
    supplier: nullable({ type: 'string' }),
    date: nullable({ type: 'string', description: 'YYYY-MM-DD' }),
    reference: nullable({ type: 'string' }),
    total: nullable({ type: 'number' }),
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'quantity', 'unit_price', 'amount', 'kind', 'item_id', 'item_quantity', 'account_id'],
        properties: {
          description: { type: 'string' },
          quantity: { type: 'number' },
          unit_price: nullable({ type: 'number' }),
          amount: { type: 'number' },
          kind: { type: 'string', enum: ['item', 'expense', 'unknown'] },
          item_id: nullable({ type: 'integer' }),
          item_quantity: nullable({ type: 'number' }),
          account_id: nullable({ type: 'integer' }),
        },
      },
    },
  },
};

const SYSTEM = `You read photos of purchase receipts for a small Indonesian café and turn them into purchase lines for its inventory system.

Money is Indonesian rupiah: "15.000" and "15,000" both mean 15000. Return plain numbers.

For every purchased product on the receipt, return one line:
- description: the product text as printed.
- quantity and unit_price as printed (quantity 1 when none is shown).
- amount: what was paid for that line, after any discount printed directly under it.
- kind "item" with item_id when the product is clearly one of the café's stock items listed below. Set item_quantity to the quantity in that item's unit, using the pack size printed in the description (2 × "TERIGU 1KG" for an item kept in g is 2000; 3 × "UHT 1L" for an item in mL is 3000). When the pack size isn't printed, set item_quantity to null.
- kind "expense" with account_id for non-stock costs that fit one of the expense accounts below (delivery, parking, gas, …).
- kind "unknown" otherwise. Don't force a match you aren't sure of; a person reviews every line.

Leave out subtotal, total, tax, rounding, payment, change and receipt-wide discount lines. total is the final amount paid. date is the purchase date as YYYY-MM-DD; numeric dates on these receipts are day first. reference is the receipt or invoice number if one is printed. Use null for anything not on the receipt.`;

function contextText({ items, accounts, aliases, today }) {
  const itemList = items.map(i => `${i.id} | ${i.name} | ${i.unit_type}`).join('\n');
  const accountList = accounts.map(a => `${a.id} | ${a.name}`).join('\n');
  const learned = aliases.slice(0, 200)
    .map(a => `"${a.text}" → ${a.target}`).join('\n');
  return [
    `Stock items (id | name | unit):\n${itemList || '(none)'}`,
    `Expense accounts (id | name):\n${accountList || '(none)'}`,
    learned && `How earlier receipt lines were matched by the café (receipt text → item, item units per receipt unit):\n${learned}`,
    `Today is ${today}.`,
  ].filter(Boolean).join('\n\n');
}

async function readClaude({ imageId, items, accounts, aliases, today }) {
  const apiKey = store.getApiKey();
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings to use Claude.');

  const { default: Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const image = store.readImage(imageId).toString('base64');

  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text: `${contextText({ items, accounts, aliases, today })}\n\nRead this receipt.` },
        ],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Claude rejected the API key. Check it in Settings.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('Claude is rate limiting requests. Wait a moment and scan again.');
    if (err instanceof Anthropic.APIConnectionError) throw new Error('Could not reach Claude. Check the internet connection.');
    if (err instanceof Anthropic.APIError) throw new Error(`Claude error ${err.status ?? ''}: ${err.message}`);
    throw err;
  }

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to read this image.');
  if (response.stop_reason === 'max_tokens') throw new Error('The receipt was too long to read in one go.');
  const text = response.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Claude returned no result.');
  return JSON.parse(text);
}

module.exports = { readLocal, readClaude, shutdown, MODEL };
