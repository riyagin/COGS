const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, isUniqueViolation } = require('../http');
const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType } = require('docx');

// q is db or a transaction handle
async function getRecipeWithItems(q, id) {
  const recipe = await q.one(`
    SELECT r.*, p.name AS output_product_name, p.unit_type
    FROM recipes r
    JOIN products p ON r.output_product_id = p.id
    WHERE r.id = $1
  `, [id]);
  if (!recipe) return null;

  const items = await q.query(`
    SELECT ri.*, p.name AS product_name, p.unit_type
    FROM recipe_items ri
    JOIN products p ON ri.product_id = p.id
    WHERE ri.recipe_id = $1
    ORDER BY p.name
  `, [id]);

  return { ...recipe, items };
}

router.get('/', ah(async (req, res) => {
  res.json(await db.query(`
    SELECT r.*, p.name AS output_product_name, p.unit_type
    FROM recipes r
    JOIN products p ON r.output_product_id = p.id
    ORDER BY r.name
  `));
}));

router.get('/:id', ah(async (req, res) => {
  const recipe = await getRecipeWithItems(db, req.params.id);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  res.json(recipe);
}));

// GET /api/recipes/:id/word — download the recipe as a .docx file
router.get('/:id/word', ah(async (req, res) => {
  const recipe = await getRecipeWithItems(db, req.params.id);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  const { items } = recipe;

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

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [headerCell('Ingredient'), headerCell('Quantity per Batch'), headerCell('Unit')],
      }),
      ...items.map(item => new TableRow({
        children: [
          bodyCell(item.product_name),
          bodyCell(item.quantity_per_batch.toFixed(2), AlignmentType.RIGHT),
          bodyCell(item.unit_type, AlignmentType.RIGHT),
        ],
      })),
    ],
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
        new Paragraph({ text: recipe.name, heading: HeadingLevel.TITLE }),
        new Paragraph({ text: `Yields: ${recipe.items_per_batch.toFixed(2)} ${recipe.unit_type} of ${recipe.output_product_name} per batch` }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: 'Ingredients', heading: HeadingLevel.HEADING_2 }),
        table,
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = `${recipe.name.replace(/[^a-z0-9]+/gi, '_')}.docx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}));

async function saveItems(t, recipeId, items) {
  for (const item of items) {
    await t.query(
      'INSERT INTO recipe_items (recipe_id, product_id, quantity_per_batch) VALUES ($1, $2, $3)',
      [recipeId, item.product_id, item.quantity_per_batch]
    );
  }
}

function recipeConflict(res, err) {
  if (isUniqueViolation(err)) {
    res.status(409).json({ error: 'A recipe with this name already exists' });
    return true;
  }
  return false;
}

router.post('/', ah(async (req, res) => {
  const { name, output_product_id, items_per_batch, items } = req.body;
  if (!name || !output_product_id || !items_per_batch || !items || items.length === 0) {
    return res.status(400).json({ error: 'All fields are required and at least one ingredient is needed' });
  }

  try {
    const recipe = await db.tx(async t => {
      const { id } = await t.one(
        'INSERT INTO recipes (name, output_product_id, items_per_batch) VALUES ($1, $2, $3) RETURNING id',
        [name.trim(), output_product_id, items_per_batch]
      );
      await saveItems(t, id, items);
      return getRecipeWithItems(t, id);
    });
    res.status(201).json(recipe);
  } catch (err) {
    if (!recipeConflict(res, err)) throw err;
  }
}));

router.put('/:id', ah(async (req, res) => {
  const { name, output_product_id, items_per_batch, items } = req.body;
  if (!name || !output_product_id || !items_per_batch || !items || items.length === 0) {
    return res.status(400).json({ error: 'All fields are required and at least one ingredient is needed' });
  }

  try {
    const recipe = await db.tx(async t => {
      const updated = await t.query(
        'UPDATE recipes SET name = $1, output_product_id = $2, items_per_batch = $3 WHERE id = $4 RETURNING id',
        [name.trim(), output_product_id, items_per_batch, req.params.id]
      );
      if (updated.length === 0) return null;
      await t.query('DELETE FROM recipe_items WHERE recipe_id = $1', [req.params.id]);
      await saveItems(t, req.params.id, items);
      return getRecipeWithItems(t, req.params.id);
    });
    if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
    res.json(recipe);
  } catch (err) {
    if (!recipeConflict(res, err)) throw err;
  }
}));

router.delete('/:id', ah(async (req, res) => {
  const rows = await db.query('DELETE FROM recipes WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Recipe not found' });
  res.json({ success: true });
}));

module.exports = router;
