import { Router } from 'express'
import db from '../db.js'

// External tool links — /tool
const router = Router()

function rowToDto (row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    url: row.url || null,
    enabled: !!row.enabled,
    createdBy: row.created_by,
    createdByName: row.created_by,
    createdDate: row.created_date ? new Date(row.created_date).toISOString() : null,
    modifiedBy: row.modified_by,
    modifiedDate: row.modified_date ? new Date(row.modified_date).toISOString() : null
  }
}

router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM tool ORDER BY id DESC').all()
  res.json(rows.map(rowToDto))
})

router.post('/', (req, res) => {
  const { name, description, url, enabled } = req.body
  if (!name) return res.status(400).json({ message: 'name is required' })
  const user = req.user?.login || 'anonymous'
  const result = db.prepare(
    'INSERT INTO tool (name, description, url, enabled, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(name, description || null, url || null, enabled ? 1 : 0, user)
  const row = db.prepare('SELECT * FROM tool WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(rowToDto(row))
})

router.put('/', (req, res) => {
  const { id, name, description, url, enabled } = req.body
  const user = req.user?.login || 'anonymous'
  const result = db.prepare(
    'UPDATE tool SET name = ?, description = ?, url = ?, enabled = ?, modified_by = ?, modified_date = ? WHERE id = ?'
  ).run(name || null, description || null, url || null, enabled ? 1 : 0, user, Date.now(), id)
  if (!result.changes) return res.status(404).json({ message: 'Not found' })
  const row = db.prepare('SELECT * FROM tool WHERE id = ?').get(id)
  res.json(rowToDto(row))
})

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM tool WHERE id = ?').run(req.params.id)
  if (!result.changes) return res.status(404).json({ message: 'Not found' })
  res.sendStatus(200)
})

export default router
