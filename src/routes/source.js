import { Router } from 'express'
import { getAllSourceInfos, refreshSources, toSourceInfo, getSource } from '../sources.js'
import config from '../config.js'

const router = Router()

// List all sources
router.get('/sources', (req, res) => {
  res.json(getAllSourceInfos())
})

// Refresh endpoint — re-attempts connecting any source that isn't currently connected
router.get('/refresh', async (req, res) => {
  res.json(await refreshSources())
})

// Priority vocabulary source — first source that has a Vocabulary daimon
router.get('/priorityVocabulary', (req, res) => {
  const idx = config.sources.findIndex(s => s.vocabSchema)
  if (idx === -1) return res.status(404).json({ message: 'No vocabulary source configured' })
  res.json(toSourceInfo(config.sources[idx], idx))
})

// Priority source per daimon type — returns { CDM: SourceInfo, Vocabulary: SourceInfo, ... }
router.get('/daimon/priority', (req, res) => {
  const result = {}
  const daimonChecks = [
    ['CDM', s => s.cdmSchema],
    ['Vocabulary', s => s.vocabSchema],
    ['Results', s => s.resultsSchema],
    ['Temp', s => s.tempSchema],
  ]
  for (const [type, hasDaimon] of daimonChecks) {
    const idx = config.sources.findIndex(hasDaimon)
    if (idx !== -1) result[type] = toSourceInfo(config.sources[idx], idx)
  }
  res.json(result)
})

// Single source by key
router.get('/:key', (req, res, next) => {
  try {
    const source = getSource(req.params.key)
    const idx = config.sources.indexOf(source)
    res.json(toSourceInfo(source, idx))
  } catch (err) {
    next(err)
  }
})

export default router
