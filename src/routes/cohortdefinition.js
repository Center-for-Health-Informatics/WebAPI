import { Router } from 'express'
import mssql from 'mssql'
import db from '../db.js'
import config from '../config.js'
import { getPool, getSource } from '../sources.js'
import { jobToResource } from '../jobResource.js'
import { generateCohortSql } from '../circe.js'

const router = Router()

// --- helpers ---

function formatDate (ms) {
  if (!ms) return null
  return new Date(ms).toISOString()
}

function toUserRef (login) {
  if (!login) return null
  return { id: 0, login, name: login }
}

function rowToDto (row, includeExpression = false) {
  const dto = {
    id: row.id,
    name: row.name,
    description: row.description || null,
    expressionType: row.expression_type || 'SIMPLE_EXPRESSION',
    createdBy: toUserRef(row.created_by),
    createdDate: formatDate(row.created_date),
    modifiedBy: toUserRef(row.modified_by),
    modifiedDate: formatDate(row.modified_date),
    tags: [],
    hasReadAccess: true,
    hasWriteAccess: true
  }

  if (includeExpression) {
    const detail = db.prepare('SELECT expression FROM cohort_definition_details WHERE id = ?').get(row.id)
    // Atlas calls JSON.parse(cohortDef.expression) itself — return the raw string, not a parsed object
    dto.expression = detail?.expression || null
  }

  return dto
}

// --- static routes (before /:id) ---

// POST /sql → generate SQL for display (no execution)
router.post('/sql', async (req, res, next) => {
  try {
    const { expression } = req.body || {}
    if (!expression) return res.status(400).json({ message: 'expression required' })
    const source = config.sources[0]
    if (!source) return res.status(500).json({ message: 'No CDM source configured' })
    const sql = await generateCohortSql(expression, {
      cohortId: 0,
      cdmSchema: source.cdmSchema,
      targetTable: `${source.resultsSchema}.cohort`,
      resultSchema: source.resultsSchema,
      vocabularySchema: source.vocabSchema
    })
    res.json({ templateSql: sql })
  } catch (err) { next(err) }
})

// POST /check, /checkV2 → return empty warnings ({ warnings: [] } shape required by Atlas warnings.js)
router.post('/check', (_req, res) => res.json({ warnings: [] }))
router.post('/checkV2', (_req, res) => res.json({ warnings: [] }))

// POST /printfriendly/cohort → minimal HTML placeholder (Atlas displays this in the "Text View" export tab)
router.post('/printfriendly/cohort', (_req, res) => {
  res.type('text/html').send('<p>Print-friendly view not implemented. Use Export &rarr; SQL to view generated SQL.</p>')
})
router.post('/printfriendly/conceptsets', (_req, res) => {
  res.type('text/html').send('<p>Print-friendly view not implemented.</p>')
})

// GET /
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM cohort_definition ORDER BY id DESC').all()
  res.json(rows.map(r => rowToDto(r, false)))
})

// POST /
router.post('/', (req, res) => {
  const { name, description, expression, expressionType } = req.body || {}
  if (!name) return res.status(400).json({ message: 'name is required' })
  const login = req.user ? req.user.login : 'anonymous'

  const insertDef = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO cohort_definition (name, description, expression_type, created_by) VALUES (?, ?, ?, ?)`
    ).run(name, description || null, expressionType || 'SIMPLE_EXPRESSION', login)
    const id = result.lastInsertRowid
    db.prepare(
      `INSERT INTO cohort_definition_details (id, expression) VALUES (?, ?)`
    ).run(id, expression ? JSON.stringify(expression) : null)
    return id
  })

  const id = insertDef()
  const row = db.prepare('SELECT * FROM cohort_definition WHERE id = ?').get(id)
  res.status(201).json(rowToDto(row, true))
})

// --- parameterised routes ---

// GET /:id/exists?name=...
router.get('/:id/exists', (req, res) => {
  const name = req.query.name
  const id = parseInt(req.params.id, 10) || 0
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM cohort_definition WHERE name = ? AND id != ?').get(name, id)
  res.json(row.cnt)
})

// GET /:id
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM cohort_definition WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Cohort definition not found' })
  res.json(rowToDto(row, true))
})

// PUT /:id
router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM cohort_definition WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Cohort definition not found' })
  const { name, description, expression, expressionType } = req.body || {}
  const login = req.user ? req.user.login : 'anonymous'

  db.transaction(() => {
    db.prepare(
      `UPDATE cohort_definition SET name = ?, description = ?, expression_type = ?,
       modified_by = ?, modified_date = (unixepoch() * 1000) WHERE id = ?`
    ).run(
      name || row.name,
      description !== undefined ? description : row.description,
      expressionType || row.expression_type || 'SIMPLE_EXPRESSION',
      login,
      row.id
    )
    db.prepare(
      `INSERT INTO cohort_definition_details (id, expression) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET expression = excluded.expression`
    ).run(row.id, expression ? JSON.stringify(expression) : null)
  })()

  const updated = db.prepare('SELECT * FROM cohort_definition WHERE id = ?').get(row.id)
  res.json(rowToDto(updated, true))
})

// DELETE /:id
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM cohort_definition WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Cohort definition not found' })
  db.prepare('DELETE FROM cohort_definition WHERE id = ?').run(row.id)
  res.sendStatus(204)
})

// GET /:id/copy
router.get('/:id/copy', (req, res) => {
  const row = db.prepare('SELECT * FROM cohort_definition WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Cohort definition not found' })
  const detail = db.prepare('SELECT expression FROM cohort_definition_details WHERE id = ?').get(row.id)
  const login = req.user ? req.user.login : 'anonymous'

  const newId = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO cohort_definition (name, description, expression_type, created_by) VALUES (?, ?, ?, ?)`
    ).run(`Copy of ${row.name}`, row.description, row.expression_type || 'SIMPLE_EXPRESSION', login)
    const id = result.lastInsertRowid
    db.prepare(
      `INSERT INTO cohort_definition_details (id, expression) VALUES (?, ?)`
    ).run(id, detail ? detail.expression : null)
    return id
  })()

  const copied = db.prepare('SELECT * FROM cohort_definition WHERE id = ?').get(newId)
  res.json(rowToDto(copied, true))
})

const STATUS_MAP = { STARTED: 'RUNNING', COMPLETED: 'COMPLETE', CANCELED: 'FAILED' }

// GET /:id/info (generation status)
router.get('/:id/info', (req, res) => {
  const row = db.prepare('SELECT id FROM cohort_definition WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Cohort definition not found' })
  const infos = db.prepare('SELECT * FROM cohort_generation_info WHERE cohort_definition_id = ?').all(row.id)
  res.json(infos.map(i => {
    // sourceId must be the integer used by /source (index + 1), not the sourceKey string
    const srcIdx = config.sources.findIndex(s => s.sourceKey === i.source_key)
    const sourceId = srcIdx >= 0 ? srcIdx + 1 : 0
    return {
      id: { cohortDefinitionId: i.cohort_definition_id, sourceId },
      status: STATUS_MAP[i.status] ?? i.status,
      startTime: i.start_time,
      executionDuration: i.execution_duration,
      isValid: Boolean(i.is_valid),
      isCanceled: Boolean(i.is_canceled),
      failMessage: i.fail_message || null,
      personCount: i.person_count,
      recordCount: i.record_count,
      createdBy: null
    }
  }))
})

// GET /:id/generate/:sourceKey → kick off async cohort generation
router.get('/:id/generate/:sourceKey', async (req, res, next) => {
  const cohortId = parseInt(req.params.id, 10)
  const sourceKey = req.params.sourceKey

  const defRow = db.prepare('SELECT id FROM cohort_definition WHERE id = ?').get(cohortId)
  if (!defRow) return res.status(404).json({ message: 'Cohort definition not found' })

  const detail = db.prepare('SELECT expression FROM cohort_definition_details WHERE id = ?').get(cohortId)
  if (!detail?.expression) return res.status(400).json({ message: 'Cohort has no expression' })

  let source
  try { source = getSource(sourceKey) } catch { return res.status(404).json({ message: 'Source not found' }) }

  const now = Date.now()
  const jobResult = db.prepare(
    `INSERT INTO job (name, type, status, start_time, params) VALUES (?, ?, 'STARTED', ?, ?)`
  ).run(
    `GenerateCohort_${cohortId}_${sourceKey}`,
    'cohortDefinitionGeneration',
    now,
    JSON.stringify({ cohortDefinitionId: cohortId, sourceKey })
  )
  const jobId = jobResult.lastInsertRowid
  const jobRow = db.prepare('SELECT * FROM job WHERE id = ?').get(jobId)

  db.prepare(`
    INSERT INTO cohort_generation_info
      (cohort_definition_id, source_key, status, start_time, is_valid, is_canceled)
    VALUES (?, ?, 'STARTED', ?, 0, 0)
    ON CONFLICT(cohort_definition_id, source_key) DO UPDATE SET
      status = 'STARTED', start_time = excluded.start_time, fail_message = NULL,
      is_canceled = 0, person_count = NULL, record_count = NULL, execution_duration = NULL
  `).run(cohortId, sourceKey, now)

  res.json(jobToResource(jobRow))

  ;(async () => {
    const startMs = Date.now()
    try {
      const expression = JSON.parse(detail.expression)
      const targetTable = `${source.resultsSchema}.cohort`

      console.log(`[cohort ${cohortId}@${sourceKey}] Generating SQL...`)
      const cohortSql = await generateCohortSql(expression, {
        cohortId,
        cdmSchema: source.cdmSchema,
        targetTable,
        resultSchema: source.resultsSchema,
        vocabularySchema: source.vocabSchema
      })

      console.log(`[cohort ${cohortId}@${sourceKey}] Executing...`)
      const execCfg = source.connectionString
        ? { connectionString: source.connectionString, requestTimeout: 0 }
        : {
            server: source.server, port: source.port || 1433,
            database: source.database, user: source.username, password: source.password,
            options: { encrypt: source.encrypt !== false, trustServerCertificate: source.trustServerCertificate || false, enableArithAbort: true },
            requestTimeout: 0, pool: { max: 1, min: 0, idleTimeoutMillis: 5000 }
          }
      const execPool = await new mssql.ConnectionPool(execCfg).connect()
      try {
        await execPool.request().query(cohortSql)
      } finally {
        await execPool.close()
      }

      const countResult = await getPool(sourceKey).request().query(
        `SELECT COUNT(DISTINCT subject_id) AS person_count, COUNT(*) AS record_count
         FROM ${targetTable} WHERE cohort_definition_id = ${cohortId}`
      )
      const { person_count, record_count } = countResult.recordset[0]
      const duration = Date.now() - startMs

      db.prepare(
        `UPDATE cohort_generation_info SET status='COMPLETED', execution_duration=?,
         is_valid=1, person_count=?, record_count=?
         WHERE cohort_definition_id=? AND source_key=?`
      ).run(duration, person_count, record_count, cohortId, sourceKey)
      db.prepare(
        `UPDATE job SET status='COMPLETED', exit_status='COMPLETED', end_time=? WHERE id=?`
      ).run(Date.now(), jobId)

      console.log(`[cohort ${cohortId}@${sourceKey}] COMPLETED: ${person_count} persons, ${record_count} records (${duration}ms)`)
    } catch (err) {
      const duration = Date.now() - startMs
      console.error(`[cohort ${cohortId}@${sourceKey}] FAILED: ${err.message}`)
      db.prepare(
        `UPDATE cohort_generation_info SET status='FAILED', execution_duration=?, fail_message=?
         WHERE cohort_definition_id=? AND source_key=?`
      ).run(duration, err.message, cohortId, sourceKey)
      db.prepare(
        `UPDATE job SET status='FAILED', exit_status='FAILED', fail_message=?, end_time=? WHERE id=?`
      ).run(err.message, Date.now(), jobId)
    }
  })()
})

// GET /:id/cancel/:sourceKey → stub
router.get('/:id/cancel/:sourceKey', (req, res) => {
  res.json({ status: 'CANCELED' })
})

// GET /:id/report/:sourceKey → 501
router.get('/:id/report/:sourceKey', (_req, res) => res.sendStatus(501))

// GET /:id/export/conceptset → stub
router.get('/:id/export/conceptset', (_req, res) => res.sendStatus(501))

// POST /:id/tag/
router.post('/:id/tag/', (req, res) => res.sendStatus(204))

// DELETE /:id/tag/:tagId
router.delete('/:id/tag/:tagId', (_req, res) => res.sendStatus(204))

// --- version endpoints ---

const ENTITY_TYPE = 'cohort_definition'

function versionToDto (row) {
  return {
    id: row.id,
    entityId: row.entity_id,
    version: row.version,
    description: row.description || null,
    archived: !!row.is_archived,
    createdBy: toUserRef(row.created_by),
    createdDate: formatDate(row.created_date),
    hasWriteAccess: true
  }
}

router.get('/:id/version', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM version WHERE entity_type = ? AND entity_id = ? ORDER BY version DESC'
  ).all(ENTITY_TYPE, req.params.id)
  res.json(rows.map(versionToDto))
})

router.post('/:id/version', (req, res) => {
  const row = db.prepare('SELECT * FROM cohort_definition WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Not found' })
  const detail = db.prepare('SELECT expression FROM cohort_definition_details WHERE id = ?').get(row.id)
  const user = req.user?.login || 'anonymous'
  const nextVer = ((db.prepare(
    'SELECT MAX(version) AS v FROM version WHERE entity_type = ? AND entity_id = ?'
  ).get(ENTITY_TYPE, row.id))?.v ?? 0) + 1
  db.prepare(
    'INSERT INTO version (entity_type, entity_id, version, expression, description, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(ENTITY_TYPE, row.id, nextVer, detail?.expression || null, req.body?.description || null, user)
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
  const defRow = db.prepare('SELECT * FROM cohort_definition WHERE id = ?').get(req.params.id)
  // Atlas calls JSON.parse(entityDTO.expression) — return expression as raw string from version snapshot
  const entityDTO = defRow ? { ...rowToDto(defRow), expression: row.expression || null } : null
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

export default router
