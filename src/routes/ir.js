import { makeAnalysisRouter, rowToDto } from './analysisFactory.js'
import db from '../db.js'

// IR Analysis — /ir/
// POST /sql and POST /check are 501/[] because cohort SQL generation requires CIRCE.
// All generation/report endpoints stub-out; Atlas will show "no results" state.

const router = makeAnalysisRouter('ir_analysis', (r) => {
  r.post('/sql', (_req, res) => res.sendStatus(501))
  r.post('/check', (_req, res) => res.json([]))

  // POST /design — import an analysis from an exported design JSON (same as create)
  r.post('/design', (req, res) => {
    const { name, description, ...rest } = req.body
    if (!name) return res.status(400).json({ message: 'name is required' })
    const user = req.user?.login || 'anonymous'
    const result = db.prepare(
      'INSERT INTO ir_analysis (name, description, expression, created_by) VALUES (?, ?, ?, ?)'
    ).run(name, description || null, JSON.stringify(rest), user)
    const row = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(result.lastInsertRowid)
    res.status(201).json(rowToDto(row))
  })
})

// GET /:id/design — full exported design, same shape as GET /:id
router.get('/:id/design', (req, res) => {
  const row = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Not found' })
  res.json(rowToDto(row))
})

// Per-analysis report — Atlas requests this after generation; return empty shape
router.get('/:id/report/:sourceKey', (_req, res) => res.json({ treemap: null, results: [] }))

export default router
