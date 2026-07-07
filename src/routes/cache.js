import { Router } from 'express'

const router = Router()

router.get('/clear', (_req, res) => res.json({}))

export default router
