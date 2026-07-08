import { Router } from 'express'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { getSource, getPool } from '../sources.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SQL_DIR = join(__dirname, '../sql/person')

function readSql (name) {
  return readFileSync(join(SQL_DIR, name), 'utf8')
}

function renderSql (sql, tableQualifier, extraParams = {}) {
  const params = { tableQualifier, ...extraParams }
  return Object.entries(params).reduce((s, [k, v]) => {
    return s.replace(new RegExp(`@${k}\\b`, 'gi'), v ?? '')
  }, sql)
}

// mssql returns recordset column names in the exact (lowercase) case written
// in the SQL, not upper-cased — the DTO builder below must read the rows
// accordingly.
export function rowsToProfile (personRow, opRows, recRows) {
  return {
    gender: personRow.gender || '',
    yearOfBirth: personRow.year_of_birth || 0,
    observationPeriods: opRows.map(r => ({
      id: r.observation_period_id,
      startDate: r.start_date,
      endDate: r.end_date,
      type: r.observation_period_type
    })),
    records: recRows.map(r => ({
      conceptId: r.concept_id,
      conceptName: r.concept_name,
      domain: r.domain,
      startDate: r.start_date,
      endDate: r.end_date
    }))
  }
}

// Person profile route is mounted at /:sourceKey/person by app.js.
// The params injected by Express include :sourceKey from the parent mount.
const router = Router({ mergeParams: true })

router.get('/:personId', async (req, res, next) => {
  const { sourceKey, personId } = req.params

  try {
    const source = getSource(sourceKey)
    const pool = getPool(sourceKey)
    const tq = source.cdmSchema

    // Person demographics
    const infoSql = renderSql(readSql('personInfo.sql'), tq, { personId })
    const infoResult = await pool.request().query(infoSql)
    const personRow = infoResult.recordset[0]
    if (!personRow) return res.status(404).json({ message: `Person not found: ${personId}` })

    // Observation periods
    const opSql = renderSql(readSql('getObservationPeriods.sql'), tq, { personId })
    const opResult = await pool.request().query(opSql)

    // All clinical records (conditions, drugs, visits, etc.)
    const recSql = renderSql(readSql('getRecords.sql'), tq, { personId })
    const recResult = await pool.request().query(recSql)

    res.json(rowsToProfile(personRow, opResult.recordset, recResult.recordset))
  } catch (err) {
    next(err)
  }
})

export default router
