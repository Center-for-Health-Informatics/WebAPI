import { Router } from 'express'
import db from '../db.js'
import config from '../config.js'
import { getPool, getSource } from '../sources.js'
import { jobToResource } from '../jobResource.js'
import { computeIrResult } from '../ir-generation.js'

// IR Analysis — /ir/
//
// Unlike prediction/pathway/cohortcharacterization (which share
// analysisFactory.js's generic CRUD and store their whole design
// flattened at the DTO's top level), IR analysis has its own contract:
// atlas/js/services/IRAnalysis.js always sends/expects `expression` as
// a JSON *string* nested under an `expression` key (see its `parse()`
// helper, which unconditionally does `JSON.parse(data.expression)` on
// every GET/POST/PUT/version response). That's why IR doesn't use
// makeAnalysisRouter here — the shared factory's flattening rowToDto
// produced a response with no `expression` key at all, so Atlas's
// parse() crashed with a SyntaxError as soon as an existing analysis
// was reloaded by id (a brand-new unsaved analysis never hits this
// path, which is why this went unnoticed).
//
// POST /sql and POST /check are 501/{warnings:[]} because full support
// (including strata, which are CIRCE CriteriaGroup expressions)
// requires CIRCE. Execution (/execute, /info, /report) is implemented
// directly against already-generated cohort tables — see ir-generation.js.

const router = Router()

function toUserRef (login) {
  if (!login) return null
  return { id: 0, login, name: login }
}

function formatDate (ms) {
  if (!ms) return null
  return new Date(ms).toISOString()
}

function shortDto (row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    createdBy: toUserRef(row.created_by),
    createdDate: formatDate(row.created_date),
    modifiedBy: toUserRef(row.modified_by),
    modifiedDate: formatDate(row.modified_date),
    tags: [],
    hasWriteAccess: true
  }
}

// Full DTO — expression is the raw JSON string, matching IRAnalysis.js's parse()
function fullDto (row) {
  return { ...shortDto(row), expression: row.expression || '{}' }
}

// Atlas always sends expression as a JSON string (ko.toJSON(definition) then
// JSON.stringify(expression) client-side) — but accept a plain object too,
// for robustness against direct/manual API callers.
function normalizeExpression (expression) {
  if (typeof expression === 'string') return expression
  return JSON.stringify(expression || {})
}

function versionToDto (row) {
  return {
    id: row.id,
    entityId: row.entity_id,
    assetId: row.entity_id,
    version: row.version,
    description: row.description || null,
    archived: !!row.is_archived,
    createdBy: toUserRef(row.created_by),
    createdDate: formatDate(row.created_date),
    hasWriteAccess: true
  }
}

// --- CRUD ---

router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM ir_analysis ORDER BY id DESC').all()
  res.json(rows.map(shortDto))
})

router.post('/', (req, res) => {
  const { name, description, expression } = req.body || {}
  if (!name) return res.status(400).json({ message: 'name is required' })
  const user = req.user?.login || 'anonymous'
  const result = db.prepare(
    'INSERT INTO ir_analysis (name, description, expression, created_by) VALUES (?, ?, ?, ?)'
  ).run(name, description || null, normalizeExpression(expression), user)
  const row = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(fullDto(row))
})

router.post('/sql', (_req, res) => res.sendStatus(501))
router.post('/check', (_req, res) => res.json({ warnings: [] }))

// POST /design — import an analysis from an exported design (same shape as GET /:id/design)
router.post('/design', (req, res) => {
  const { name, description, expression } = req.body || {}
  if (!name) return res.status(400).json({ message: 'name is required' })
  const user = req.user?.login || 'anonymous'
  const result = db.prepare(
    'INSERT INTO ir_analysis (name, description, expression, created_by) VALUES (?, ?, ?, ?)'
  ).run(name, description || null, normalizeExpression(expression), user)
  const row = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(fullDto(row))
})

router.get('/:id/exists', (req, res) => {
  const name = req.query.name
  const id = parseInt(req.params.id, 10) || 0
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM ir_analysis WHERE name = ? AND id != ?').get(name, id)
  res.json(row.cnt)
})

router.get('/:id/design', (req, res) => {
  const row = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Not found' })
  res.json(fullDto(row))
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Not found' })
  res.json(fullDto(row))
})

router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Not found' })
  const { name, description, expression } = req.body || {}
  const user = req.user?.login || 'anonymous'
  db.prepare(
    `UPDATE ir_analysis SET name = ?, description = ?, expression = ?, modified_by = ?, modified_date = (unixepoch() * 1000) WHERE id = ?`
  ).run(name || row.name, description !== undefined ? description : row.description, normalizeExpression(expression), user, row.id)
  const updated = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(row.id)
  res.json(fullDto(updated))
})

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM ir_analysis WHERE id = ?').run(req.params.id)
  if (!result.changes) return res.status(404).json({ message: 'Not found' })
  res.sendStatus(200)
})

router.get('/:id/copy', (req, res) => {
  const row = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Not found' })
  const user = req.user?.login || 'anonymous'
  const result = db.prepare(
    'INSERT INTO ir_analysis (name, description, expression, created_by) VALUES (?, ?, ?, ?)'
  ).run(`Copy of ${row.name}`, row.description, row.expression, user)
  const copied = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(fullDto(copied))
})

// --- version endpoints ---

const ENTITY_TYPE = 'ir_analysis'

router.get('/:id/version', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM version WHERE entity_type = ? AND entity_id = ? ORDER BY version DESC'
  ).all(ENTITY_TYPE, req.params.id)
  res.json(rows.map(versionToDto))
})

router.post('/:id/version', (req, res) => {
  const row = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Not found' })
  const user = req.user?.login || 'anonymous'
  const nextVer = ((db.prepare(
    'SELECT MAX(version) AS v FROM version WHERE entity_type = ? AND entity_id = ?'
  ).get(ENTITY_TYPE, row.id))?.v ?? 0) + 1
  db.prepare(
    'INSERT INTO version (entity_type, entity_id, version, expression, description, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(ENTITY_TYPE, row.id, nextVer, row.expression, req.body?.description || null, user)
  const saved = db.prepare(
    'SELECT * FROM version WHERE entity_type = ? AND entity_id = ? AND version = ?'
  ).get(ENTITY_TYPE, row.id, nextVer)
  res.status(201).json(versionToDto(saved))
})

router.get('/:id/version/:ver', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM version WHERE entity_type = ? AND entity_id = ? AND version = ?'
  ).get(ENTITY_TYPE, req.params.id, req.params.ver)
  if (!row) return res.status(404).json({ message: 'Version not found' })
  const defRow = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(req.params.id)
  const entityDTO = defRow ? { ...fullDto(defRow), expression: row.expression || '{}' } : null
  res.json({ entityDTO, versionDTO: versionToDto(row) })
})

router.put('/:id/version/:ver', (req, res) => {
  const { description, archived } = req.body
  const result = db.prepare(
    'UPDATE version SET description = ?, is_archived = ? WHERE entity_type = ? AND entity_id = ? AND version = ?'
  ).run(description || null, archived ? 1 : 0, ENTITY_TYPE, req.params.id, req.params.ver)
  if (!result.changes) return res.status(404).json({ message: 'Version not found' })
  const row = db.prepare(
    'SELECT * FROM version WHERE entity_type = ? AND entity_id = ? AND version = ?'
  ).get(ENTITY_TYPE, req.params.id, req.params.ver)
  res.json(versionToDto(row))
})

router.delete('/:id/version/:ver', (req, res) => {
  const result = db.prepare(
    'DELETE FROM version WHERE entity_type = ? AND entity_id = ? AND version = ?'
  ).run(ENTITY_TYPE, req.params.id, req.params.ver)
  if (!result.changes) return res.status(404).json({ message: 'Version not found' })
  res.sendStatus(200)
})

// --- execution ---

const STATUS_MAP = { STARTED: 'RUNNING', COMPLETED: 'COMPLETE', CANCELED: 'FAILED' }

function sourceIdFor (sourceKey) {
  const idx = config.sources.findIndex(s => s.sourceKey === sourceKey)
  return idx >= 0 ? idx + 1 : 0
}

function summaryListFor (analysisId, sourceKey) {
  const rows = db.prepare(
    'SELECT * FROM ir_analysis_result WHERE ir_analysis_id = ? AND source_key = ?'
  ).all(analysisId, sourceKey)
  return rows.map(row => ({
    targetId: row.target_id,
    outcomeId: row.outcome_id,
    totalPersons: row.total_persons,
    cases: row.cases,
    timeAtRisk: row.time_at_risk
  }))
}

function infoDtoFor (analysisId, infoRow) {
  return {
    executionInfo: {
      id: { analysisId, sourceId: sourceIdFor(infoRow.source_key) },
      status: STATUS_MAP[infoRow.status] ?? infoRow.status,
      startTime: infoRow.start_time,
      executionDuration: infoRow.execution_duration,
      message: infoRow.fail_message || null
    },
    summaryList: summaryListFor(analysisId, infoRow.source_key)
  }
}

// GET /:id/execute/:sourceKey → kick off async IR generation
router.get('/:id/execute/:sourceKey', async (req, res) => {
  const analysisId = parseInt(req.params.id, 10)
  const sourceKey = req.params.sourceKey

  const analysisRow = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(analysisId)
  if (!analysisRow) return res.status(404).json({ message: 'Not found' })

  let expression = {}
  try { expression = JSON.parse(analysisRow.expression || '{}') } catch { /* ignore */ }
  const targetIds = expression.targetIds || []
  const outcomeIds = expression.outcomeIds || []
  if (!targetIds.length || !outcomeIds.length) {
    return res.status(400).json({ message: 'Analysis needs at least one target and one outcome cohort' })
  }

  let source
  try { source = getSource(sourceKey) } catch { return res.status(404).json({ message: 'Source not found' }) }

  const now = Date.now()
  const login = req.user ? req.user.login : 'anonymous'
  const jobResult = db.prepare(
    `INSERT INTO job (name, type, status, start_time, params) VALUES (?, ?, 'STARTED', ?, ?)`
  ).run(
    `IrAnalysisGeneration_${analysisId}_${sourceKey}`,
    'irAnalysisGeneration',
    now,
    JSON.stringify({ irAnalysisId: analysisId, sourceKey })
  )
  const jobId = jobResult.lastInsertRowid
  const jobRow = db.prepare('SELECT * FROM job WHERE id = ?').get(jobId)

  db.prepare(`
    INSERT INTO ir_generation_info (ir_analysis_id, source_key, status, start_time, created_by)
    VALUES (?, ?, 'STARTED', ?, ?)
    ON CONFLICT(ir_analysis_id, source_key) DO UPDATE SET
      status = 'STARTED', start_time = excluded.start_time, fail_message = NULL, execution_duration = NULL
  `).run(analysisId, sourceKey, now, login)

  res.json(jobToResource(jobRow))

  ;(async () => {
    const startMs = Date.now()
    try {
      const pool = getPool(sourceKey)
      const deleteResults = db.prepare(
        'DELETE FROM ir_analysis_result WHERE ir_analysis_id = ? AND source_key = ?'
      )
      const insertResult = db.prepare(`
        INSERT INTO ir_analysis_result (ir_analysis_id, source_key, target_id, outcome_id, total_persons, cases, time_at_risk)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ir_analysis_id, source_key, target_id, outcome_id) DO UPDATE SET
          total_persons = excluded.total_persons, cases = excluded.cases, time_at_risk = excluded.time_at_risk
      `)

      deleteResults.run(analysisId, sourceKey)

      for (const targetId of targetIds) {
        for (const outcomeId of outcomeIds) {
          const result = await computeIrResult(pool, {
            resultsSchema: source.resultsSchema,
            cdmSchema: source.cdmSchema,
            targetId,
            outcomeId,
            timeAtRisk: expression.timeAtRisk,
            studyWindow: expression.studyWindow
          })
          insertResult.run(analysisId, sourceKey, targetId, outcomeId, result.totalPersons, result.cases, result.timeAtRisk)
        }
      }

      const duration = Date.now() - startMs
      db.prepare(
        `UPDATE ir_generation_info SET status='COMPLETED', execution_duration=? WHERE ir_analysis_id=? AND source_key=?`
      ).run(duration, analysisId, sourceKey)
      db.prepare(
        `UPDATE job SET status='COMPLETED', exit_status='COMPLETED', end_time=? WHERE id=?`
      ).run(Date.now(), jobId)

      console.log(`[ir ${analysisId}@${sourceKey}] COMPLETED (${duration}ms)`)
    } catch (err) {
      const duration = Date.now() - startMs
      console.error(`[ir ${analysisId}@${sourceKey}] FAILED: ${err.message}`)
      db.prepare(
        `UPDATE ir_generation_info SET status='FAILED', execution_duration=?, fail_message=? WHERE ir_analysis_id=? AND source_key=?`
      ).run(duration, err.message, analysisId, sourceKey)
      db.prepare(
        `UPDATE job SET status='FAILED', exit_status='FAILED', fail_message=?, end_time=? WHERE id=?`
      ).run(err.message, Date.now(), jobId)
    }
  })()
})

// GET /:id/cancel/:sourceKey → stub
router.get('/:id/cancel/:sourceKey', (_req, res) => res.json({ status: 'CANCELED' }))

// GET /:id/info → generation info across all sources for this analysis
router.get('/:id/info', (req, res) => {
  const analysisId = parseInt(req.params.id, 10)
  const infoRows = db.prepare(
    'SELECT * FROM ir_generation_info WHERE ir_analysis_id = ?'
  ).all(analysisId)
  res.json(infoRows.map(row => infoDtoFor(analysisId, row)))
})

// GET /:id/info/:sourceKey → single-source generation info + summary
router.get('/:id/info/:sourceKey', (req, res) => {
  const analysisId = parseInt(req.params.id, 10)
  const infoRow = db.prepare(
    'SELECT * FROM ir_generation_info WHERE ir_analysis_id = ? AND source_key = ?'
  ).get(analysisId, req.params.sourceKey)
  if (!infoRow) return res.status(404).json({ message: 'No results for this source' })
  res.json(infoDtoFor(analysisId, infoRow))
})

// DELETE /:id/info/:sourceKey → drop generation results for a source
router.delete('/:id/info/:sourceKey', (req, res) => {
  const analysisId = parseInt(req.params.id, 10)
  db.prepare('DELETE FROM ir_analysis_result WHERE ir_analysis_id = ? AND source_key = ?').run(analysisId, req.params.sourceKey)
  db.prepare('DELETE FROM ir_generation_info WHERE ir_analysis_id = ? AND source_key = ?').run(analysisId, req.params.sourceKey)
  res.sendStatus(200)
})

// GET /:id/report/:sourceKey?targetId=&outcomeId= — per target/outcome report.
// V1 reports a single "Overall" stratum (see ir-generation.js TODO).
router.get('/:id/report/:sourceKey', (req, res) => {
  const analysisId = parseInt(req.params.id, 10)
  const targetId = parseInt(req.query.targetId, 10)
  const outcomeId = parseInt(req.query.outcomeId, 10)

  const row = db.prepare(
    'SELECT * FROM ir_analysis_result WHERE ir_analysis_id = ? AND source_key = ? AND target_id = ? AND outcome_id = ?'
  ).get(analysisId, req.params.sourceKey, targetId, outcomeId)

  if (!row) {
    return res.json({
      summary: { totalPersons: 0, cases: 0, timeAtRisk: 0 },
      stratifyStats: [],
      treemapData: JSON.stringify({ name: [], size: 0, cases: 0, timeAtRisk: 0, children: [] })
    })
  }

  const summary = { totalPersons: row.total_persons, cases: row.cases, timeAtRisk: row.time_at_risk }
  res.json({
    summary,
    stratifyStats: [{ id: 0, name: 'Overall', ...summary }],
    treemapData: JSON.stringify({ name: [], size: summary.totalPersons, cases: summary.cases, timeAtRisk: summary.timeAtRisk, children: [] })
  })
})

export default router
