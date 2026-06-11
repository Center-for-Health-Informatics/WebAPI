import { Router } from 'express'

const router = Router()

// Atlas calls these on startup to load UI translations; return empty to use Atlas defaults
router.get('/', (_req, res) => res.json({}))
router.get('/locales', (_req, res) => res.json({}))

export default router
