const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError } = require('../http');
const { previewProduction, produce } = require('../bom');

const PRODUCTION_SELECT = `
  SELECT pr.*, r.name AS recipe_name, v.version_no, i.name AS output_item_name, i.unit_type, i.tier,
         COALESCE(u.name, u.username) AS created_by_name
  FROM productions pr
  JOIN recipes r ON pr.recipe_id = r.id
  -- the version actually used, so history keeps its own output even if the recipe changed
  LEFT JOIN recipe_versions v ON v.id = pr.recipe_version_id
  JOIN items i ON i.id = COALESCE(v.output_item_id, r.output_item_id)
  LEFT JOIN users u ON u.id = pr.created_by
`;

router.get('/', ah(async (req, res) => {
  res.json(await db.query(`${PRODUCTION_SELECT} ORDER BY pr.date_produced DESC, pr.created_at DESC, pr.id DESC LIMIT 300`));
}));

const flag = v => v === true || v === 'true' || v === '1' || v === 1;

function parseOptions(src) {
  const batches = parseFloat(src.batches);
  if (!src.recipe_id) throw new HttpError(400, 'recipe_id is required');
  if (isNaN(batches) || batches <= 0) throw new HttpError(400, 'batches must be a positive number');
  return {
    recipeId: Number(src.recipe_id),
    batches,
    // Make short preprocessed ingredients from their own recipes as part of this run
    autoProduce: flag(src.auto_produce),
    // ...in whole batches rather than exactly the shortfall
    wholeBatches: flag(src.whole_batches),
  };
}

// Preview: plan and cost a run (including any sub-runs) without consuming stock.
// Costs use the average price of stock on hand; a recorded run uses true FIFO lot cost.
router.get('/preview', ah(async (req, res) => {
  res.json(await previewProduction(db, parseOptions(req.query)));
}));

// Record a run: FIFO-consume ingredients, add the output to stock, post to the journal
router.post('/', ah(async (req, res) => {
  const opts = parseOptions(req.body);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.date_produced || '')) {
    throw new HttpError(400, 'date_produced is required (YYYY-MM-DD)');
  }

  const productionId = await db.tx(t => produce(t, { ...opts, date: req.body.date_produced, userId: req.user.id }));

  const run = await db.one(`${PRODUCTION_SELECT} WHERE pr.id = $1`, [productionId]);
  const subRuns = await db.query(`
    WITH RECURSIVE tree AS (
      SELECT id FROM productions WHERE parent_production_id = $1
      UNION ALL
      SELECT p.id FROM productions p JOIN tree ON p.parent_production_id = tree.id
    )
    ${PRODUCTION_SELECT} WHERE pr.id IN (SELECT id FROM tree) ORDER BY pr.id
  `, [productionId]);
  res.status(201).json({ ...run, sub_runs: subRuns });
}));

module.exports = router;
