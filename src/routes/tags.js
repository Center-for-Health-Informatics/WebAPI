import { Router } from 'express'
import db from '../db.js'

// Tags — /tag
// Provides CRUD for tags and multi-assign/unassign against the entity_tag junction table.
//
// Atlas's Tag Management page treats any tag with no parent as a "group" and
// any tag with a parent as a member of that group — a child tag's DTO must
// carry `groups: [<parent DTO>]` (used both to detect group membership and,
// via `d.groups[0].color`/`.icon`, as a rendering fallback). See
// atlas/js/pages/configuration/tag-management/tag-management.js.

const router = Router()

function formatDate (ms) {
  if (!ms) return null
  return new Date(ms).toISOString()
}

// DTO without a `groups` lookup — used both as the top-level shape and as
// the shape nested inside a child tag's `groups[0]`.
function rowToBaseDto (row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type || 'COMMON',
    description: row.description || null,
    color: row.color || null,
    icon: row.icon || null,
    count: 0,
    showGroup: !!row.show_group,
    multiSelection: !!row.multi_selection,
    permissionProtected: !!row.protected,
    allowCustom: !!row.allow_custom,
    mandatory: !!row.mandatory,
    hasWriteAccess: true,
    createdBy: row.created_by || null,
    createdDate: formatDate(row.created_date)
  }
}

function rowToDto (row) {
  const dto = rowToBaseDto(row)
  if (row.parent_id) {
    const parentRow = db.prepare('SELECT * FROM tag WHERE id = ?').get(row.parent_id)
    dto.groups = parentRow ? [rowToBaseDto(parentRow)] : []
  } else {
    dto.groups = []
  }
  return dto
}

// GET /search?namePart=... — must be before /:id
router.get('/search', (req, res) => {
  const part = req.query.namePart || ''
  const rows = db.prepare("SELECT * FROM tag WHERE name LIKE ? ORDER BY name").all(`%${part}%`)
  res.json(rows.map(rowToDto))
})

// GET /assignmentPermissions
router.get('/assignmentPermissions', (_req, res) => res.json([]))

// GET /
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM tag ORDER BY name').all()
  res.json(rows.map(rowToDto))
})

// POST /
router.post('/', (req, res) => {
  const { name, type, description, color, icon, mandatory, showGroup, multiSelection, allowCustom, permissionProtected, groups } = req.body
  if (!name) return res.status(400).json({ message: 'name is required' })
  const user = req.user?.login || 'anonymous'
  const parentId = groups && groups.length > 0 ? groups[0].id : null
  try {
    const result = db.prepare(
      `INSERT INTO tag (name, type, description, color, icon, mandatory, show_group, multi_selection, allow_custom, protected, parent_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name, type || 'COMMON', description || null, color || null, icon || null,
      mandatory ? 1 : 0, showGroup ? 1 : 0, multiSelection ? 1 : 0, allowCustom ? 1 : 0, permissionProtected ? 1 : 0,
      parentId, user
    )
    const row = db.prepare('SELECT * FROM tag WHERE id = ?').get(result.lastInsertRowid)
    res.status(201).json(rowToDto(row))
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ message: 'Tag name already exists' })
    throw e
  }
})

// POST /multiAssign — body: { tagIds: [1,2], entityIds: [3,4], entityType: 'COHORT' }
router.post('/multiAssign', (req, res) => {
  const { tagIds = [], entityIds = [], entityType = '' } = req.body
  const insert = db.prepare(
    'INSERT OR IGNORE INTO entity_tag (tag_id, entity_type, entity_id) VALUES (?, ?, ?)'
  )
  const tx = db.transaction(() => {
    for (const tagId of tagIds) {
      for (const entityId of entityIds) {
        insert.run(tagId, entityType, entityId)
      }
    }
  })
  tx()
  res.sendStatus(200)
})

// POST /multiUnassign
router.post('/multiUnassign', (req, res) => {
  const { tagIds = [], entityIds = [], entityType = '' } = req.body
  const del = db.prepare(
    'DELETE FROM entity_tag WHERE tag_id = ? AND entity_type = ? AND entity_id = ?'
  )
  const tx = db.transaction(() => {
    for (const tagId of tagIds) {
      for (const entityId of entityIds) {
        del.run(tagId, entityType, entityId)
      }
    }
  })
  tx()
  res.sendStatus(200)
})

// GET /:id
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tag WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ message: 'Tag not found' })
  res.json(rowToDto(row))
})

// PUT /:id
router.put('/:id', (req, res) => {
  const { name, type, description, color, icon, mandatory, showGroup, multiSelection, allowCustom, permissionProtected, groups } = req.body
  const parentId = groups && groups.length > 0 ? groups[0].id : null
  const result = db.prepare(
    `UPDATE tag SET name = ?, type = ?, description = ?, color = ?, icon = ?, mandatory = ?, show_group = ?, multi_selection = ?, allow_custom = ?, protected = ?, parent_id = ?
     WHERE id = ?`
  ).run(
    name || null, type || 'COMMON', description || null, color || null, icon || null,
    mandatory ? 1 : 0, showGroup ? 1 : 0, multiSelection ? 1 : 0, allowCustom ? 1 : 0, permissionProtected ? 1 : 0,
    parentId, req.params.id
  )
  if (!result.changes) return res.status(404).json({ message: 'Tag not found' })
  const row = db.prepare('SELECT * FROM tag WHERE id = ?').get(req.params.id)
  res.json(rowToDto(row))
})

// DELETE /:id
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM tag WHERE id = ?').run(req.params.id)
  if (!result.changes) return res.status(404).json({ message: 'Tag not found' })
  res.sendStatus(200)
})

export default router
