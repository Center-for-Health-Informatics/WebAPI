import { Router } from 'express'

// Entity access control — /permission
// This environment has no real role/permission store (the auth-header
// middleware grants a wildcard permissionIdx to every user), so grants and
// revokes are accepted but not persisted, and access lists are always empty —
// consistent with access control being the fronting proxy's responsibility.

const router = Router()

router.get('/', (_req, res) => res.json([]))

router.get('/access/suggest', (_req, res) => res.json([]))

router.get('/access/:entityType/:entityId/:permType', (_req, res) => res.json([]))

router.post('/access/:entityType/:entityId/role/:roleId', (_req, res) => res.sendStatus(200))

router.delete('/access/:entityType/:entityId/role/:roleId', (_req, res) => res.sendStatus(200))

export default router
