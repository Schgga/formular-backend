import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requirePermission } from '../Middleware/permission.middleware.js';

// =====================================================================
// SURVEYS
//  Users   (mount at /api/surveys):
//    GET  /next?place=studio      one survey this user should see now (or none)
//    POST /:id/answer             { answers: { <questionId>: value } }
//    POST /:id/dismiss            "Not now" — we will not ask again
//
//  Admin   (mount adminRouter at /api/admin/surveys, permission 'surveys'):
//    GET    /            list + answer counts
//    GET    /:id         one survey with its questions
//    POST   /            create { title, intro, audience, showWhen, afterCount, isActive, questions: [...] }
//    PUT    /:id         update (same body)
//    DELETE /:id
//    GET    /:id/results summary per question
//    GET    /:id/export  CSV download
// =====================================================================

const router = Router();
export const adminRouter = Router();

const KINDS = ['rating', 'choice', 'multi', 'text'];
const AUDIENCES = ['all', 'studio'];
const WHEN = ['anytime', 'after_plans'];
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const isId = (v) => /^\d{1,9}$/.test(String(v));

async function questionsOf(surveyId) {
  const r = await pool.query('SELECT id, kind, label, options, required FROM survey_questions WHERE survey_id = $1 ORDER BY sort_order, id', [surveyId]);
  return r.rows;
}

// ---------------- users ----------------
router.get('/next', requireAuth, async (req, res) => {
  try {
    const place = req.query.place === 'studio' ? 'studio' : 'all';
    const plans = await pool.query(
      `SELECT COUNT(*)::int AS n FROM video_plans WHERE user_id = $1 AND status = 'done'`, [req.user.id]).catch(() => ({ rows: [{ n: 0 }] }));
    const r = await pool.query(
      `SELECT s.id, s.title, s.intro FROM surveys s
       WHERE s.is_active = true
         AND (s.audience = 'all' OR s.audience = $2)
         AND (s.show_when = 'anytime' OR (s.show_when = 'after_plans' AND $3 >= s.after_count))
         AND NOT EXISTS (SELECT 1 FROM survey_responses sr WHERE sr.survey_id = s.id AND sr.user_id = $1)
         AND EXISTS (SELECT 1 FROM survey_questions q WHERE q.survey_id = s.id)
       ORDER BY s.id LIMIT 1`, [req.user.id, place, plans.rows[0].n]);
    if (!r.rows.length) return res.json({ success: true, survey: null });
    const s = r.rows[0];
    res.json({ success: true, survey: { ...s, questions: await questionsOf(s.id) } });
  } catch (err) {
    console.error(err);
    res.json({ success: true, survey: null }); // never block a page because of a survey
  }
});

router.post('/:id/answer', requireAuth, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Survey not found' });
    const s = await pool.query('SELECT id FROM surveys WHERE id = $1 AND is_active = true', [req.params.id]);
    if (!s.rows.length) return res.status(404).json({ success: false, error: 'Survey not found' });
    const qs = await questionsOf(s.rows[0].id);
    const given = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    const answers = {};
    for (const q of qs) {
      const v = given[q.id];
      const opts = Array.isArray(q.options) ? q.options : [];
      let val = null;
      if (q.kind === 'rating') { const n = Number(v); if (Number.isInteger(n) && n >= 1 && n <= 5) val = n; }
      if (q.kind === 'choice' && typeof v === 'string' && opts.includes(v)) val = v;
      if (q.kind === 'multi' && Array.isArray(v)) { const picked = [...new Set(v.filter((x) => typeof x === 'string' && opts.includes(x)))]; if (picked.length) val = picked; }
      if (q.kind === 'text') { const t = clean(v, 1500); if (t) val = t; }
      if (val === null && q.required) return res.status(400).json({ success: false, error: `Please answer: ${q.label}` });
      if (val !== null) answers[q.id] = val;
    }
    await pool.query(
      `INSERT INTO survey_responses (survey_id, user_id, dismissed, answers) VALUES ($1, $2, false, $3)
       ON CONFLICT (survey_id, user_id) DO NOTHING`, [s.rows[0].id, req.user.id, JSON.stringify(answers)]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not send your answers' });
  }
});

router.post('/:id/dismiss', requireAuth, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Survey not found' });
    await pool.query(
      `INSERT INTO survey_responses (survey_id, user_id, dismissed) SELECT id, $2, true FROM surveys WHERE id = $1
       ON CONFLICT (survey_id, user_id) DO NOTHING`, [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

// ---------------- admin ----------------
const guard = [requireAuth, requirePermission('surveys')];

function readSurvey(b) {
  const errors = [];
  const s = {
    title: clean(b.title, 120),
    intro: clean(b.intro, 400) || null,
    audience: AUDIENCES.includes(b.audience) ? b.audience : 'all',
    show_when: WHEN.includes(b.showWhen) ? b.showWhen : 'anytime',
    after_count: Math.max(1, Math.min(1000, Math.round(Number(b.afterCount) || 1))),
    is_active: Boolean(b.isActive)
  };
  if (!s.title) errors.push('Title is required');
  const questions = (Array.isArray(b.questions) ? b.questions : []).slice(0, 25).map((q, i) => {
    const kind = KINDS.includes(q?.kind) ? q.kind : null;
    const label = clean(q?.label, 240);
    const options = (kind === 'choice' || kind === 'multi')
      ? [...new Set((Array.isArray(q.options) ? q.options : []).map((o) => clean(o, 80)).filter(Boolean))].slice(0, 12)
      : [];
    if (!kind) errors.push(`Question ${i + 1}: choose a type`);
    if (!label) errors.push(`Question ${i + 1}: write the question`);
    if ((kind === 'choice' || kind === 'multi') && options.length < 2) errors.push(`Question ${i + 1}: add at least 2 options`);
    return { id: isId(q?.id) ? Number(q.id) : null, kind, label, options, required: q?.required !== false, sort_order: i };
  });
  if (!questions.length) errors.push('Add at least one question');
  return { s, questions, errors };
}

async function saveQuestions(client, surveyId, questions) {
  const keep = questions.filter((q) => q.id).map((q) => q.id);
  await client.query('DELETE FROM survey_questions WHERE survey_id = $1 AND NOT (id = ANY($2::int[]))', [surveyId, keep]);
  for (const q of questions) {
    if (q.id) {
      const u = await client.query(
        'UPDATE survey_questions SET kind = $3, label = $4, options = $5, required = $6, sort_order = $7 WHERE id = $1 AND survey_id = $2',
        [q.id, surveyId, q.kind, q.label, JSON.stringify(q.options), q.required, q.sort_order]);
      if (u.rowCount) continue;
    }
    await client.query(
      'INSERT INTO survey_questions (survey_id, kind, label, options, required, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
      [surveyId, q.kind, q.label, JSON.stringify(q.options), q.required, q.sort_order]);
  }
}

adminRouter.get('/', ...guard, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.*, COALESCE(c.answered, 0)::int AS answered, COALESCE(c.dismissed, 0)::int AS dismissed,
              (SELECT COUNT(*)::int FROM survey_questions q WHERE q.survey_id = s.id) AS questions
       FROM surveys s
       LEFT JOIN (SELECT survey_id, COUNT(*) FILTER (WHERE NOT dismissed) AS answered, COUNT(*) FILTER (WHERE dismissed) AS dismissed
                  FROM survey_responses GROUP BY survey_id) c ON c.survey_id = s.id
       ORDER BY s.id DESC`);
    res.json({ success: true, surveys: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load surveys' });
  }
});

adminRouter.get('/:id', ...guard, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Not found' });
    const r = await pool.query('SELECT * FROM surveys WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, survey: { ...r.rows[0], questions: await questionsOf(r.rows[0].id) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load the survey' });
  }
});

async function upsert(req, res, id) {
  const { s, questions, errors } = readSurvey(req.body || {});
  if (errors.length) return res.status(400).json({ success: false, error: errors.join('. ') });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let surveyId = id;
    if (id) {
      const u = await client.query(
        `UPDATE surveys SET title = $2, intro = $3, audience = $4, show_when = $5, after_count = $6, is_active = $7, updated_at = NOW()
         WHERE id = $1`, [id, s.title, s.intro, s.audience, s.show_when, s.after_count, s.is_active]);
      if (!u.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Not found' }); }
    } else {
      const i = await client.query(
        `INSERT INTO surveys (title, intro, audience, show_when, after_count, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [s.title, s.intro, s.audience, s.show_when, s.after_count, s.is_active]);
      surveyId = i.rows[0].id;
    }
    await saveQuestions(client, surveyId, questions);
    await client.query('COMMIT');
    res.json({ success: true, id: surveyId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save the survey' });
  } finally {
    client.release();
  }
}

adminRouter.post('/', ...guard, (req, res) => upsert(req, res, null));
adminRouter.put('/:id', ...guard, (req, res) => (isId(req.params.id) ? upsert(req, res, Number(req.params.id)) : res.status(404).json({ success: false, error: 'Not found' })));

adminRouter.delete('/:id', ...guard, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Not found' });
    await pool.query('DELETE FROM surveys WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete' });
  }
});

adminRouter.get('/:id/results', ...guard, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Not found' });
    const s = (await pool.query('SELECT * FROM surveys WHERE id = $1', [req.params.id])).rows[0];
    if (!s) return res.status(404).json({ success: false, error: 'Not found' });
    const qs = await questionsOf(s.id);
    const rows = (await pool.query('SELECT answers, created_at FROM survey_responses WHERE survey_id = $1 AND NOT dismissed ORDER BY created_at DESC', [s.id])).rows;
    const dismissed = (await pool.query('SELECT COUNT(*)::int AS n FROM survey_responses WHERE survey_id = $1 AND dismissed', [s.id])).rows[0].n;
    const results = qs.map((q) => {
      const vals = rows.map((r) => r.answers?.[q.id]).filter((v) => v !== undefined && v !== null);
      if (q.kind === 'rating') {
        const dist = [1, 2, 3, 4, 5].map((n) => vals.filter((v) => v === n).length);
        const avg = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
        return { ...q, count: vals.length, average: avg && Math.round(avg * 100) / 100, distribution: dist };
      }
      if (q.kind === 'choice' || q.kind === 'multi') {
        const counts = Object.fromEntries((q.options || []).map((o) => [o, 0]));
        for (const v of vals) for (const o of (Array.isArray(v) ? v : [v])) if (o in counts) counts[o] += 1;
        return { ...q, count: vals.length, counts };
      }
      return { ...q, count: vals.length, answers: vals.slice(0, 200) };
    });
    res.json({ success: true, survey: s, total: rows.length, dismissed, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load results' });
  }
});

const csvCell = (v) => {
  let s = Array.isArray(v) ? v.join('; ') : v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formulas
  return `"${s.replace(/"/g, '""')}"`;
};

adminRouter.get('/:id/export', ...guard, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Not found' });
    const qs = await questionsOf(req.params.id);
    const rows = (await pool.query('SELECT answers, created_at FROM survey_responses WHERE survey_id = $1 AND NOT dismissed ORDER BY created_at', [req.params.id])).rows;
    const lines = [['Answered at', ...qs.map((q) => q.label)].map(csvCell).join(',')];
    for (const r of rows) lines.push([new Date(r.created_at).toISOString(), ...qs.map((q) => r.answers?.[q.id])].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="survey-${req.params.id}.csv"`);
    res.send(`﻿${lines.join('\r\n')}`);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not export' });
  }
});

export default router;