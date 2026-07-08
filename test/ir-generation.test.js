import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { buildIrQuery, computeIrResult } from '../src/ir-generation.js'

process.env.DB_PATH = ':memory:'

const { default: app } = await import('../src/app.js')
const { default: db } = await import('../src/db.js')

let server, base

before(() => new Promise(resolve => {
  server = createServer(app)
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`
    resolve()
  })
}))

after(() => new Promise(resolve => server.close(resolve)))

async function req (method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(base + path, opts)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

describe('buildIrQuery', () => {
  test('uses cohort_start_date/cohort_end_date per DateField', () => {
    const sql = buildIrQuery({
      resultsSchema: 'results',
      cdmSchema: 'cdm',
      timeAtRisk: { start: { DateField: 'StartDate', Offset: 0 }, end: { DateField: 'EndDate', Offset: 365 } }
    })
    assert.match(sql, /c\.cohort_start_date/)
    assert.match(sql, /c\.cohort_end_date/)
    assert.match(sql, /results\.cohort/)
    assert.match(sql, /cdm\.observation_period/)
  })

  test('defaults to StartDate/EndDate when DateField is missing', () => {
    const sql = buildIrQuery({ resultsSchema: 'r', cdmSchema: 'c', timeAtRisk: {} })
    assert.match(sql, /c\.cohort_start_date/)
    assert.match(sql, /c\.cohort_end_date/)
  })

  test('clips TAR to study window bounds', () => {
    const sql = buildIrQuery({ resultsSchema: 'r', cdmSchema: 'c', timeAtRisk: {} })
    assert.match(sql, /@studyStart/)
    assert.match(sql, /@studyEnd/)
  })

  test('cases are counted only within the target subject\'s own TAR window', () => {
    const sql = buildIrQuery({ resultsSchema: 'r', cdmSchema: 'c', timeAtRisk: {} })
    assert.match(sql, /oc\.cohort_start_date BETWEEN e\.tar_start AND e\.tar_end/)
  })
})

describe('computeIrResult', () => {
  test('binds targetId/outcomeId/offsets/study window and normalizes recordset row', async () => {
    const inputs = []
    const fakeRequest = {
      input (name, _type, value) { inputs.push([name, value]); return this },
      async query (_sql) {
        return { recordset: [{ totalPersons: '42', cases: '7', timeAtRisk: '38.5' }] }
      }
    }
    const fakePool = { request: () => fakeRequest }

    const result = await computeIrResult(fakePool, {
      resultsSchema: 'r',
      cdmSchema: 'c',
      targetId: 1,
      outcomeId: 2,
      timeAtRisk: { start: { DateField: 'StartDate', Offset: 0 }, end: { DateField: 'EndDate', Offset: 0 } },
      studyWindow: { startDate: '2015-01-01', endDate: '2020-01-01' }
    })

    assert.deepEqual(result, { totalPersons: 42, cases: 7, timeAtRisk: 38.5 })

    const byName = Object.fromEntries(inputs)
    assert.equal(byName.targetId, 1)
    assert.equal(byName.outcomeId, 2)
    assert.equal(byName.studyStart, '2015-01-01')
    assert.equal(byName.studyEnd, '2020-01-01')
  })

  test('returns zeros when there is no matching recordset row data', async () => {
    const fakeRequest = {
      input () { return this },
      async query () { return { recordset: [{ totalPersons: null, cases: null, timeAtRisk: null }] } }
    }
    const fakePool = { request: () => fakeRequest }

    const result = await computeIrResult(fakePool, {
      resultsSchema: 'r', cdmSchema: 'c', targetId: 1, outcomeId: 2, timeAtRisk: {}
    })
    assert.deepEqual(result, { totalPersons: 0, cases: 0, timeAtRisk: 0 })
  })
})

// analysisFactory.js registers its own stubbed GET /:id/info (-> []) before
// ir.js's configure callback runs its route-matching pass in Express's
// internal order; regression-test that ir.js's real handler is the one
// actually reached, not the factory's stub.
describe('GET /ir/:id/info (route-override regression)', () => {
  test('returns real generation info + summaryList, not the factory\'s [] stub', async () => {
    const { body: analysis } = await req('POST', '/ir', { name: 'Test IR Analysis', targetIds: [1], outcomeIds: [2] })

    db.prepare(`
      INSERT INTO ir_generation_info (ir_analysis_id, source_key, status, start_time, execution_duration)
      VALUES (?, 'testsource', 'COMPLETED', ?, 1234)
    `).run(analysis.id, Date.now())
    db.prepare(`
      INSERT INTO ir_analysis_result (ir_analysis_id, source_key, target_id, outcome_id, total_persons, cases, time_at_risk)
      VALUES (?, 'testsource', 1, 2, 100, 5, 42.5)
    `).run(analysis.id)

    const { status, body } = await req('GET', `/ir/${analysis.id}/info`)
    assert.equal(status, 200)
    assert.equal(body.length, 1, 'factory stub would have returned an empty array')
    assert.equal(body[0].executionInfo.status, 'COMPLETE')
    assert.equal(body[0].summaryList.length, 1)
    assert.equal(body[0].summaryList[0].totalPersons, 100)
  })
})
