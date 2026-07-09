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

async function get (path) {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json() }
}

// atlas/js/utils/DatatableUtils.js's getDateFieldFormatter defaults to the
// literal boolean `false` when the field is absent, and Tag Management's
// "Created" column renders that formatter's return value directly as text —
// so a DTO missing createdDate renders the string "false" in the UI.
describe('POST /tag/', () => {
  test('created tag includes createdDate and createdBy', async () => {
    const { status, body } = await post('/tag/', { name: 'Regression Test Tag' })
    assert.equal(status, 201)
    assert.equal(typeof body.createdDate, 'string')
    assert.ok(!Number.isNaN(Date.parse(body.createdDate)))
    assert.equal(body.createdBy, 'anonymous')
    assert.deepEqual(body.groups, [])
  })
})

// atlas/js/pages/configuration/tag-management/tag-management.js filters
// `allTags()` for `t.groups && t.groups.length > 0 && t.groups[0].id === group.id`
// to build the "Tags in Group" list, and reads `d.groups[0].color`/`.icon` as
// a rendering fallback — a tag created within a group must round-trip with a
// `groups: [<parent DTO>]` array or it silently vanishes from that list.
describe('Tag group hierarchy', () => {
  test('a tag created with a parent group round-trips groups[0]', async () => {
    const { body: group } = await post('/tag/', { name: 'Parent Group', color: '#123456', icon: 'fa fa-flag' })

    const { status, body: child } = await post('/tag/', { name: 'Child Tag', groups: [group] })
    assert.equal(status, 201)
    assert.equal(child.groups.length, 1)
    assert.equal(child.groups[0].id, group.id)
    assert.equal(child.groups[0].color, '#123456')
    assert.equal(child.groups[0].icon, 'fa fa-flag')

    const { body: allTags } = await get('/tag/')
    const reloadedChild = allTags.find(t => t.id === child.id)
    assert.equal(reloadedChild.groups[0].id, group.id)
  })
})
