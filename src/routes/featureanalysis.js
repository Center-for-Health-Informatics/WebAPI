import { makeAnalysisRouter } from './analysisFactory.js'

// Feature Analysis — /feature-analysis
// Domains and aggregates are static reference lists consumed by the Atlas
// design UI (aggregate-select component) to populate the "distribute by
// field value" dropdown. All generation/export endpoints are stubs —
// execution requires external Java tooling.

const domains = [
  { id: 'Condition', name: 'Condition' },
  { id: 'ConditionEra', name: 'Condition Era' },
  { id: 'ConditionGroup', name: 'Condition Group' },
  { id: 'Death', name: 'Death' },
  { id: 'Demographic', name: 'Demographic' },
  { id: 'DoseEra', name: 'Dose Era' },
  { id: 'Drug', name: 'Drug' },
  { id: 'DrugEra', name: 'Drug Era' },
  { id: 'DrugGroup', name: 'Drug Group' },
  { id: 'Measurement', name: 'Measurement' },
  { id: 'Observation', name: 'Observation' },
  { id: 'ObservationPeriod', name: 'Observation Period' },
  { id: 'PayerPlanPeriod', name: 'Payer Plan Period' },
  { id: 'Procedure', name: 'Procedure' },
  { id: 'ProcedureGroup', name: 'Procedure Group' },
  { id: 'Specialty', name: 'Specialty' },
  { id: 'VisitCount', name: 'Visit Count' },
  { id: 'VisitOccurrence', name: 'Visit Occurrence' }
]

const aggregates = [
  { name: 'Any value', domain: 'ANY', isDefault: true },
  { name: 'Condition concept', domain: 'Condition' },
  { name: 'Condition era concept', domain: 'ConditionEra' },
  { name: 'Death', domain: 'Death' },
  { name: 'Gender', domain: 'Demographic' },
  { name: 'Age group', domain: 'Demographic' },
  { name: 'Dose era concept', domain: 'DoseEra' },
  { name: 'Drug concept', domain: 'Drug' },
  { name: 'Drug era concept', domain: 'DrugEra' },
  { name: 'Measurement concept', domain: 'Measurement' },
  { name: 'Observation concept', domain: 'Observation' },
  { name: 'Payer plan concept', domain: 'PayerPlanPeriod' },
  { name: 'Procedure concept', domain: 'Procedure' },
  { name: 'Specialty concept', domain: 'Specialty' },
  { name: 'Visit concept', domain: 'VisitOccurrence' }
]

const router = makeAnalysisRouter('feature_analysis', (r) => {
  r.get('/domains', (_req, res) => res.json(domains))
  r.get('/aggregates', (_req, res) => res.json(aggregates))
  r.get('/:id/export/conceptset', (_req, res) => res.status(501).json({ message: 'Concept set export not supported' }))
}, { paginated: true })

export default router
