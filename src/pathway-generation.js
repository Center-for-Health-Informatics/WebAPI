import mssql from 'mssql'

// Cohort Pathways analysis math — for each target cohort, finds each
// person's ordered sequence of event-cohort occurrences (on/after their
// target cohort entry date) and aggregates person counts per unique
// sequence. Does not require CIRCE: target/event cohorts are references to
// cohorts that have already been generated via cohortdefinition.js — same
// "no CIRCE or R needed" reasoning as ir-generation.js.
//
// Simplifications vs. real OHDSI Cohort Pathways, documented rather than
// silently assumed:
//  - Only a person's *earliest* target-cohort entry is used as the anchor
//    (real pathways can branch per cohort era).
//  - minCellCount suppression drops small-count paths outright rather than
//    rolling them into an "other" bucket.

async function fetchCohortRows (pool, resultsSchema, cohortDefinitionId) {
  const result = await pool.request()
    .input('cohortId', mssql.Int, cohortDefinitionId)
    .query(`SELECT subject_id, cohort_start_date FROM ${resultsSchema}.cohort WHERE cohort_definition_id = @cohortId`)
  return result.recordset
}

export async function computePathwayResult (pool, { resultsSchema, targetId, eventCohortIds, combinationWindow = 0, minCellCount = 0, maxDepth = 5, allowRepeats = false }) {
  const targetRows = await fetchCohortRows(pool, resultsSchema, targetId)

  // earliest entry per subject is the pathway anchor
  const indexBySubject = new Map()
  for (const row of targetRows) {
    const existing = indexBySubject.get(row.subject_id)
    if (!existing || row.cohort_start_date < existing) {
      indexBySubject.set(row.subject_id, row.cohort_start_date)
    }
  }
  const targetCohortCount = indexBySubject.size

  if (targetCohortCount === 0) {
    return { targetCohortCount: 0, totalPathwaysCount: 0, pathways: [] }
  }

  // gather event occurrences on/after each subject's anchor date, tagged with their bit code
  const eventsBySubject = new Map()
  for (let i = 0; i < eventCohortIds.length; i++) {
    const code = Math.pow(2, i)
    const rows = await fetchCohortRows(pool, resultsSchema, eventCohortIds[i])
    for (const row of rows) {
      const anchor = indexBySubject.get(row.subject_id)
      if (anchor === undefined || row.cohort_start_date < anchor) continue
      if (!eventsBySubject.has(row.subject_id)) eventsBySubject.set(row.subject_id, [])
      eventsBySubject.get(row.subject_id).push({ date: row.cohort_start_date, code })
    }
  }

  const windowMs = combinationWindow * 86400000
  const pathCounts = new Map()

  for (const events of eventsBySubject.values()) {
    events.sort((a, b) => a.date - b.date)

    // combine events within combinationWindow days of the step's first event into one step
    const steps = []
    let i = 0
    while (i < events.length) {
      let code = events[i].code
      let j = i + 1
      while (j < events.length && (events[j].date - events[i].date) <= windowMs) {
        code |= events[j].code
        j++
      }
      steps.push(code)
      i = j
    }

    const finalSteps = allowRepeats ? steps : steps.filter((code, idx) => idx === 0 || code !== steps[idx - 1])
    const truncated = finalSteps.slice(0, maxDepth)
    if (truncated.length === 0) continue

    const path = truncated.join('-')
    pathCounts.set(path, (pathCounts.get(path) || 0) + 1)
  }

  let pathways = Array.from(pathCounts.entries()).map(([path, personCount]) => ({ path, personCount }))
  if (minCellCount > 0) pathways = pathways.filter(p => p.personCount >= minCellCount)

  const totalPathwaysCount = pathways.reduce((sum, p) => sum + p.personCount, 0)

  return { targetCohortCount, totalPathwaysCount, pathways }
}
