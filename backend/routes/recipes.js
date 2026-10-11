const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError, isUniqueViolation } = require('../http');
const { loadBook, findCycle, loadLastPrices, standardCosts, recipeTree, primaryRecipe } = require('../bom');
const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType } = require('docx');

// Recipes are versioned: the name stays, every edit saves a new version of the contents
// (output, yield, description, sections with their ingredients and steps) stamped with who
// saved it and when. The recipe row mirrors its current version; older versions stay in
// recipe_versions with their own sections and ingredients.
const RECIPE_SELECT = `
  SELECT r.*, i.name AS output_item_name, i.unit_type, i.tier,
         v.version_no, v.note AS version_note, v.description, v.created_at AS updated_at,
         COALESCE(u.name, u.username) AS updated_by_name,
         (SELECT COUNT(*) FROM recipe_versions x WHERE x.recipe_id = r.id)::int AS version_count
  FROM recipes r
  JOIN items i ON r.output_item_id = i.id
  JOIN recipe_versions v ON v.id = r.current_version_id
  LEFT JOIN users u ON u.id = v.created_by
`;

// Ingredients in the order they were written
const VERSION_ITEMS = `
  SELECT ri.*, i.name AS item_name, i.unit_type, i.tier
  FROM recipe_items ri
  JOIN items i ON ri.item_id = i.id
  WHERE ri.version_id = ANY($1::int[])
  ORDER BY ri.id
`;

// Sections (with their ingredients) of several versions: Map versionId -> sections in order,
// plus every ingredient row. q is db or a transaction handle.
async function loadSections(q, versionIds) {
  const sections = await q.query(
    'SELECT * FROM recipe_sections WHERE version_id = ANY($1::int[]) ORDER BY version_id, position',
    [versionIds]
  );
  const items = await q.query(VERSION_ITEMS, [versionIds]);
  const bySection = new Map(sections.map(s => [s.id, { ...s, items: [] }]));
  for (const i of items) bySection.get(i.section_id)?.items.push(i);
  const byVersion = new Map(versionIds.map(id => [id, []]));
  for (const s of bySection.values()) byVersion.get(s.version_id)?.push(s);
  return { byVersion, items };
}

// Current version with its sections and (flat) ingredients
async function getRecipeWithItems(q, id) {
  const recipe = await q.one(`${RECIPE_SELECT} WHERE r.id = $1`, [id]);
  if (!recipe) return null;
  const { byVersion, items } = await loadSections(q, [recipe.current_version_id]);
  return { ...recipe, sections: byVersion.get(recipe.current_version_id), items };
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

// Every version, newest first, with its description, sections, ingredients, who saved it,
// when, and how many production runs used it
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
  const { byVersion, items } = await loadSections(db, versions.map(v => v.id));
  res.json(versions.map(v => ({
    ...v,
    is_current: v.id === recipe.current_version_id,
    sections: byVersion.get(v.id),
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

const steps = instructions => (instructions ? instructions.split('\n').filter(Boolean) : []);

// GET /api/recipes/:id/word — download the recipe as a .docx document (description,
// sections with ingredients and numbered steps), followed by the recipes for each
// preprocessed ingredient it needs
router.get('/:id/word', ah(async (req, res) => {
  const book = await loadBook(db);
  const recipe = book.recipes.get(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  const costOf = standardCosts(book, await loadLastPrices(db));
  const tree = recipeTree(book, costOf, recipe, 1);
  const meta = await db.one(`${RECIPE_SELECT} WHERE r.id = $1`, [recipe.id]);
  const updated = new Date(meta.updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });

  // Each preprocessed ingredient's own recipe once, in the order they are first needed
  const subRecipes = [];
  const seen = new Set([tree.recipe_id]);
  const collect = node => {
    for (const ing of node.ingredients) {
      if (ing.sub && !seen.has(ing.sub.recipe_id)) {
        seen.add(ing.sub.recipe_id);
        subRecipes.push({ recipe: book.recipes.get(ing.sub.recipe_id), needed: ing.quantity, unit: ing.unit_type, parent: node.output_name });
        collect(ing.sub);
      }
    }
  };
  collect(tree);

  const versionIds = [recipe, ...subRecipes.map(s => s.recipe)].map(r => r.current_version_id);
  const { byVersion } = await loadSections(db, versionIds);
  const descriptions = new Map((await db.query(
    'SELECT id, description FROM recipe_versions WHERE id = ANY($1::int[])', [versionIds]
  )).map(v => [v.id, v.description]));
  const hasSubRecipe = itemId => book.items.get(itemId)?.tier === 'preprocessed' && primaryRecipe(book, itemId);

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

  const ingredientTable = items => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [headerCell('Ingredient'), headerCell('Quantity per Batch'), headerCell('Unit')],
      }),
      ...items.map(ing => new TableRow({
        children: [
          bodyCell(hasSubRecipe(ing.item_id) ? `${ing.item_name} (see below)` : ing.item_name),
          bodyCell(ing.quantity_per_batch.toFixed(2), AlignmentType.RIGHT),
          bodyCell(ing.unit_type, AlignmentType.RIGHT),
        ],
      })),
    ],
  });

  const paragraphs = text => (text ? text.split('\n').map(line => new Paragraph({ text: line })) : []);

  // The body of one recipe: its description, then each section. An untitled section (all
  // recipes written before sections existed) gets "Ingredients" and "Method" headings.
  const recipeBody = (versionId, heading) => [
    ...paragraphs(descriptions.get(versionId)),
    ...byVersion.get(versionId).flatMap(s => {
      const list = steps(s.instructions);
      return [
        new Paragraph({ text: '' }),
        ...(s.title ? [new Paragraph({ text: s.title, heading })] : []),
        ...(s.items.length > 0 ? [
          ...(s.title ? [] : [new Paragraph({ text: 'Ingredients', heading })]),
          ingredientTable(s.items),
        ] : []),
        ...(list.length > 0 ? [
          ...(s.title ? (s.items.length > 0 ? [new Paragraph({ text: '' })] : []) : [new Paragraph({ text: 'Method', heading })]),
          ...list.map((step, n) => new Paragraph({ text: `${n + 1}.\t${step}`, indent: { left: 440, hanging: 440 }, spacing: { after: 80 } })),
        ] : []),
      ];
    }),
  ];

  const subSections = subRecipes.flatMap(({ recipe: sub, needed, unit, parent }) => {
    const output = book.items.get(sub.output_item_id);
    return [
      new Paragraph({ text: '' }),
      new Paragraph({ text: `${output.name} (${sub.name})`, heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: `Yields ${sub.items_per_batch.toFixed(2)} ${output.unit_type} per batch. ${parent} needs ${needed.toFixed(2)} ${unit} per batch.` }),
      ...recipeBody(sub.current_version_id, HeadingLevel.HEADING_2),
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
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          run: { font: 'Calibri', size: 34, color: '000000', bold: true },
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
        ...recipeBody(recipe.current_version_id, HeadingLevel.HEADING_2),
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

// Free text: line endings normalised, trailing spaces and blank edges trimmed
function cleanText(text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd()).join('\n').trim();
  return t || null;
}

// Steps: one per line, blank lines dropped, typed numbering ("1.", "2)") removed since
// steps are numbered when shown
function cleanSteps(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
    .map(l => l.trim().replace(/^\d+[.)]\s*/, ''))
    .filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : null;
}

// Checks a recipe against the item tiers and the other recipes:
// output is preprocessed or final, ingredients are raw or preprocessed, no item twice in a
// section, and no loop (a recipe can't need, however indirectly, the thing it makes).
// body: { output_item_id, items_per_batch, description?, sections: [{ title?, instructions?, items: [{ item_id, quantity_per_batch }] }] }
async function validate(t, body, recipeId = null) {
  const { output_item_id, items_per_batch } = body;
  if (!Array.isArray(body.sections)) {
    throw new HttpError(400, 'Recipes now have sections. Please update the app (or reload the page) and try again.');
  }
  if (!output_item_id) throw new HttpError(400, 'Output item is required');
  if (!(Number(items_per_batch) > 0)) throw new HttpError(400, 'Units made per batch must be positive');

  const sections = body.sections
    .map(s => ({
      title: cleanText(s.title)?.replace(/\s+/g, ' ') ?? null,
      instructions: cleanSteps(s.instructions),
      items: (s.items || []).map(i => ({ item_id: Number(i.item_id), quantity_per_batch: Number(i.quantity_per_batch) })),
    }))
    .filter(s => s.title || s.instructions || s.items.length > 0);
  const lines = sections.flatMap(s => s.items);
  if (lines.length === 0) throw new HttpError(400, 'At least one ingredient is required');
  if (lines.some(l => !l.item_id || !(l.quantity_per_batch > 0))) {
    throw new HttpError(400, 'Every ingredient needs an item and a positive quantity');
  }
  for (const s of sections) {
    if (new Set(s.items.map(l => l.item_id)).size !== s.items.length) {
      throw new HttpError(400, `An ingredient appears twice in ${s.title ? `"${s.title}"` : 'the same section'}; combine the quantities`);
    }
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
  const loop = findCycle(book, output.id, [...new Set(lines.map(l => l.item_id))], recipeId);
  if (loop) throw new HttpError(400, `This would make a loop: ${loop.join(' → ')}`);

  return {
    output_item_id: output.id,
    items_per_batch: Number(items_per_batch),
    description: cleanText(body.description),
    sections,
  };
}

// A saved version in the same shape validate() takes and returns
async function versionContents(q, versionId) {
  const v = await q.one('SELECT * FROM recipe_versions WHERE id = $1', [versionId]);
  const { byVersion } = await loadSections(q, [versionId]);
  return {
    output_item_id: v.output_item_id,
    items_per_batch: v.items_per_batch,
    description: v.description,
    sections: byVersion.get(versionId).map(s => ({
      title: s.title,
      instructions: s.instructions,
      items: s.items.map(i => ({ item_id: i.item_id, quantity_per_batch: i.quantity_per_batch })),
    })),
  };
}

// Same output, yield, text, sections and ingredients (in order)?
function sameContents(a, b) {
  const key = r => JSON.stringify([r.output_item_id, r.items_per_batch, r.description ?? null,
    r.sections.map(s => [s.title ?? null, s.instructions ?? null, s.items.map(l => [l.item_id, l.quantity_per_batch])])]);
  return key(a) === key(b);
}

// Save `r` as the recipe's next version and make it current. Locks the recipe row so two
// people saving at once get consecutive version numbers.
async function saveVersion(t, recipeId, r, note, userId) {
  const recipe = await t.one('SELECT * FROM recipes WHERE id = $1 FOR UPDATE', [recipeId]);
  if (!recipe) throw new HttpError(404, 'Recipe not found');

  if (recipe.current_version_id && sameContents(r, await versionContents(t, recipe.current_version_id))) {
    throw new HttpError(400, 'Nothing changed, so no new version was saved');
  }

  const { id: versionId, version_no } = await t.one(`
    INSERT INTO recipe_versions (recipe_id, version_no, output_item_id, items_per_batch, description, note, created_by)
    VALUES ($1, (SELECT COALESCE(MAX(version_no), 0) + 1 FROM recipe_versions WHERE recipe_id = $1), $2, $3, $4, $5, $6)
    RETURNING id, version_no
  `, [recipeId, r.output_item_id, r.items_per_batch, r.description, note?.trim() || null, userId]);
  for (const [position, s] of r.sections.entries()) {
    const { id: sectionId } = await t.one(
      'INSERT INTO recipe_sections (version_id, position, title, instructions) VALUES ($1, $2, $3, $4) RETURNING id',
      [versionId, position, s.title, s.instructions]
    );
    for (const l of s.items) {
      await t.query(
        'INSERT INTO recipe_items (recipe_id, version_id, section_id, item_id, quantity_per_batch) VALUES ($1, $2, $3, $4, $5)',
        [recipeId, versionId, sectionId, l.item_id, l.quantity_per_batch]
      );
    }
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

// New recipe = version 1. { name, output_item_id, items_per_batch, description?, sections, note? }
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

// Edit = save a new version; the name never changes.
// { output_item_id, items_per_batch, description?, sections, note? }
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
    // Checked again: items may have been re-tiered or other recipes changed since
    const r = await validate(t, await versionContents(t, v.id), v.recipe_id);
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
