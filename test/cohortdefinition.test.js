import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// db.js reads config.dbPath at module load time, so this must be set before
// app.js (and its transitive dependencies) are imported below.
process.env.DB_PATH = ':memory:'

// Dynamic import so the env var above is set before db.js is loaded.
const { default: app } = await import('../src/app.js')
const { buildTreemapData, formatBitMask } =
  await import('../src/routes/cohortdefinition.js')

// --- HTTP server lifecycle ---

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

// Minimal cohort expression that Atlas would send on save
const EXPR = {
  ConceptSets: [],
  PrimaryCriteria: {
    CriteriaList: [],
    ObservationWindow: { PriorDays: 0, PostDays: 0 },
    PrimaryCriteriaLimit: { Type: 'First' }
  },
  QualifiedLimit: { Type: 'First' },
  ExpressionLimit: { Type: 'All' },
  InclusionRules: [],
  EndStrategy: null,
  CensoringCriteria: [],
  CollapseSettings: { CollapseType: 'ERA', EraPad: 0 },
  CensorWindow: {}
}

// Shared state — tests run sequentially and build on each other
let id, versionNumber

// --- Cohort definition CRUD ---

describe('GET /cohortdefinition', () => {
  test('returns empty array on a fresh database', async () => {
    const { status, body } = await req('GET', '/cohortdefinition')
    assert.equal(status, 200)
    assert.ok(Array.isArray(body))
    assert.equal(body.length, 0)
  })
})

describe('POST /cohortdefinition', () => {
  test('creates a cohort and returns 201 with the correct DTO shape', async () => {
    const { status, body } = await req('POST', '/cohortdefinition', {
      name: 'T2DM Cohort',
      description: 'Test description',
      expression: EXPR
    })
    assert.equal(status, 201)
    assert.ok(body.id, 'response has id')
    assert.equal(body.name, 'T2DM Cohort')
    assert.equal(body.description, 'Test description')
    assert.equal(body.expressionType, 'SIMPLE_EXPRESSION')
    assert.ok(body.createdBy, 'response has createdBy')
    id = body.id
  })

  test('expression in POST response is a parsed object, not a string', async () => {
    // Atlas uses the POST response directly in new CohortDefinition(savedDefinition)
    // without calling JSON.parse — expression must arrive as an object.
    const { body } = await req('POST', '/cohortdefinition', { name: 'Another', expression: EXPR })
    assert.equal(typeof body.expression, 'object', 'expression is an object')
    assert.notEqual(body.expression, null)
    assert.ok(Array.isArray(body.expression.ConceptSets), 'expression.ConceptSets is an array')
  })
})

describe('GET /cohortdefinition/:id', () => {
  test('returns 404 for unknown id', async () => {
    const { status } = await req('GET', '/cohortdefinition/99999')
    assert.equal(status, 404)
  })

  test('returns the correct DTO shape', async () => {
    const { status, body } = await req('GET', `/cohortdefinition/${id}`)
    assert.equal(status, 200)
    assert.equal(body.id, id)
    assert.equal(body.name, 'T2DM Cohort')
  })

  test('expression in GET response is a raw JSON string for Atlas to JSON.parse', async () => {
    // Atlas's getCohortDefinition does: cohortDef.expression = JSON.parse(cohortDef.expression)
    // so expression must be a string here.
    const { body } = await req('GET', `/cohortdefinition/${id}`)
    assert.equal(typeof body.expression, 'string', 'expression is a string for GET')
    const parsed = JSON.parse(body.expression)
    assert.ok(Array.isArray(parsed.ConceptSets), 'expression string parses to a valid object')
  })
})

describe('PUT /cohortdefinition/:id', () => {
  test('updates name and returns 200', async () => {
    const { status, body } = await req('PUT', `/cohortdefinition/${id}`, {
      name: 'Updated Name',
      expression: EXPR
    })
    assert.equal(status, 200)
    assert.equal(body.name, 'Updated Name')
  })

  test('expression in PUT response is a parsed object, not a string', async () => {
    // Atlas uses the PUT response directly in new CohortDefinition(savedDefinition)
    // without calling JSON.parse.
    const { body } = await req('PUT', `/cohortdefinition/${id}`, {
      name: 'Updated Name',
      expression: EXPR
    })
    assert.equal(typeof body.expression, 'object', 'expression is an object')
    assert.notEqual(body.expression, null)
    assert.ok(Array.isArray(body.expression.ConceptSets), 'expression.ConceptSets is an array')
  })
})

describe('GET /cohortdefinition/:id/exists', () => {
  test('returns 0 when no other cohort uses the name', async () => {
    const { status, body } = await req('GET', `/cohortdefinition/${id}/exists?name=Unique+Name`)
    assert.equal(status, 200)
    assert.equal(body, 0)
  })

  test('returns a positive count when another cohort already uses the name', async () => {
    const { body } = await req('GET', `/cohortdefinition/${id}/exists?name=Another`)
    assert.equal(typeof body, 'number')
    assert.ok(body > 0)
  })
})

describe('GET /cohortdefinition/:id/copy', () => {
  test('creates a copy and returns expression as a parsed object', async () => {
    const { status, body } = await req('GET', `/cohortdefinition/${id}/copy`)
    assert.equal(status, 200)
    assert.ok(body.name.startsWith('Copy of'), 'copy name is prefixed')
    assert.equal(typeof body.expression, 'object', 'expression is an object')
    assert.notEqual(body.expression, null)
    assert.ok(Array.isArray(body.expression.ConceptSets))
  })
})

// --- Version endpoints ---

describe('POST /cohortdefinition/:id/version', () => {
  test('creates a version snapshot and returns 201 with versionToDto shape', async () => {
    const { status, body } = await req('POST', `/cohortdefinition/${id}/version`, {
      description: 'v1 snapshot'
    })
    assert.equal(status, 201)
    assert.ok(body.id, 'version has id')
    assert.equal(body.entityId, id)
    assert.ok(body.version >= 1, 'version number assigned')
    assert.equal(body.description, 'v1 snapshot')
    assert.equal(typeof body.archived, 'boolean')
    versionNumber = body.version
  })
})

describe('GET /cohortdefinition/:id/version', () => {
  test('returns an array of version DTOs', async () => {
    const { status, body } = await req('GET', `/cohortdefinition/${id}/version`)
    assert.equal(status, 200)
    assert.ok(Array.isArray(body))
    assert.ok(body.length >= 1)
    assert.ok('version' in body[0])
    assert.ok('entityId' in body[0])
  })
})

describe('GET /cohortdefinition/:id/version/:ver', () => {
  test('returns the { entityDTO, versionDTO } envelope Atlas expects', async () => {
    const { status, body } = await req('GET', `/cohortdefinition/${id}/version/${versionNumber}`)
    assert.equal(status, 200)
    assert.ok('entityDTO' in body, 'response has entityDTO key')
    assert.ok('versionDTO' in body, 'response has versionDTO key')
    assert.equal(body.versionDTO.version, versionNumber)
    assert.equal(body.entityDTO.id, id)
  })
})

describe('GET /cohortdefinition/:id/info', () => {
  test('returns an array (empty before any generation has run)', async () => {
    const { status, body } = await req('GET', `/cohortdefinition/${id}/info`)
    assert.equal(status, 200)
    assert.ok(Array.isArray(body))
  })
})

// --- Pure function unit tests (no HTTP needed) ---

describe('formatBitMask', () => {
  test('zero with 3 rules → 000', () => {
    assert.equal(formatBitMask(0, 3), '000')
  })

  test('all bits set with 3 rules → 111', () => {
    assert.equal(formatBitMask(7, 3), '111')
  })

  test('bit 0 only (mask=1) with 3 rules → 100 (reversed binary)', () => {
    // 1 = 0b001, padded to '001', reversed to '100'
    assert.equal(formatBitMask(1, 3), '100')
  })

  test('bit 1 only (mask=2) with 3 rules → 010', () => {
    assert.equal(formatBitMask(2, 3), '010')
  })

  test('bit 2 only (mask=4) with 3 rules → 001 (reversed)', () => {
    // 4 = 0b100, padded to '100', reversed to '001'
    assert.equal(formatBitMask(4, 3), '001')
  })
})

describe('buildTreemapData', () => {
  test('empty rows returns Everyone node with no children', () => {
    const result = JSON.parse(buildTreemapData([], 2))
    assert.equal(result.name, 'Everyone')
    assert.deepEqual(result.children, [])
  })

  test('groups rows by popcount descending', () => {
    const rows = [
      { inclusion_rule_mask: 1n, person_count: 50n },  // popcount 1
      { inclusion_rule_mask: 3n, person_count: 100n }  // popcount 2 — should come first
    ]
    const result = JSON.parse(buildTreemapData(rows, 2))
    assert.equal(result.children.length, 2)
    assert.equal(result.children[0].name, 'Group 2', 'higher popcount group first')
    assert.equal(result.children[1].name, 'Group 1')
  })

  test('leaf nodes have reversed-binary name and person_count as size', () => {
    // mask=2 (0b10), ruleCount=2: padded '10', reversed '01'
    const rows = [{ inclusion_rule_mask: 2n, person_count: 75n }]
    const result = JSON.parse(buildTreemapData(rows, 2))
    const leaf = result.children[0].children[0]
    assert.equal(leaf.name, '01')
    assert.equal(leaf.size, 75)
  })
})
