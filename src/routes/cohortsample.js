import { Router } from 'express'
import db from '../db.js'
import { formatDate, toUserRef } from './analysisFactory.js'

// Cohort Sample — mount at /cohortsample
//
// Atlas (js/services/Sample.js) calls:
//   POST   /cohortsample/:cohortDefinitionId/:sourceKey
//   GET    /cohortsample/:cohortDefinitionId/:sourceKey
//   GET    /cohortsample/:cohortDefinitionId/:sourceKey/:sampleId
//   POST   /cohortsample/:cohortDefinitionId/:sourceKey/:sampleId/refresh
//   DELETE /cohortsample/:cohortDefinitionId/:sourceKey/:sampleId
//
// A "sample" is a named, filtered sub-selection (by size/age/gender) of the
// persons in a generated cohort on a given CDM source. The sample definition
// itself (name, size, age filter, gender filter) is stored in SQLite and is
// fully functional. Actually drawing the sampled person rows requires
// executing a query against the CDM source database — that part is stubbed
// (returns an empty `elements` array) per the generation-stub convention
// used elsewhere in this codebase (see analysisFactory.js).

function rowToDto (row) {
  const age = row.age_mode
    ? { value: row.age_value, mode: row.age_mode, min: row.age_min, max: row.age_max }
    : null
  let elements = []
  if (row.elements) {
    try { elements = JSON.parse(row.elements) } catch { /* ignore */ }
  }
  return {
    id: row.id,
    cohortDefinitionId: row.cohort_definition_id,
    sourceKey: row.source_key,
    name: row.name,
    size: row.size,
    age,
    gender: {
      otherNonBinary: !!row.gender_other_non_binary,
      conceptIds: row.gender_concept_ids ? JSON.parse(row.gender_concept_ids) : []
    },
    elements,
    createdBy: toUserRef(row.created_by),
    createdDate: formatDate(row.created_date),
    modifiedBy: toUserRef(row.modified_by),
    modifiedDate: formatDate(row.modified_date)
  }
}

const STATUS_MAP = { STARTED: 'RUNNING', COMPLETED: 'COMPLETE', CANCELED: 'FAILED' }

function generationStatusFor (cohortDefinitionId, sourceKey) {
  const info = db.prepare(
    'SELECT status FROM cohort_generation_info WHERE cohort_definition_id = ? AND source_key = ?'
  ).get(cohortDefinitionId, sourceKey)
  if (!info) return 'PENDING'
  return STATUS_MAP[info.status] ?? info.status
}

const router = Router()

// POST /:cohortDefinitionId/:sourceKey — create a new sample
router.post('/:cohortDefinitionId/:sourceKey', (req, res) => {
  const { cohortDefinitionId, sourceKey } = req.params
  const { name, size, age, gender } = req.body || {}
  if (!name) return res.status(400).json({ message: 'name is required' })
  const user = req.user?.login || 'anonymous'

  const ageMode = age?.mode ?? null
  const ageValue = age?.value ?? null
  const ageMin = age?.min ?? null
  const ageMax = age?.max ?? null
  const otherNonBinary = gender?.otherNonBinary ? 1 : 0
  const conceptIds = JSON.stringify(gender?.conceptIds || [])

  const result = db.prepare(`
    INSERT INTO cohort_sample
      (cohort_definition_id, source_key, name, size, age_mode, age_value, age_min, age_max,
       gender_other_non_binary, gender_concept_ids, elements, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cohortDefinitionId, sourceKey, name, size ?? null, ageMode, ageValue, ageMin, ageMax,
    otherNonBinary, conceptIds, JSON.stringify([]), user
  )

  const row = db.prepare('SELECT * FROM cohort_sample WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(rowToDto(row))
})

// GET /:cohortDefinitionId/:sourceKey — list samples for a cohort/source
router.get('/:cohortDefinitionId/:sourceKey', (req, res) => {
  const { cohortDefinitionId, sourceKey } = req.params
  const rows = db.prepare(
    'SELECT * FROM cohort_sample WHERE cohort_definition_id = ? AND source_key = ? ORDER BY id DESC'
  ).all(cohortDefinitionId, sourceKey)
  res.json({
    generationStatus: generationStatusFor(cohortDefinitionId, sourceKey),
    samples: rows.map(rowToDto)
  })
})

// GET /:cohortDefinitionId/:sourceKey/:sampleId — sample detail + person-level elements
router.get('/:cohortDefinitionId/:sourceKey/:sampleId', (req, res) => {
  const { cohortDefinitionId, sourceKey, sampleId } = req.params
  const row = db.prepare(
    'SELECT * FROM cohort_sample WHERE id = ? AND cohort_definition_id = ? AND source_key = ?'
  ).get(sampleId, cohortDefinitionId, sourceKey)
  if (!row) return res.status(404).json({ message: 'Sample not found' })
  res.json(rowToDto(row))
})

// POST /:cohortDefinitionId/:sourceKey/:sampleId/refresh — regenerate person-level elements
// Stub: actually drawing the sample requires executing against the CDM source; not implemented.
router.post('/:cohortDefinitionId/:sourceKey/:sampleId/refresh', (req, res) => {
  const { cohortDefinitionId, sourceKey, sampleId } = req.params
  const row = db.prepare(
    'SELECT * FROM cohort_sample WHERE id = ? AND cohort_definition_id = ? AND source_key = ?'
  ).get(sampleId, cohortDefinitionId, sourceKey)
  if (!row) return res.status(404).json({ message: 'Sample not found' })
  const user = req.user?.login || 'anonymous'
  db.prepare('UPDATE cohort_sample SET elements = ?, modified_by = ?, modified_date = ? WHERE id = ?')
    .run(JSON.stringify([]), user, Date.now(), row.id)
  const updated = db.prepare('SELECT * FROM cohort_sample WHERE id = ?').get(row.id)
  res.json(rowToDto(updated))
})

// DELETE /:cohortDefinitionId/:sourceKey/:sampleId
router.delete('/:cohortDefinitionId/:sourceKey/:sampleId', (req, res) => {
  const { cohortDefinitionId, sourceKey, sampleId } = req.params
  const result = db.prepare(
    'DELETE FROM cohort_sample WHERE id = ? AND cohort_definition_id = ? AND source_key = ?'
  ).run(sampleId, cohortDefinitionId, sourceKey)
  if (!result.changes) return res.status(404).json({ message: 'Sample not found' })
  res.sendStatus(200)
})

export default router
