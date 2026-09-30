// Bill of materials: nested recipes, standard costs and multi-level production.
//
// Recipes nest. An ingredient may itself be made by a recipe (a preprocessed item such as
// white sauce), and that recipe may use other preprocessed items:
//   milk + butter + flour -> white sauce;  white sauce + mayo + SKM -> mayo mix;
//   mayo mix + kulit + smoke beef + ... -> Risoles Smoke Beef Mayo
// When an item has several recipes, the newest is its "primary" recipe: the one used to
// cost it and to make it automatically when a production run is short of it.
const { HttpError } = require('./http');
const { lockItems, consumeFifo } = require('./fifo');
const ledger = require('./ledger');

const EPS = 0.0001;
const MAX_DEPTH = 12;

const fmt = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// Every item and recipe (current version) at once; the catalogue is small and nesting
// needs all of it. q is db or a transaction handle.
async function loadBook(q) {
  const items = new Map((await q.query('SELECT * FROM items')).map(i => [i.id, i]));
  const recipes = new Map((await q.query('SELECT * FROM recipes ORDER BY created_at DESC, id DESC'))
    .map(r => [r.id, { ...r, items: [] }]));
  const lines = await q.query(`
    SELECT ri.* FROM recipe_items ri
    JOIN recipes r ON r.id = ri.recipe_id AND ri.version_id = r.current_version_id
    ORDER BY ri.id
  `);
  for (const line of lines) {
    recipes.get(line.recipe_id)?.items.push(line);
  }

  const byOutput = new Map();
  for (const r of recipes.values()) {
    if (!byOutput.has(r.output_item_id)) byOutput.set(r.output_item_id, []);
    byOutput.get(r.output_item_id).push(r); // newest first, from the ORDER BY
  }
  return { items, recipes, byOutput };
}

const primaryRecipe = (book, itemId) => book.byOutput.get(itemId)?.[0] || null;

// Would a recipe making `outputId` from `ingredientIds` feed back into itself?
// Returns the loop as item names (e.g. ['Mayo mix', 'White sauce', 'Mayo mix']) or null.
// skipRecipeId: the recipe being edited, whose saved ingredients are about to change.
function findCycle(book, outputId, ingredientIds, skipRecipeId = null) {
  const seen = new Set();
  const walk = (itemId, path) => {
    if (itemId === outputId) return path;
    if (seen.has(itemId)) return null;
    seen.add(itemId);
    for (const r of book.byOutput.get(itemId) || []) {
      if (r.id === skipRecipeId) continue;
      for (const ing of r.items) {
        const found = walk(ing.item_id, [...path, ing.item_id]);
        if (found) return found;
      }
    }
    return null;
  };
  for (const id of ingredientIds) {
    const loop = walk(id, [outputId, id]);
    if (loop) return loop.map(i => book.items.get(i)?.name ?? `#${i}`);
  }
  return null;
}

// Last known unit price per item: latest purchase, else latest production run.
async function loadLastPrices(q) {
  const rows = await q.query(`
    SELECT DISTINCT ON (item_id)
           item_id, price / amount AS unit_price, date_of_purchase, source
    FROM inventory_items
    WHERE amount > 0 AND source IN ('purchase', 'production')
    ORDER BY item_id, (source = 'purchase') DESC, date_of_purchase DESC, created_at DESC, id DESC
  `);
  return new Map(rows.map(r => [r.item_id, r]));
}

// Standard (expected) unit cost of each item: made items are costed through their primary
// recipe, bought items at their last price. Returns costOf(itemId) ->
// { unit_cost, missing: [names of bought items with no price yet], from: 'recipe'|'purchase'|'production'|null }
function standardCosts(book, lastPrices) {
  const memo = new Map();
  const costOf = (itemId, stack = new Set()) => {
    if (memo.has(itemId)) return memo.get(itemId);
    const recipe = primaryRecipe(book, itemId);
    let result;
    if (recipe && recipe.items_per_batch > 0 && !stack.has(itemId)) {
      stack.add(itemId);
      let total = 0;
      const missing = new Set();
      for (const ing of recipe.items) {
        const c = costOf(ing.item_id, stack);
        total += ing.quantity_per_batch * c.unit_cost;
        c.missing.forEach(m => missing.add(m));
      }
      stack.delete(itemId);
      result = { unit_cost: total / recipe.items_per_batch, missing: [...missing], from: 'recipe' };
    } else {
      const lp = lastPrices.get(itemId);
      result = lp
        ? { unit_cost: lp.unit_price, missing: [], from: lp.source }
        : { unit_cost: 0, missing: [book.items.get(itemId)?.name], from: null };
    }
    memo.set(itemId, result);
    return result;
  };
  return costOf;
}

// A recipe fully expanded: every preprocessed ingredient carries the sub-recipe that makes
// it, scaled to the amount needed, with standard costs rolled up from the bottom.
function recipeTree(book, costOf, recipe, batches = 1, depth = 0) {
  const out = book.items.get(recipe.output_item_id);
  const ingredients = recipe.items.map(line => {
    const item = book.items.get(line.item_id);
    const quantity = line.quantity_per_batch * batches;
    const c = costOf(line.item_id);
    const sub = primaryRecipe(book, line.item_id);
    return {
      item_id: item.id,
      name: item.name,
      unit_type: item.unit_type,
      tier: item.tier,
      quantity_per_batch: line.quantity_per_batch,
      quantity,
      unit_cost: c.unit_cost,
      cost: quantity * c.unit_cost,
      price_missing: c.missing.length > 0,
      sub: sub && sub.items_per_batch > 0 && depth < MAX_DEPTH
        ? recipeTree(book, costOf, sub, quantity / sub.items_per_batch, depth + 1)
        : null,
    };
  });
  const totalCost = ingredients.reduce((s, i) => s + i.cost, 0);
  const outputQty = recipe.items_per_batch * batches;
  return {
    recipe_id: recipe.id,
    recipe_name: recipe.name,
    output_item_id: out.id,
    output_name: out.name,
    unit_type: out.unit_type,
    tier: out.tier,
    items_per_batch: recipe.items_per_batch,
    batches,
    output_qty: outputQty,
    total_cost: totalCost,
    unit_cost: outputQty > 0 ? totalCost / outputQty : 0,
    ingredients,
  };
}

// ── Production ───────────────────────────────────────────────────────────────

// Items a run may consume: its ingredients and, when making missing ones automatically,
// the ingredients of their primary recipes, all the way down.
function itemsInvolved(book, recipe, autoProduce, acc = new Set(), depth = 0) {
  for (const line of recipe.items) {
    if (acc.has(line.item_id)) continue;
    acc.add(line.item_id);
    const sub = autoProduce && depth < MAX_DEPTH && primaryRecipe(book, line.item_id);
    if (sub) itemsInvolved(book, sub, true, acc, depth + 1);
  }
  return acc;
}

// On-hand quantity and average unit cost of open lots, per item
async function loadStock(q, itemIds) {
  const rows = await q.query(`
    SELECT item_id,
           SUM(remaining) AS remaining,
           SUM(CASE WHEN amount > 0 THEN remaining * price / amount ELSE 0 END) / SUM(remaining) AS avg
    FROM inventory_items
    WHERE remaining > 0 AND item_id = ANY($1::int[])
    GROUP BY item_id
  `, [itemIds]);
  return new Map(rows.map(r => [r.item_id, { remaining: r.remaining, avg: r.avg }]));
}

// Work out a run without touching the database. `stock` is consumed virtually as the plan
// goes, so two branches needing the same flour see what the other one left.
// With autoProduce, an ingredient that's short and has a recipe gets a sub-run for the
// shortfall (rounded up to whole batches with wholeBatches; the extra stays in stock).
// Costs are estimates at the average price of stock on hand; a recorded run uses true FIFO.
function planRun(book, stock, recipe, batches, opts, depth = 0) {
  if (depth > MAX_DEPTH) throw new HttpError(400, 'Recipes nest too deeply; check for a recipe that uses its own output');
  const out = book.items.get(recipe.output_item_id);

  const ingredients = recipe.items.map(line => {
    const item = book.items.get(line.item_id);
    const needed = line.quantity_per_batch * batches;
    if (!stock.has(item.id)) stock.set(item.id, { remaining: 0, avg: 0 });
    const s = stock.get(item.id);
    const inStock = s.remaining;
    const avgBefore = s.avg;
    const shortfall = Math.max(0, needed - inStock);

    let sub = null;
    if (shortfall > EPS && opts.autoProduce) {
      const r = primaryRecipe(book, item.id);
      if (r && r.items_per_batch > 0) {
        let subBatches = shortfall / r.items_per_batch;
        if (opts.wholeBatches) subBatches = Math.ceil(subBatches - 1e-9);
        sub = planRun(book, stock, r, subBatches, opts, depth + 1);
      }
    }

    const fromStock = Math.min(needed, inStock);
    let cost = fromStock * avgBefore;
    if (sub) {
      // FIFO: what was on hand goes first, then the fresh batch; any extra stays behind
      cost += shortfall * sub.unit_cost;
      s.remaining = Math.max(0, sub.output_qty - shortfall);
      s.avg = sub.unit_cost;
    } else {
      cost += shortfall * avgBefore;
      s.remaining = Math.max(0, inStock - needed);
    }

    return {
      item_id: item.id,
      name: item.name,
      unit_type: item.unit_type,
      tier: item.tier,
      needed,
      in_stock: inStock,
      shortfall,
      avg_unit_price: avgBefore,
      cost,
      sufficient: shortfall <= EPS,
      covered: shortfall <= EPS || (!!sub && sub.ok),
      has_recipe: !!primaryRecipe(book, item.id),
      sub,
    };
  });

  const totalCost = ingredients.reduce((s, i) => s + i.cost, 0);
  const outputQty = recipe.items_per_batch * batches;
  return {
    recipe_id: recipe.id,
    recipe_name: recipe.name,
    version_id: recipe.current_version_id,
    output_item_id: out.id,
    output_name: out.name,
    unit_type: out.unit_type,
    tier: out.tier,
    batches,
    output_qty: outputQty,
    total_cost: totalCost,
    unit_cost: outputQty > 0 ? totalCost / outputQty : 0,
    ok: ingredients.every(i => i.covered),
    ingredients,
  };
}

// Items the plan is short of, totalled across all levels, e.g. ['Terigu (short 120 g)']
function shortages(plan) {
  const short = new Map();
  const walk = node => {
    for (const ing of node.ingredients) {
      if (ing.covered) continue;
      if (ing.sub) { walk(ing.sub); continue; }
      const s = short.get(ing.item_id) || { ...ing, total: 0 };
      s.total += ing.shortfall;
      short.set(ing.item_id, s);
    }
  };
  walk(plan);
  return [...short.values()].map(s => `${s.name} (short ${fmt(s.total)} ${s.unit_type})`);
}

async function planFor(q, { recipeId, batches, autoProduce, wholeBatches }, lock) {
  const book = await loadBook(q);
  const recipe = book.recipes.get(Number(recipeId));
  if (!recipe) throw new HttpError(404, 'Recipe not found');
  if (!(recipe.items_per_batch > 0)) throw new HttpError(400, 'Recipe yield must be positive');
  const involved = [...itemsInvolved(book, recipe, autoProduce)];
  if (lock) await lockItems(q, involved);
  const stock = await loadStock(q, involved);
  return { book, plan: planRun(book, stock, recipe, batches, { autoProduce, wholeBatches }) };
}

// Costed what-if; consumes nothing
async function previewProduction(q, opts) {
  return (await planFor(q, opts, false)).plan;
}

// Sub-runs first so their output exists before the run that needs it consumes it.
async function executeRun(t, node, { date, userId, parentId = null }) {
  const { id } = await t.one(`
    INSERT INTO productions
      (recipe_id, recipe_version_id, batches, items_produced, total_cost, unit_cost, date_produced, created_by, parent_production_id)
    VALUES ($1, $2, $3, $4, 0, 0, $5, $6, $7)
    RETURNING id
  `, [node.recipe_id, node.version_id, node.batches, node.output_qty, date, userId, parentId]);

  for (const ing of node.ingredients) {
    if (ing.sub) await executeRun(t, ing.sub, { date, userId, parentId: id });
  }

  let totalCost = 0;
  const credits = [];
  for (const ing of node.ingredients) {
    const { ok, available, cost } = await consumeFifo(t, ing.item_id, ing.needed);
    if (!ok) {
      throw new HttpError(400,
        `Not enough "${ing.name}" for ${node.recipe_name}: need ${fmt(ing.needed)}, have ${fmt(available)} ${ing.unit_type}`);
    }
    totalCost += cost;
    credits.push({ account: ledger.inventoryAccount(ing.tier), credit: cost });
  }

  const unitCost = node.output_qty > 0 ? totalCost / node.output_qty : 0;
  await t.query('UPDATE productions SET total_cost = $2, unit_cost = $3 WHERE id = $1', [id, totalCost, unitCost]);
  await t.query(`
    INSERT INTO inventory_items (item_id, amount, remaining, price, date_of_purchase, source, production_id, created_by)
    VALUES ($1, $2, $2, $3, $4, 'production', $5, $6)
  `, [node.output_item_id, node.output_qty, totalCost, date, id, userId]);

  // Value moves between inventory tiers (raw -> preprocessed -> finished); nothing is expensed
  await ledger.post(t, {
    date,
    memo: `Production: ${node.recipe_name} (${fmt(node.output_qty)} ${node.unit_type} ${node.output_name})`,
    source_type: 'production',
    source_id: id,
    created_by: userId,
    lines: [{ account: ledger.inventoryAccount(node.tier), debit: totalCost }, ...credits],
  });
  return id;
}

// Record a run (and any sub-runs) inside transaction t. Returns the top run's id.
async function produce(t, { recipeId, batches, autoProduce, wholeBatches, date, userId }) {
  const { plan } = await planFor(t, { recipeId, batches, autoProduce, wholeBatches }, true);
  if (!plan.ok) {
    throw new HttpError(400, `Not enough stock: ${shortages(plan).join(', ')}`);
  }
  return executeRun(t, plan, { date, userId });
}

module.exports = {
  loadBook, primaryRecipe, findCycle, loadLastPrices, standardCosts, recipeTree,
  previewProduction, produce,
};
