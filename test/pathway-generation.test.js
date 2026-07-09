import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computePathwayResult } from '../src/pathway-generation.js'

const day = 86400000
const d = (s) => new Date(s)

function fakePoolFor (cohortRows) {
  // cohortRows: Map<cohortId, [{subject_id, cohort_start_date}]>
  return {
    request () {
      let boundId
      return {
        input (_name, _type, value) { boundId = value; return this },
        async query (_sql) {
          return { recordset: cohortRows.get(boundId) || [] }
        }
      }
    }
  }
}

describe('computePathwayResult', () => {
  test('reports zero pathways when target cohort is empty', async () => {
    const pool = fakePoolFor(new Map([[1, []]]))
    const result = await computePathwayResult(pool, { resultsSchema: 'r', targetId: 1, eventCohortIds: [2] })
    assert.deepEqual(result, { targetCohortCount: 0, totalPathwaysCount: 0, pathways: [] })
  })

  test('builds an ordered path per person from event cohort occurrences after their target entry', async () => {
    const cohortRows = new Map([
      [1, [{ subject_id: 100, cohort_start_date: d('2020-01-01') }, { subject_id: 200, cohort_start_date: d('2020-01-01') }]],
      [2, [{ subject_id: 100, cohort_start_date: d('2020-01-05') }]], // event A, code 1
      [3, [{ subject_id: 100, cohort_start_date: d('2020-02-01') }, { subject_id: 200, cohort_start_date: d('2020-01-10') }]] // event B, code 2
    ])
    const pool = fakePoolFor(cohortRows)
    const result = await computePathwayResult(pool, { resultsSchema: 'r', targetId: 1, eventCohortIds: [2, 3], maxDepth: 5 })

    assert.equal(result.targetCohortCount, 2)
    // person 100: event A then event B -> "1-2"; person 200: event B only -> "2"
    const byPath = Object.fromEntries(result.pathways.map(p => [p.path, p.personCount]))
    assert.equal(byPath['1-2'], 1)
    assert.equal(byPath['2'], 1)
    assert.equal(result.totalPathwaysCount, 2)
  })

  test('ignores event occurrences before the target cohort entry date', async () => {
    const cohortRows = new Map([
      [1, [{ subject_id: 100, cohort_start_date: d('2020-06-01') }]],
      [2, [{ subject_id: 100, cohort_start_date: d('2020-01-01') }]] // before anchor — excluded
    ])
    const pool = fakePoolFor(cohortRows)
    const result = await computePathwayResult(pool, { resultsSchema: 'r', targetId: 1, eventCohortIds: [2] })
    assert.equal(result.totalPathwaysCount, 0)
    assert.deepEqual(result.pathways, [])
  })

  test('combines same-window events into one step via bitwise OR', async () => {
    const cohortRows = new Map([
      [1, [{ subject_id: 100, cohort_start_date: d('2020-01-01') }]],
      [2, [{ subject_id: 100, cohort_start_date: d('2020-01-05') }]], // code 1
      [3, [{ subject_id: 100, cohort_start_date: d('2020-01-06') }]] // code 2, 1 day later
    ])
    const pool = fakePoolFor(cohortRows)
    const result = await computePathwayResult(pool, { resultsSchema: 'r', targetId: 1, eventCohortIds: [2, 3], combinationWindow: 3 })
    assert.deepEqual(result.pathways, [{ path: '3', personCount: 1 }]) // 1|2 = 3, single combined step
  })

  test('collapses consecutive repeat steps unless allowRepeats is set', async () => {
    const cohortRows = new Map([
      [1, [{ subject_id: 100, cohort_start_date: d('2020-01-01') }]],
      [2, [
        { subject_id: 100, cohort_start_date: d('2020-01-05') },
        { subject_id: 100, cohort_start_date: d('2020-02-05') }
      ]]
    ])
    const pool = fakePoolFor(cohortRows)

    const collapsed = await computePathwayResult(pool, { resultsSchema: 'r', targetId: 1, eventCohortIds: [2], allowRepeats: false })
    assert.deepEqual(collapsed.pathways, [{ path: '1', personCount: 1 }])

    const repeated = await computePathwayResult(pool, { resultsSchema: 'r', targetId: 1, eventCohortIds: [2], allowRepeats: true })
    assert.deepEqual(repeated.pathways, [{ path: '1-1', personCount: 1 }])
  })

  test('truncates paths to maxDepth', async () => {
    const cohortRows = new Map([
      [1, [{ subject_id: 100, cohort_start_date: d('2020-01-01') }]],
      [2, [{ subject_id: 100, cohort_start_date: d('2020-01-05') }]],
      [3, [{ subject_id: 100, cohort_start_date: d('2020-01-10') }]]
    ])
    const pool = fakePoolFor(cohortRows)
    const result = await computePathwayResult(pool, { resultsSchema: 'r', targetId: 1, eventCohortIds: [2, 3], maxDepth: 1 })
    assert.deepEqual(result.pathways, [{ path: '1', personCount: 1 }])
  })

  test('suppresses paths below minCellCount', async () => {
    const cohortRows = new Map([
      [1, [{ subject_id: 100, cohort_start_date: d('2020-01-01') }, { subject_id: 200, cohort_start_date: d('2020-01-01') }]],
      [2, [{ subject_id: 100, cohort_start_date: d('2020-01-05') }]]
    ])
    const pool = fakePoolFor(cohortRows)
    const result = await computePathwayResult(pool, { resultsSchema: 'r', targetId: 1, eventCohortIds: [2], minCellCount: 2 })
    assert.deepEqual(result.pathways, [])
    assert.equal(result.totalPathwaysCount, 0)
  })
})
