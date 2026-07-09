import { makeAnalysisRouter, rowToDto } from './analysisFactory.js'
import db from '../db.js'
import { getPool, getSource } from '../sources.js'
import { jobToResource } from '../jobResource.js'
import { computePathwayResult } from '../pathway-generation.js'

// Pathway Analysis — /pathway-analysis
// GET /:id/design is the Atlas entrypoint for editing; returns full DTO same as GET /:id.
//
// Execution is real (not a stub): target/event cohorts are references to
// already-generated cohorts, so — like ir-generation.js — the math is
// tractable without CIRCE or ARACHNE. See pathway-generation.js for the
// algorithm and its documented simplifications.
//
// Unlike ir_generation_info (keyed by analysis_id + source_key), Atlas's
// PathwayService addresses a single execution by an opaque generationId
// (GET/POST .../generation/:id). These routes must be registered via
// makeAnalysisRouter's `configure` hook — it runs before the factory adds
// its own generic generation stubs (POST /:id/generation/:sourceKey → 501,
// GET /generation/:generationId → 404, etc.) on the same router, and
// Express dispatches to whichever matching route was registered first.
// Registering afterward (as the /check and /:id/design routes below do)
// would silently be shadowed by those stubs.

function generationToSubmission (row) {
  return {
    id: row.id,
    sourceKey: row.source_key,
    status: row.status,
    startTime: row.start_time,
    endTime: row.end_time,
    hashCode: row.hash_code,
    exitMessage: row.fail_message || null
  }
}

function configure (router) {
  // atlas/js/pages/pathways/PathwayService.js: generate(id, sourceKey) → POST .../{id}/generation/{sourceKey}
  router.post('/:id/generation/:sourceKey', async (req, res) => {
    const analysisId = parseInt(req.params.id, 10)
    const sourceKey = req.params.sourceKey

    const analysisRow = db.prepare('SELECT * FROM pathway_analysis WHERE id = ?').get(analysisId)
    if (!analysisRow) return res.status(404).json({ message: 'Not found' })

    const design = rowToDto(analysisRow)
    const targetCohorts = design.targetCohorts || []
    const eventCohorts = design.eventCohorts || []
    if (!targetCohorts.length || !eventCohorts.length) {
      return res.status(400).json({ message: 'Analysis needs at least one target and one event cohort' })
    }

    let source
    try { source = getSource(sourceKey) } catch { return res.status(404).json({ message: 'Source not found' }) }

    const now = Date.now()
    const login = req.user ? req.user.login : 'anonymous'

    const jobResult = db.prepare(
      `INSERT INTO job (name, type, status, start_time, params) VALUES (?, ?, 'STARTED', ?, ?)`
    ).run(
      `PathwayAnalysisGeneration_${analysisId}_${sourceKey}`,
      'pathwayAnalysisGeneration',
      now,
      JSON.stringify({ pathwayAnalysisId: analysisId, sourceKey })
    )
    const jobId = jobResult.lastInsertRowid
    const jobRow = db.prepare('SELECT * FROM job WHERE id = ?').get(jobId)

    const genResult = db.prepare(
      `INSERT INTO pathway_generation (pathway_analysis_id, source_key, status, start_time, created_by) VALUES (?, ?, 'STARTED', ?, ?)`
    ).run(analysisId, sourceKey, now, login)
    const generationId = genResult.lastInsertRowid

    res.json(jobToResource(jobRow))

    ;(async () => {
      try {
        const pool = getPool(sourceKey)
        const pathwayGroups = []

        for (const target of targetCohorts) {
          const result = await computePathwayResult(pool, {
            resultsSchema: source.resultsSchema,
            targetId: target.id,
            eventCohortIds: eventCohorts.map(c => c.id),
            combinationWindow: design.combinationWindow || 0,
            minCellCount: design.minCellCount || 0,
            maxDepth: design.maxDepth || 5,
            allowRepeats: !!design.allowRepeats
          })
          pathwayGroups.push({
            targetCohortId: target.id,
            targetCohortCount: result.targetCohortCount,
            totalPathwaysCount: result.totalPathwaysCount,
            pathways: result.pathways
          })
        }

        const eventCodes = eventCohorts.map((c, i) => ({ code: Math.pow(2, i), name: c.name, isCombo: false }))
        const resultJson = JSON.stringify({ pathwayGroups, eventCodes })

        db.prepare(
          `UPDATE pathway_generation SET status='COMPLETED', end_time=?, result_json=? WHERE id=?`
        ).run(Date.now(), resultJson, generationId)
        db.prepare(
          `UPDATE job SET status='COMPLETED', exit_status='COMPLETED', end_time=? WHERE id=?`
        ).run(Date.now(), jobId)

        console.log(`[pathway ${analysisId}@${sourceKey}] COMPLETED`)
      } catch (err) {
        console.error(`[pathway ${analysisId}@${sourceKey}] FAILED: ${err.message}`)
        db.prepare(
          `UPDATE pathway_generation SET status='FAILED', end_time=?, fail_message=? WHERE id=?`
        ).run(Date.now(), err.message, generationId)
        db.prepare(
          `UPDATE job SET status='FAILED', exit_status='FAILED', fail_message=?, end_time=? WHERE id=?`
        ).run(err.message, Date.now(), jobId)
      }
    })()
  })

  router.delete('/:id/generation/:sourceKey', (_req, res) => res.sendStatus(200))

  // GET /:id/generation → list executions for the Executions tab
  router.get('/:id/generation', (req, res) => {
    const rows = db.prepare(
      'SELECT * FROM pathway_generation WHERE pathway_analysis_id = ? ORDER BY id DESC'
    ).all(req.params.id)
    res.json(rows.map(generationToSubmission))
  })

  // GET /generation/:generationId → single execution info (overrides the generic 404 stub)
  router.get('/generation/:generationId', (req, res) => {
    const row = db.prepare('SELECT * FROM pathway_generation WHERE id = ?').get(req.params.generationId)
    if (!row) return res.status(404).json({ message: 'Generation not found' })
    res.json(generationToSubmission(row))
  })

  // GET /generation/:generationId/result → the cached pathwayGroups/eventCodes report
  router.get('/generation/:generationId/result', (req, res) => {
    const row = db.prepare('SELECT * FROM pathway_generation WHERE id = ?').get(req.params.generationId)
    if (!row || !row.result_json) return res.json({ pathwayGroups: [], eventCodes: [] })
    res.json(JSON.parse(row.result_json))
  })

  // GET /generation/:generationId/design → design snapshot at time of generation (used by "view design" link)
  router.get('/generation/:generationId/design', (req, res) => {
    const genRow = db.prepare('SELECT * FROM pathway_generation WHERE id = ?').get(req.params.generationId)
    if (!genRow) return res.status(404).json({ message: 'Generation not found' })
    const analysisRow = db.prepare('SELECT * FROM pathway_analysis WHERE id = ?').get(genRow.pathway_analysis_id)
    if (!analysisRow) return res.status(404).json({ message: 'Not found' })
    res.json(rowToDto(analysisRow))
  })

  router.delete('/generation/:generationId', (req, res) => {
    db.prepare('DELETE FROM pathway_generation WHERE id = ?').run(req.params.generationId)
    res.sendStatus(200)
  })

  // POST /check → design diagnostics; return empty warnings ({ warnings: [] } shape required by Atlas warnings.js)
  router.post('/check', (_req, res) => res.json({ warnings: [] }))

  router.get('/:id/design', (req, res) => {
    const row = db.prepare('SELECT * FROM pathway_analysis WHERE id = ?').get(req.params.id)
    if (!row) return res.status(404).json({ message: 'Not found' })
    res.json(rowToDto(row))
  })
}

export default makeAnalysisRouter('pathway_analysis', configure, { paginated: true })
