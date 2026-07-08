import { makeAnalysisRouter, rowToDto } from './analysisFactory.js'
import db from '../db.js'
import config from '../config.js'
import { getPool, getSource } from '../sources.js'
import { jobToResource } from '../jobResource.js'
import { computeIrResult } from '../ir-generation.js'

// IR Analysis — /ir/
// POST /sql and POST /check are 501/[] because full support (including
// strata, which are CIRCE CriteriaGroup expressions) requires CIRCE.
// Execution (/execute, /info, /report) is implemented directly against
// already-generated cohort tables — see ir-generation.js.
//
// All of these are registered via the `configure` callback (run BEFORE
// makeAnalysisRouter's own parameterised routes), because the factory
// already defines a stubbed GET /:id/info — routes added after the
// router is returned would never be reached, since Express dispatches
// to the first handler registered for a given method+path.

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

  // GET /:id/design — full exported design, same shape as GET /:id
  r.get('/:id/design', (req, res) => {
    const row = db.prepare('SELECT * FROM ir_analysis WHERE id = ?').get(req.params.id)
    if (!row) return res.status(404).json({ message: 'Not found' })
    res.json(rowToDto(row))
  })

  // GET /:id/execute/:sourceKey → kick off async IR generation
  r.get('/:id/execute/:sourceKey', async (req, res) => {
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
  r.get('/:id/cancel/:sourceKey', (_req, res) => res.json({ status: 'CANCELED' }))

  // GET /:id/info → generation info across all sources for this analysis
  // (overrides analysisFactory's default GET /:id/info → [] stub)
  r.get('/:id/info', (req, res) => {
    const analysisId = parseInt(req.params.id, 10)
    const infoRows = db.prepare(
      'SELECT * FROM ir_generation_info WHERE ir_analysis_id = ?'
    ).all(analysisId)
    res.json(infoRows.map(row => infoDtoFor(analysisId, row)))
  })

  // GET /:id/info/:sourceKey → single-source generation info + summary
  r.get('/:id/info/:sourceKey', (req, res) => {
    const analysisId = parseInt(req.params.id, 10)
    const infoRow = db.prepare(
      'SELECT * FROM ir_generation_info WHERE ir_analysis_id = ? AND source_key = ?'
    ).get(analysisId, req.params.sourceKey)
    if (!infoRow) return res.status(404).json({ message: 'No results for this source' })
    res.json(infoDtoFor(analysisId, infoRow))
  })

  // DELETE /:id/info/:sourceKey → drop generation results for a source
  r.delete('/:id/info/:sourceKey', (req, res) => {
    const analysisId = parseInt(req.params.id, 10)
    db.prepare('DELETE FROM ir_analysis_result WHERE ir_analysis_id = ? AND source_key = ?').run(analysisId, req.params.sourceKey)
    db.prepare('DELETE FROM ir_generation_info WHERE ir_analysis_id = ? AND source_key = ?').run(analysisId, req.params.sourceKey)
    res.sendStatus(200)
  })

  // GET /:id/report/:sourceKey?targetId=&outcomeId= — per target/outcome report.
  // V1 reports a single "Overall" stratum (see ir-generation.js TODO).
  r.get('/:id/report/:sourceKey', (req, res) => {
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
})

export default router
