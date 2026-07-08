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

describe('GET /ir/:id/info', () => {
  test('returns real generation info + summaryList', async () => {
    const { body: analysis } = await req('POST', '/ir', {
      name: 'Test IR Analysis',
      expression: { targetIds: [1], outcomeIds: [2] }
    })

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
    assert.equal(body.length, 1)
    assert.equal(body[0].executionInfo.status, 'COMPLETE')
    assert.equal(body[0].summaryList.length, 1)
    assert.equal(body[0].summaryList[0].totalPersons, 100)
  })
})

// Atlas's IRAnalysis.js always round-trips `expression` as a JSON *string*
// (see its parse() helper: JSON.parse(data.expression), called unconditionally
// on every GET/POST/PUT/version response). A brand-new analysis never
// exercises this path (it stays in-memory until saved), which is why a
// flattened/missing `expression` key only broke on reloading an existing one.
describe('POST/GET /ir round-trips expression as a JSON string', () => {
  test('POST response has expression as a string Atlas can JSON.parse', async () => {
    const { status, body } = await req('POST', '/ir', {
      name: 'Round-trip test',
      expression: JSON.stringify({ targetIds: [1], outcomeIds: [2], strata: [] })
    })
    assert.equal(status, 201)
    assert.equal(typeof body.expression, 'string')
    const parsed = JSON.parse(body.expression)
    assert.deepEqual(parsed.targetIds, [1])
    assert.deepEqual(parsed.outcomeIds, [2])
  })

  test('GET /:id response also has expression as a string', async () => {
    const { body: created } = await req('POST', '/ir', {
      name: 'Round-trip test 2',
      expression: { targetIds: [3], outcomeIds: [4] }
    })
    const { status, body } = await req('GET', `/ir/${created.id}`)
    assert.equal(status, 200)
    assert.equal(typeof body.expression, 'string')
    assert.deepEqual(JSON.parse(body.expression).targetIds, [3])
  })

  test('PUT response has expression as a string', async () => {
    const { body: created } = await req('POST', '/ir', { name: 'Round-trip test 3', expression: {} })
    const { status, body } = await req('PUT', `/ir/${created.id}`, {
      name: 'Round-trip test 3',
      expression: { targetIds: [9], outcomeIds: [10] }
    })
    assert.equal(status, 200)
    assert.equal(typeof body.expression, 'string')
    assert.deepEqual(JSON.parse(body.expression).targetIds, [9])
  })

  test('GET / (list) omits expression — matches Atlas\'s list view, which never reads it', async () => {
    const { body } = await req('GET', '/ir')
    assert.ok(Array.isArray(body))
    assert.ok(body.length > 0)
    assert.ok(!('expression' in body[0]))
  })
})

describe('POST /ir/check', () => {
  test('returns {warnings: []} — components/checks/warnings.js reads result.warnings.filter(...)', async () => {
    const { status, body } = await req('POST', '/ir/check', {})
    assert.equal(status, 200)
    assert.ok(Array.isArray(body.warnings))
  })
})
