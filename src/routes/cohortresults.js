import { Router } from 'express'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname, basename } from 'path'
import { getSource, getPool } from '../sources.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SQL_DIR = join(__dirname, '../sql/cohortresults')

// Cohort Results (Heracles) — /cohortresults
// All endpoints query Heracles pre-computed results tables.
// Since cohort generation returns 501, these tables are typically empty;
// endpoints return empty arrays/objects rather than erroring.

const router = Router()


function renderSql (sql, source, cohortId, extraParams = {}) {
  const params = {
    ohdsi_database_schema: source.resultsSchema,
    cdm_database_schema: source.cdmSchema,
    vocab_database_schema: source.vocabSchema,
    vocabulary_database_schema: source.vocabSchema,
    results_database_schema: source.resultsSchema,
    cohortDefinitionId: String(cohortId),
    ...extraParams
  }
  return Object.entries(params).reduce((s, [k, v]) => {
    return s.replace(new RegExp(`@${k}\\b`, 'gi'), v ?? '')
  }, sql)
}

function normKey (name) {
  return name.replace(/^sql/i, '').replace(/^[A-Z]/, c => c.toLowerCase())
}

async function runSql (pool, sql) {
  const result = await pool.request().query(sql)
  return result.recordset || []
}

async function runFile (source, relPath, cohortId, extraParams = {}) {
  const sql = readFileSync(join(SQL_DIR, relPath), 'utf8')
  return runSql(getPool(source.sourceKey), renderSql(sql, source, cohortId, extraParams))
}

async function runDirectory (source, relDir, cohortId, extraParams = {}) {
  let files
  try { files = readdirSync(join(SQL_DIR, relDir)).filter(f => f.endsWith('.sql')) } catch { return {} }
  const result = {}
  await Promise.all(files.map(async f => {
    const key = normKey(basename(f, '.sql'))
    try { result[key] = await runFile(source, `${relDir}/${f}`, cohortId, extraParams) } catch { result[key] = [] }
  }))
  return result
}

// --- helpers ---

function source404 (sourceKey, res) {
  try {
    return getSource(sourceKey)
  } catch {
    res.status(404).json({ message: `Source not found: ${sourceKey}` })
    return null
  }
}

// --- routes ---

// POST /:sourceKey/warmup — cache-warming stub
router.post('/:sourceKey/warmup', (_req, res) => res.json({ status: 'complete' }))

// GET /:sourceKey/:id/analyses — list of completed Heracles analysis IDs
router.get('/:sourceKey/:id/analyses', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  try {
    const sql = renderSql(
      `SELECT DISTINCT analysis_id FROM @ohdsi_database_schema.heracles_results WHERE cohort_definition_id = @cohortDefinitionId`,
      src, req.params.id
    )
    const rows = await runSql(getPool(src.sourceKey), sql)
    res.json(rows.map(r => r.analysis_id))
  } catch { res.json([]) }
})

// GET /:sourceKey/:id/completed — same as analyses but as strings
router.get('/:sourceKey/:id/completed', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  try {
    const sql = renderSql(
      `SELECT DISTINCT analysis_id FROM @ohdsi_database_schema.heracles_results WHERE cohort_definition_id = @cohortDefinitionId`,
      src, req.params.id
    )
    const rows = await runSql(getPool(src.sourceKey), sql)
    res.json(rows.map(r => String(r.analysis_id)))
  } catch { res.json([]) }
})

// GET /:sourceKey/:id/info — generation info stub
router.get('/:sourceKey/:id/info', (_req, res) => res.json([]))

// GET /:sourceKey/:id/summaryanalyses — completed summary analysis IDs
router.get('/:sourceKey/:id/summaryanalyses', (_req, res) => res.json([]))

// GET /:sourceKey/:id/dashboard — person demographics summary
router.get('/:sourceKey/:id/dashboard', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  const id = req.params.id
  try {
    const [gender, race, ethnicity, yearOfBirth, yearOfBirthStats] = await Promise.all([
      runFile(src, 'person/gender.sql', id).catch(() => []),
      runFile(src, 'person/race.sql', id).catch(() => []),
      runFile(src, 'person/ethnicity.sql', id).catch(() => []),
      runFile(src, 'person/yearofbirth_data.sql', id).catch(() => []),
      runFile(src, 'person/yearofbirth_stats.sql', id).catch(() => [])
    ])
    res.json({ gender, race, ethnicity, yearOfBirth, yearOfBirthStats })
  } catch (err) { next(err) }
})

// GET /:sourceKey/:id/person — person-level statistics (same as dashboard in Heracles)
router.get('/:sourceKey/:id/person', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  const id = req.params.id
  try {
    const [gender, race, ethnicity, yearOfBirthData, yearOfBirthStats, population] = await Promise.all([
      runFile(src, 'person/gender.sql', id).catch(() => []),
      runFile(src, 'person/race.sql', id).catch(() => []),
      runFile(src, 'person/ethnicity.sql', id).catch(() => []),
      runFile(src, 'person/yearofbirth_data.sql', id).catch(() => []),
      runFile(src, 'person/yearofbirth_stats.sql', id).catch(() => []),
      runFile(src, 'person/population.sql', id).catch(() => [])
    ])
    res.json({ gender, race, ethnicity, yearOfBirthData, yearOfBirthStats, population })
  } catch (err) { next(err) }
})

// GET /:sourceKey/:id/observationperiod
router.get('/:sourceKey/:id/observationperiod', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  try {
    const data = await runDirectory(src, 'observationperiod', req.params.id)
    res.json(data)
  } catch (err) { next(err) }
})

// GET /:sourceKey/:id/datadensity
router.get('/:sourceKey/:id/datadensity', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  try {
    const [conceptsPerPerson, recordsPerPerson, totalRecords] = await Promise.all([
      runFile(src, 'datadensity/conceptsperperson.sql', req.params.id).catch(() => []),
      runFile(src, 'datadensity/recordsperperson.sql', req.params.id).catch(() => []),
      runFile(src, 'datadensity/totalrecords.sql', req.params.id).catch(() => [])
    ])
    res.json({ conceptsPerPerson, recordsPerPerson, totalRecords })
  } catch (err) { next(err) }
})

// GET /:sourceKey/:id/death
router.get('/:sourceKey/:id/death', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  try {
    const data = await runDirectory(src, 'death', req.params.id)
    res.json(data)
  } catch (err) { next(err) }
})

// GET /:sourceKey/:id/heraclesheel
router.get('/:sourceKey/:id/heraclesheel', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  try {
    const rows = await runDirectory(src, 'heraclesHeel', req.params.id)
    res.json(rows)
  } catch { res.json([]) }
})

// Generic domain treemap + drilldown factory
const DOMAINS = ['condition', 'conditionera', 'drug', 'drugera', 'measurement', 'observation', 'procedure', 'visit']
const TREEMAP_FILES = {
  condition: 'condition/sqlConditionTreemap.sql',
  conditionera: 'conditionera/sqlConditionEraTreemap.sql',
  drug: 'drug/sqlDrugTreemap.sql',
  drugera: 'drugera/sqlDrugEraTreemap.sql',
  measurement: 'measurement/sqlMeasurementTreemap.sql',
  observation: 'observation/sqlObservationTreemap.sql',
  procedure: 'procedure/sqlProcedureTreemap.sql',
  visit: 'visit/sqlVisitTreemap.sql'
}
const DRILLDOWN_DIRS = {
  condition: 'condition/byConcept',
  conditionera: 'conditionera/byConcept',
  drug: 'drug/byConcept',
  drugera: 'drugera/byConcept',
  measurement: 'measurement/byConcept',
  observation: 'observation/byConcept',
  procedure: 'procedure/byConcept',
  visit: 'visit/byConcept'
}

for (const domain of DOMAINS) {
  // Treemap: GET /:sourceKey/:id/{domain}/
  router.get(`/:sourceKey/:id/${domain}`, async (req, res, next) => {
    const src = source404(req.params.sourceKey, res)
    if (!src) return
    try {
      const rows = await runFile(src, TREEMAP_FILES[domain], req.params.id).catch(() => [])
      res.json(rows)
    } catch (err) { next(err) }
  })

  // Drilldown: GET /:sourceKey/:id/{domain}/:conceptId
  router.get(`/:sourceKey/:id/${domain}/:conceptId`, async (req, res, next) => {
    const src = source404(req.params.sourceKey, res)
    if (!src) return
    try {
      const data = await runDirectory(src, DRILLDOWN_DIRS[domain], req.params.id,
        { conceptId: req.params.conceptId })
      res.json(data)
    } catch (err) { next(err) }
  })
}

// GET /:sourceKey/:id/cohortspecific — cohort-specific summary
router.get('/:sourceKey/:id/cohortspecific', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  try {
    const data = await runDirectory(src, 'cohortSpecific', req.params.id)
    res.json(data)
  } catch (err) { next(err) }
})

// GET /:sourceKey/:id/cohortspecifictreemap
router.get('/:sourceKey/:id/cohortspecifictreemap', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  try {
    const data = await runDirectory(src, 'cohortSpecific', req.params.id)
    res.json(data)
  } catch (err) { next(err) }
})

// GET /:sourceKey/:id/distinctPersonCount/
router.get('/:sourceKey/:id/distinctPersonCount', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  try {
    const sql = renderSql(
      `SELECT count_value FROM @ohdsi_database_schema.heracles_results WHERE analysis_id = 1 AND cohort_definition_id = @cohortDefinitionId`,
      src, req.params.id
    )
    const rows = await runSql(getPool(src.sourceKey), sql)
    res.json(rows[0]?.count_value ?? 0)
  } catch { res.json(0) }
})

// GET /:sourceKey/:id/summarydata
router.get('/:sourceKey/:id/summarydata', (_req, res) => res.json([]))

// GET /:sourceKey/:id/datacompleteness
router.get('/:sourceKey/:id/datacompleteness', async (req, res, next) => {
  const src = source404(req.params.sourceKey, res)
  if (!src) return
  try {
    const rows = await runFile(src, 'datacompleteness/getCohortDataCompleteness.sql', req.params.id).catch(() => [])
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /:sourceKey/:id/raw/:analysis_group/:analysis_name — raw result pass-through
router.get('/:sourceKey/:id/raw/:analysisGroup/:analysisName', (_req, res) => res.json([]))

// Healthcare utilization / cost reports — these require pre-computed cost
// tables that aren't part of the standard OMOP CDM (payer-specific, rarely
// populated in test sources), so they stub to empty rather than querying.
router.get('/:sourceKey/:id/healthcareutilization/drugtypes', (_req, res) => res.json([]))
router.get('/:sourceKey/:id/healthcareutilization/drug/:window', (_req, res) => res.json([]))
router.get('/:sourceKey/:id/healthcareutilization/drug/:window/:drugConceptId', (_req, res) => res.json([]))
router.get('/:sourceKey/:id/healthcareutilization/visit/:window/:visitStat', (_req, res) => res.json([]))
router.get('/:sourceKey/:id/healthcareutilization/exposure/:window', (_req, res) => res.json([]))
router.get('/:sourceKey/:id/healthcareutilization/periods/:window', (_req, res) => res.json([]))

// GET /:sourceKey/:id — catch-all for unmapped result types
router.get('/:sourceKey/:id', (_req, res) => res.json([]))

export default router
