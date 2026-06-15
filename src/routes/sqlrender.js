import { Router } from 'express'

const router = Router()

// POST /sqlrender/translate
// Atlas calls this to translate CIRCE-generated SQL Server SQL to other dialects.
// We only support SQL Server (CIRCE output is already SQL Server), so we pass through
// unchanged for 'sql server' and return the original for other dialects with a comment.
router.post('/translate', (req, res) => {
  const { SQL = '', targetdialect = 'sql server' } = req.body || {}
  const isNative = targetdialect.toLowerCase().replace(/[^a-z]/g, '') === 'sqlserver'
  const targetSQL = isNative
    ? SQL
    : `-- Note: dialect translation to '${targetdialect}' is not supported; SQL Server syntax shown.\n${SQL}`
  res.json({ targetSQL, targetDialect: targetdialect })
})

export default router
