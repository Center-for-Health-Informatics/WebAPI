import { Router } from 'express'

const router = Router()

router.all('{*splat}', (req, _res, next) => {
  req.proxyBase = req.get('x-script-name') || ''
  next()
})

export default router
