import { Router } from 'express'
import db from '../db.js'
import { formatDate, toUserRef, rowToShortDto } from './analysisFactory.js'

// Reusables — /reusable
//
// A "reusable" is a named, reusable fragment of a cohort-definition expression
// (a criteria group, or an initial/censoring event definition) that can be
// referenced from multiple cohort designs. Unlike cc_analysis/ir_analysis/etc,
// reusables are never "generated" against a CDM source, so this router does
// NOT reuse makeAnalysisRouter() (which bakes in /generation stubs) — it's a
// small, purpose-built router instead.
//
// Storage: the `reusable` table's `expression` column holds the raw JSON
// string produced client-side by Reusable.js / ReusablesService (the `data`
// property). The Atlas Reusable model expects the top-level API response to
// carry that same raw JSON string back under a `data` key (it does its own
// JSON.parse on load) — so responses here are NOT spread/flattened the way
// analysisFactory's rowToDto() flattens cc_analysis/etc rows.

const ENTITY_TYPE = 'reusable'

function reusableToDto (row) {
  return {
    ...rowToShortDto(row),
    data: row.expression || null
  }
}

function versionToDto (row) {
  return {
    id: row.id,
    entityId: row.entity_id,
    // Atlas's ReusablesService.updateVersion() (and every sibling *Service.js
    // updateVersion) builds its PUT url from `version.assetId`, not
    // `entityId` — include both so the version-comment editing flow works.
    assetId: row.entity_id,
    version: row.version,
    comment: row.description || null,
    archived: !!row.is_archived,
    createdBy: toUserRef(row.created_by),
    createdDate: formatDate(row.created_date),
    hasWriteAccess: true
  }
}

const router = Router()

// GET / — list (Atlas requests ?size=10000; we ignore paging and return everything)
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM reusable ORDER BY id DESC').all()
  res.json({ content: rows.map(reusableToDto) })
})

// POST / — create
router.post('/', (req, res) => {
  const { name, description, data } = req.body || {}
  if (!name) return res.status(400).json({ message: 'name is required' })
  const user = req.user?.login || 'anonymous'
  const result = db.prepare(
    'INSERT INTO reusable (name, description, expression, created_by) VALUES (?, ?, ?, ?)'
  ).run(name, description || null, data || null, user)
  const row = db.prepare('SELECT * FROM reusable WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(reusableToDto(row))
})

// GET /:id/exists?name=... — name-uniqueness check (excludes the entity itself)
router.get('/:id/exists', (req, res) => {
  const { name } = req.query
  if (!name) return res.json(false)
  const existing = db.prepare(
    'SELECT id FROM reusable WHERE name = ? AND id != ?'
  ).get(name, req.params.id)
  res.json(!!existing)
})

// --- version endpoints (registered before /:id so they win on path specificity) ---

// GET /:id/version/ — list of version snapshots
router.get('/:id/version', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM version WHERE entity_type = ? AND entity_id = ? ORDER BY version DESC'
  ).all(ENTITY_TYPE, req.params.id)
  res.json(rows.map(versionToDto))
})

// POST /:id/version — explicit snapshot save (not currently called by Atlas's
// ReusablesService, but kept for parity with cohortdefinition/analysisFactory
// so version history can be seeded server-side if ever needed)
router.post('/:id/version', (req, res) => {
  const row = db.prepare('SELECT * FROM reusable WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Not found' })
  const user = req.user?.login || 'anonymous'
  const nextVer = ((db.prepare(
    'SELECT MAX(version) AS v FROM version WHERE entity_type = ? AND entity_id = ?'
  ).get(ENTITY_TYPE, row.id))?.v ?? 0) + 1
  db.prepare(
    'INSERT INTO version (entity_type, entity_id, version, expression, description, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(ENTITY_TYPE, row.id, nextVer, row.expression, req.body?.comment || null, user)
  const saved = db.prepare(
    'SELECT * FROM version WHERE entity_type = ? AND entity_id = ? AND version = ?'
  ).get(ENTITY_TYPE, row.id, nextVer)
  res.status(201).json(versionToDto(saved))
})

// PUT /:id/version/:ver/createAsset — create a brand-new reusable entity from
// an archived version snapshot (Atlas routes to the returned entity's id).
router.put('/:id/version/:ver/createAsset', (req, res) => {
  const versionRow = db.prepare(
    'SELECT * FROM version WHERE entity_type = ? AND entity_id = ? AND version = ?'
  ).get(ENTITY_TYPE, req.params.id, req.params.ver)
  if (!versionRow) return res.status(404).json({ message: 'Version not found' })
  const original = db.prepare('SELECT * FROM reusable WHERE id = ?').get(req.params.id)
  if (!original) return res.status(404).json({ message: 'Not found' })
  const user = req.user?.login || 'anonymous'
  const result = db.prepare(
    'INSERT INTO reusable (name, description, expression, created_by) VALUES (?, ?, ?, ?)'
  ).run(`${original.name} (v${versionRow.version})`, original.description, versionRow.expression, user)
  const row = db.prepare('SELECT * FROM reusable WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(reusableToDto(row))
})

// PUT /:id/version/:ver — update a version's comment/archived flag
router.put('/:id/version/:ver', (req, res) => {
  const { comment, archived } = req.body || {}
  const result = db.prepare(
    'UPDATE version SET description = ?, is_archived = ? WHERE entity_type = ? AND entity_id = ? AND version = ?'
  ).run(comment || null, archived ? 1 : 0, ENTITY_TYPE, req.params.id, req.params.ver)
  if (!result.changes) return res.status(404).json({ message: 'Version not found' })
  const row = db.prepare(
    'SELECT * FROM version WHERE entity_type = ? AND entity_id = ? AND version = ?'
  ).get(ENTITY_TYPE, req.params.id, req.params.ver)
  res.json(versionToDto(row))
})

// GET /:id/version/:ver — preview a specific version (entity + version metadata)
router.get('/:id/version/:ver', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM version WHERE entity_type = ? AND entity_id = ? AND version = ?'
  ).get(ENTITY_TYPE, req.params.id, req.params.ver)
  if (!row) return res.status(404).json({ message: 'Version not found' })
  const defRow = db.prepare('SELECT * FROM reusable WHERE id = ?').get(req.params.id)
  const entityDTO = defRow ? { ...reusableToDto(defRow), data: row.expression || null } : null
  res.json({ entityDTO, versionDTO: versionToDto(row) })
})

// DELETE /:id/version/:ver
router.delete('/:id/version/:ver', (req, res) => {
  const result = db.prepare(
    'DELETE FROM version WHERE entity_type = ? AND entity_id = ? AND version = ?'
  ).run(ENTITY_TYPE, req.params.id, req.params.ver)
  if (!result.changes) return res.status(404).json({ message: 'Version not found' })
  res.sendStatus(200)
})

// POST /:id — copy (ReusablesService.copy posts to the entity's own url with no body)
router.post('/:id', (req, res) => {
  const original = db.prepare('SELECT * FROM reusable WHERE id = ?').get(req.params.id)
  if (!original) return res.status(404).json({ message: 'Not found' })
  const user = req.user?.login || 'anonymous'
  const result = db.prepare(
    'INSERT INTO reusable (name, description, expression, created_by) VALUES (?, ?, ?, ?)'
  ).run(`Copy of ${original.name}`, original.description, original.expression, user)
  const row = db.prepare('SELECT * FROM reusable WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(reusableToDto(row))
})

// GET /:id — load
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM reusable WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Not found' })
  res.json(reusableToDto(row))
})

// PUT /:id — save
router.put('/:id', (req, res) => {
  const { name, description, data } = req.body || {}
  const user = req.user?.login || 'anonymous'
  const result = db.prepare(
    'UPDATE reusable SET name = ?, description = ?, expression = ?, modified_by = ?, modified_date = ? WHERE id = ?'
  ).run(name || null, description || null, data || null, user, Date.now(), req.params.id)
  if (!result.changes) return res.status(404).json({ message: 'Not found' })
  const row = db.prepare('SELECT * FROM reusable WHERE id = ?').get(req.params.id)
  res.json(reusableToDto(row))
})

// DELETE /:id
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM reusable WHERE id = ?').run(req.params.id)
  if (!result.changes) return res.status(404).json({ message: 'Not found' })
  res.sendStatus(200)
})

export default router
