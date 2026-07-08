import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// db.js reads config.dbPath at module load time, so this must be set before
// app.js (and its transitive dependencies) are imported below.
process.env.DB_PATH = ':memory:'

const { default: app } = await import('../src/app.js')

let server, base

before(() => new Promise(resolve => {
  server = createServer(app)
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`
    resolve()
  })
}))

after(() => new Promise(resolve => server.close(resolve)))

async function post (path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}

// Atlas's components/checks/warnings.js does result.warnings.filter(...) on the
// response — a bare [] (or a 404) crashes it. Every analysis-design page that
// wires up the warnings component needs this exact { warnings: [] } shape.
describe('POST /check design-diagnostics stubs', () => {
  test('pathway-analysis/check returns { warnings: [] }', async () => {
    const { status, body } = await post('/pathway-analysis/check', {})
    assert.equal(status, 200)
    assert.deepEqual(body, { warnings: [] })
  })

  test('cohort-characterization/check returns { warnings: [] }', async () => {
    const { status, body } = await post('/cohort-characterization/check', {})
    assert.equal(status, 200)
    assert.deepEqual(body, { warnings: [] })
  })

  test('prediction/check returns { warnings: [] }', async () => {
    const { status, body } = await post('/prediction/check', {})
    assert.equal(status, 200)
    assert.deepEqual(body, { warnings: [] })
  })
})
