import { Router } from 'express'

// Feature Extraction defaults — /featureextraction
// Mirrors FeatureExtraction R package's createCovariateSettings() defaults;
// used to seed a new Cohort Method / estimation analysis's covariate settings.

const router = Router()

router.get('/defaultcovariatesettings', (req, res) => {
  const temporal = req.query.temporal === 'true'
  res.json({
    fftype: 'covariateSettings',
    temporal,
    useDemographicsGender: true,
    useDemographicsAge: true,
    useDemographicsAgeGroup: true,
    useDemographicsRace: true,
    useDemographicsEthnicity: true,
    useDemographicsIndexYear: true,
    useDemographicsIndexMonth: true,
    useConditionOccurrenceAnyTimePrior: true,
    useConditionOccurrenceLongTerm: true,
    useConditionOccurrenceShortTerm: true,
    useDrugExposureAnyTimePrior: true,
    useDrugExposureLongTerm: true,
    useDrugExposureShortTerm: true,
    useProcedureOccurrenceAnyTimePrior: true,
    useProcedureOccurrenceLongTerm: true,
    useProcedureOccurrenceShortTerm: true,
    useMeasurementAnyTimePrior: true,
    useMeasurementLongTerm: true,
    useMeasurementShortTerm: true,
    useObservationAnyTimePrior: true,
    useObservationLongTerm: true,
    useObservationShortTerm: true,
    useVisitCountLongTerm: true,
    useVisitCountShortTerm: true,
    longTermStartDays: -365,
    mediumTermStartDays: -180,
    shortTermStartDays: -30,
    endDays: 0
  })
})

export default router
