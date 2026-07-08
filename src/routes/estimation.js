import { makeAnalysisRouter } from './analysisFactory.js'

// Population-Level Estimation — /estimation
// Execution requires the ARACHNE execution engine; all generation endpoints return 501/[].

const router = makeAnalysisRouter('estimation', (r) => {
  r.get('/:id/download', (_req, res) => res.sendStatus(501))
  // POST /check → design diagnostics; return empty warnings ({ warnings: [] } shape required by Atlas warnings.js)
  r.post('/check', (_req, res) => res.json({ warnings: [] }))
})

export default router
