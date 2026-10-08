// Date ranges and reporting periods. Business dates are 'YYYY-MM-DD' strings throughout,
// so this works on those strings with UTC date math (no time zones involved).
const { HttpError } = require('./http');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GROUPS = ['day', 'week', 'month', 'total'];

// Never return more columns than this; a year of days is the most anyone reads
const MAX_PERIODS = 400;

const parse = s => new Date(`${s}T00:00:00Z`);
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

function dateParam(v, name) {
  if (v === undefined || v === '') return null;
  if (!ISO_DATE.test(v) || Number.isNaN(parse(v).getTime())) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
  return v;
}

// ?from&to&group from a request; defaults to this month, grouped by month
function rangeParams(query, defaultGroup = 'month') {
  const today = new Date().toLocaleDateString('en-CA');
  const from = dateParam(query.from, 'from') || `${today.slice(0, 7)}-01`;
  const to = dateParam(query.to, 'to') || today;
  if (from > to) throw new HttpError(400, '"from" must be on or before "to"');
  const group = query.group || defaultGroup;
  if (!GROUPS.includes(group)) throw new HttpError(400, `group must be one of ${GROUPS.join(', ')}`);
  return { from, to, group };
}

// The period a date falls in: the date itself, the Monday its week starts on, or YYYY-MM
function periodKey(date, group) {
  switch (group) {
    case 'day': return date;
    case 'week': return addDays(date, -((parse(date).getUTCDay() + 6) % 7));
    case 'month': return date.slice(0, 7);
    default: return 'total';
  }
}

// Every period from `from` to `to`, each clipped to the range: [{ key, from, to }]
function periodsBetween(from, to, group) {
  if (group === 'total') return [{ key: 'total', from, to }];
  const periods = [];
  let start = from;
  while (start <= to) {
    const key = periodKey(start, group);
    let end;
    if (group === 'day') end = start;
    else if (group === 'week') end = addDays(key, 6);
    else {
      const d = parse(`${key}-01`);
      d.setUTCMonth(d.getUTCMonth() + 1, 0);
      end = iso(d);
    }
    if (end > to) end = to;
    periods.push({ key, from: start, to: end });
    if (periods.length > MAX_PERIODS) {
      throw new HttpError(400, `That is more than ${MAX_PERIODS} ${group}s; pick a shorter range or a longer period`);
    }
    start = addDays(end, 1);
  }
  return periods;
}

module.exports = { ISO_DATE, GROUPS, dateParam, rangeParams, periodKey, periodsBetween, addDays };
