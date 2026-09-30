const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError, isUniqueViolation } = require('../http');
const { loadBook, findCycle, loadLastPrices, standardCosts, recipeTree, primaryRecipe } = require('../bom');
const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType } = require('docx');

// Recipes are versioned: the name stays, every edit saves a new version of the contents
// (output, yield, ingredients) stamped with who saved it and when. The recipe row mirrors
// its current version; older versions stay in recipe_versions with their own ingredients.
const RECIPE_SELECT = `
  SELECT r.*, i.name AS output_item_name, i.unit_type, i.tier,
         v.version_no, v.note AS version_note, v.created_at AS updated_at,
         COALESCE(u.name, u.username) AS updated_by_name,
         (SELECT COUNT(*) FROM recipe_versions x WHERE x.recipe_id = r.id)::int AS version_count
  FROM recipes r
  JOIN items i ON r.output_item_id = i.id
  JOIN recipe_versions v ON v.id = r.current_version_id
  LEFT JOIN users u ON u.id = v.created_by
`;

const VERSION_ITEMS = `
  SELECT ri.*, i.name AS item_name, i.unit_type, i.tier
  FROM recipe_items ri
  JOIN items i ON ri.item_id = i.id
  WHERE ri.version_id = ANY($1::int[])
  ORDER BY CASE i.tier WHEN 'preprocessed' THEN 0 WHEN 'final' THEN 1 ELSE 2 END, i.name
`;

// Current version with its ingredients. q is db or a transaction handle
async function getRecipeWithItems(q, id) {
  const recipe = await q.one(`${RECIPE_SELECT} WHERE r.id = $1`, [id]);
  if (!recipe) return null;
  const items = await q.query(VERSION_ITEMS, [[recipe.current_version_id]]);
  return { ...recipe, items };
}

// Every recipe with its expected cost per unit (sub-recipes rolled up) and whether it is
// the primary (newest) recipe for its output, i.e. the one used for automatic sub-runs.
router.get('/', ah(async (req, res) => {
  const recipes = await db.query(`${RECIPE_SELECT} ORDER BY r.name`);
  const book = await loadBook(db);
  const costOf = standardCosts(book, await loadLastPrices(db));
  res.json(recipes.map(r => {
    const tree = recipeTree(book, costOf, book.recipes.get(r.id));
    return {
      ...r,
      ingredient_count: tree.ingredients.length,
      has_sub_recipes: tree.ingredients.some(i => i.sub),
      batch_cost: tree.total_cost,
      unit_cost: tree.unit_cost,
      is_primary: primaryRecipe(book, r.output_item_id)?.id === r.id,
    };
  }));
}));

router.get('/:id', ah(async (req, res) => {
  const recipe = await getRecipeWithItems(db, req.params.id);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  res.json(recipe);
}));

// Every version, newest first, with its ingredients, who saved it, when, and how many
// production runs used it
router.get('/:id/versions', ah(async (req, res) => {
  const recipe = await db.one('SELECT id, current_version_id FROM recipes WHERE id = $1', [req.params.id]);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  const versions = await db.query(`
    SELECT v.*, i.name AS output_item_name, i.unit_type AS output_unit_type,
           COALESCE(u.name, u.username) AS created_by_name,
           (SELECT COUNT(*) FROM productions p WHERE p.recipe_version_id = v.id)::int AS run_count
    FROM recipe_versions v
    JOIN items i ON i.id = v.output_item_id
    LEFT JOIN users u ON u.id = v.created_by
    WHERE v.recipe_id = $1
    ORDER BY v.version_no DESC
  `, [recipe.id]);
  const items = await db.query(VERSION_ITEMS, [versions.map(v => v.id)]);
  res.json(versions.map(v => ({
    ...v,
    is_current: v.id === recipe.current_version_id,
    items: items.filter(i => i.version_id === v.id),
  })));
}));

// The recipe fully expanded through its preprocessed ingredients, with expected costs.
// ?batches=N scales it (default 1).
router.get('/:id/tree', ah(async (req, res) => {
  const book = await loadBook(db);
  const recipe = book.recipes.get(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  const batches = Number(req.query.batches) > 0 ? Number(req.query.batches) : 1;
  const costOf = standardCosts(book, await loadLastPrices(db));
  res.json(recipeTree(book, costOf, recipe, batches));
}));

// GET /api/recipes/:id/word — download the recipe as a .docx file, followed by the
// recipes for each preprocessed ingredient it needs
router.get('/:id/word', ah(async (req, res) => {
  const book = await loadBook(db);
  const recipe = book.recipes.get(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  const costOf = standardCosts(book, await loadLastPrices(db));
  const tree = recipeTree(book, costOf, recipe, 1);
  const meta = await db.one(`${RECIPE_SELECT} WHERE r.id = $1`, [recipe.id]);
  const updated = new Date(meta.updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });

  const cellBorder = { style: BorderStyle.SINGLE, size: 2, color: '000000' };
  const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };
  const transparentShading = { type: ShadingType.CLEAR, fill: 'auto' };

  const headerCell = text => new TableCell({
    borders: cellBorders,
    shading: transparentShading,
    children: [new Paragraph({ text, style: 'tableHeader' })],
  });
  const bodyCell = (text, alignment) => new TableCell({
    borders: cellBorders,
    shading: transparentShading,
    children: [new Paragraph({ text: String(text), alignment })],
  });

  const ingredientTable = node => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [headerCell('Ingredient'), headerCell('Quantity per Batch'), headerCell('Unit')],
      }),
      ...node.ingredients.map(ing => new TableRow({
        children: [
          bodyCell(ing.sub ? `${ing.name} (see below)` : ing.name),
          bodyCell(ing.quantity_per_batch.toFixed(2), AlignmentType.RIGHT),
          bodyCell(ing.unit_type, AlignmentType.RIGHT),
        ],
      })),
    ],
  });

  // Each preprocessed ingredient's own recipe once, in the order they are first needed
  const subRecipes = [];
  const seen = new Set([tree.recipe_id]);
  const collect = node => {
    for (const ing of node.ingredients) {
      if (ing.sub && !seen.has(ing.sub.recipe_id)) {
        seen.add(ing.sub.recipe_id);
        subRecipes.push({ node: book.recipes.get(ing.sub.recipe_id), needed: ing.quantity, unit: ing.unit_type, parent: node.output_name });
        collect(ing.sub);
      }
    }
  };
  collect(tree);

  const subSections = subRecipes.flatMap(({ node, needed, unit, parent }) => {
    const sub = recipeTree(book, costOf, node, 1);
    return [
      new Paragraph({ text: '' }),
      new Paragraph({ text: `${sub.output_name} (${sub.recipe_name})`, heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ text: `Yields ${sub.items_per_batch.toFixed(2)} ${sub.unit_type} per batch. ${parent} needs ${needed.toFixed(2)} ${unit} per batch.` }),
      ingredientTable(sub),
    ];
  });

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 28, color: '000000' },
        },
      },
      paragraphStyles: [
        {
          id: 'tableHeader',
          name: 'Table Header',
          basedOn: 'Normal',
          run: { font: 'Calibri', size: 28, color: '000000', bold: true },
        },
        {
          id: 'Title',
          name: 'Title',
          basedOn: 'Normal',
          run: { font: 'Calibri', size: 40, color: '000000', bold: true },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          run: { font: 'Calibri', size: 32, color: '000000', bold: true },
        },
      ],
    },
    sections: [{
      children: [
        new Paragraph({ text: tree.recipe_name, heading: HeadingLevel.TITLE }),
        new Paragraph({ text: `Version ${meta.version_no}, updated ${updated}${meta.updated_by_name ? ` by ${meta.updated_by_name}` : ''}` }),
        new Paragraph({ text: `Yields: ${tree.items_per_batch.toFixed(2)} ${tree.unit_type} of ${tree.output_name} per batch` }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: 'Ingredients', heading: HeadingLevel.HEADING_2 }),
        ingredientTable(tree),
        ...subSections,
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = `${tree.recipe_name.replace(/[^a-z0-9]+/gi, '_')}.docx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}));

// Checks a recipe against the item tiers and the other recipes:
// output is preprocessed or final, ingredients are raw or preprocessed, no item twice,
// and no loop (a recipe can't need, however indirectly, the thing it makes).
async function validate(t, body, recipeId = null) {
  const { output_item_id, items_per_batch, items } = body;
  if (!output_item_id || !items || items.length === 0) {
    throw new HttpError(400, 'Output item and at least one ingredient are required');
  }
  if (!(Number(items_per_batch) > 0)) throw new HttpError(400, 'Units made per batch must be positive');

  const lines = items.map(i => ({ item_id: Number(i.item_id), quantity_per_batch: Number(i.quantity_per_batch) }));
  if (lines.some(l => !l.item_id || !(l.quantity_per_batch > 0))) {
    throw new HttpError(400, 'Every ingredient needs an item and a positive quantity');
  }
  if (new Set(lines.map(l => l.item_id)).size !== lines.length) {
    throw new HttpError(400, 'Each ingredient can appear only once');
  }

  const book = await loadBook(t);
  const output = book.items.get(Number(output_item_id));
  if (!output) throw new HttpError(404, 'Output item not found');
  if (output.tier === 'raw') {
    throw new HttpError(400, `"${output.name}" is a raw material. Only preprocessed items and final goods are made by recipes; change its tier on the Items page first.`);
  }
  for (const l of lines) {
    const item = book.items.get(l.item_id);
    if (!item) throw new HttpError(404, `Ingredient not found (id ${l.item_id})`);
    if (item.id === output.id) throw new HttpError(400, `"${item.name}" can't be an ingredient of itself`);
    if (item.tier === 'final') {
      throw new HttpError(400, `"${item.name}" is a final good and can't be an ingredient. If it goes into other recipes, make it preprocessed on the Items page.`);
    }
  }
  const loop = findCycle(book, output.id, lines.map(l => l.item_id), recipeId);
  if (loop) throw new HttpError(400, `This would make a loop: ${loop.join(' → ')}`);

  return { output_item_id: output.id, items_per_batch: Number(items_per_batch), lines };
}

// Same output, yield and ingredient quantities?
function sameContents(a, b) {
  const key = r => JSON.stringify([r.output_item_id, r.items_per_batch,
    [...r.lines].sort((x, y) => x.item_id - y.item_id).map(l => [l.item_id, l.quantity_per_batch])]);
  return key(a) === key(b);
}

// Save `r` as the recipe's next version and make it current. Locks the recipe row so two
// people saving at once get consecutive version numbers.
async function saveVersion(t, recipeId, r, note, userId) {
  const recipe = await t.one('SELECT * FROM recipes WHERE id = $1 FOR UPDATE', [recipeId]);
  if (!recipe) throw new HttpError(404, 'Recipe not found');

  if (recipe.current_version_id) {
    const current = await t.query('SELECT item_id, quantity_per_batch FROM recipe_items WHERE version_id = $1', [recipe.current_version_id]);
    if (sameContents(r, { output_item_id: recipe.output_item_id, items_per_batch: recipe.items_per_batch, lines: current })) {
      throw new HttpError(400, 'Nothing changed, so no new version was saved');
    }
  }

  const { id: versionId, version_no } = await t.one(`
    INSERT INTO recipe_versions (recipe_id, version_no, output_item_id, items_per_batch, note, created_by)
    VALUES ($1, (SELECT COALESCE(MAX(version_no), 0) + 1 FROM recipe_versions WHERE recipe_id = $1), $2, $3, $4, $5)
    RETURNING id, version_no
  `, [recipeId, r.output_item_id, r.items_per_batch, note?.trim() || null, userId]);
  for (const l of r.lines) {
    await t.query(
      'INSERT INTO recipe_items (recipe_id, version_id, item_id, quantity_per_batch) VALUES ($1, $2, $3, $4)',
      [recipeId, versionId, l.item_id, l.quantity_per_batch]
    );
  }
  await t.query(
    'UPDATE recipes SET output_item_id = $2, items_per_batch = $3, current_version_id = $4 WHERE id = $1',
    [recipeId, r.output_item_id, r.items_per_batch, versionId]
  );
  return version_no;
}

const conflict = err => {
  if (isUniqueViolation(err)) throw new HttpError(409, 'A recipe with this name already exists');
  throw err;
};

// New recipe = version 1. { name, output_item_id, items_per_batch, items, note? }
router.post('/', ah(async (req, res) => {
  const name = req.body.name?.trim();
  if (!name) throw new HttpError(400, 'Name is required');
  const recipe = await db.tx(async t => {
    const r = await validate(t, req.body);
    const { id } = await t.one(
      'INSERT INTO recipes (name, output_item_id, items_per_batch) VALUES ($1, $2, $3) RETURNING id',
      [name, r.output_item_id, r.items_per_batch]
    );
    await saveVersion(t, id, r, req.body.note || 'First version', req.user.id);
    return getRecipeWithItems(t, id);
  }).catch(conflict);
  res.status(201).json(recipe);
}));

// Edit = save a new version; the name never changes. { output_item_id, items_per_batch, items, note? }
router.put('/:id', ah(async (req, res) => {
  const recipe = await db.tx(async t => {
    const r = await validate(t, req.body, Number(req.params.id));
    await saveVersion(t, Number(req.params.id), r, req.body.note, req.user.id);
    return getRecipeWithItems(t, req.params.id);
  });
  res.json(recipe);
}));

// Bring an old version back by saving a copy of it as the newest version
router.post('/:id/versions/:versionId/restore', ah(async (req, res) => {
  const recipe = await db.tx(async t => {
    const v = await t.one('SELECT * FROM recipe_versions WHERE id = $1 AND recipe_id = $2', [req.params.versionId, req.params.id]);
    if (!v) throw new HttpError(404, 'Version not found');
    const items = await t.query('SELECT item_id, quantity_per_batch FROM recipe_items WHERE version_id = $1', [v.id]);
    // Checked again: items may have been re-tiered or other recipes changed since
    const r = await validate(t, { output_item_id: v.output_item_id, items_per_batch: v.items_per_batch, items }, v.recipe_id);
    const note = [`Restored from version ${v.version_no}`, req.body?.note?.trim()].filter(Boolean).join(': ');
    await saveVersion(t, v.recipe_id, r, note, req.user.id);
    return getRecipeWithItems(t, v.recipe_id);
  });
  res.json(recipe);
}));

router.delete('/:id', ah(async (req, res) => {
  const rows = await db.query('DELETE FROM recipes WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Recipe not found' });
  res.json({ success: true });
}));

module.exports = router;
