import { Router } from 'express'

// The real OHDSI WebAPI's "evidence" endpoints (negative controls, drug label
// existence, drug-condition pairs) are backed by CEM (Common Evidence Model)
// tables — negative_control_concept, drug_label, sr_*, etc. These live in a
// separate CEM database/schema that is populated from a dedicated ETL
// (OHDSI CemConnector) and are NOT part of the standard OMOP CDM. None of the
// configured WEBAPI_SOURCES in this project have a CEM/CEMResults daimon, so
// there is no schema to query against.
//
// Atlas only calls these endpoints when a source advertises hasEvidence &&
// hasCEMResults (see atlas/js/services/SourceAPI.js setSharedStateSources),
// which never happens here — so in practice these routes are unreachable from
// the UI. They're implemented anyway (returning empty results / 501 for the
// generation job, matching the analysisFactory.js convention for unsupported
// generation endpoints) so that direct calls don't 404.

const router = Router()

// GET /:sourceKey/negativecontrols/:conceptSetId
// Atlas: EvidenceAPI.getNegativeControls — expects an array of negative
// control candidate rows (conceptId, conceptName, domainId, negativeControl,
// sortOrder, *PmidCount, *SplicerCount, *FaersCount, userIncluded,
// userExcluded, etc. — see atlas/js/components/evidence/options.js).
// No CEM schema exists to source this from, so return an empty list.
router.get('/:sourceKey/negativecontrols/:conceptSetId', (_req, res) => {
  res.json([])
})

// POST /:sourceKey/negativecontrols
// Atlas: EvidenceAPI.generateNegativeControls — kicks off an async job to
// (re)compute negative controls for a concept set against the CEM tables.
// There's no CEM ETL/engine backing this; return 501 like the other
// generation endpoints this codebase can't fully implement (see
// analysisFactory.js POST /:id/generation/:sourceKey).
router.post('/:sourceKey/negativecontrols', (_req, res) => {
  res.sendStatus(501)
})

// POST /:sourceKey/druglabel
// Atlas: EvidenceAPI.getDrugLabelExists — body is a bare array of concept
// ids; expects an array of { conceptId, conceptName, usaProductLabelExists }
// rows (see negative-controls.js addDrugLabelToResults, which reads
// Object.values(row)[0] as conceptId and [2] as usaProductLabelExists).
// No drug-label/FAERS derived table exists in the CDM, so return empty.
router.post('/:sourceKey/druglabel', (_req, res) => {
  res.json([])
})

// POST /:sourceKey/drugconditionpairs
// Atlas: EvidenceAPI.getDrugConditionPairs — body is
// { targetDomain, drugConceptIds, conditionConceptIds, sourceIds }; expects
// an array of evidence pair rows (uniqueIdentifier, evidenceSource,
// drugConceptId, drugConceptName, hoiConceptId, hoiConceptName, mappingType
// — see evidence-pair-viewer.js). No CEM evidence tables exist, so return
// empty.
router.post('/:sourceKey/drugconditionpairs', (_req, res) => {
  res.json([])
})

export default router
