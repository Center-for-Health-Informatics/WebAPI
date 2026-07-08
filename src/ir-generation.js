import mssql from 'mssql'

// Incidence Rate analysis math — total persons / cases / person-time-at-risk
// for one (target cohort, outcome cohort) pair against an already-generated
// cohort table. Does not require CIRCE: target/outcome are references to
// cohorts that have already been generated via cohortdefinition.js.
//
// TODO: strata[].expression (a full CIRCE CriteriaGroup) is not evaluated —
// every analysis reports a single "Overall" stratum. Real per-stratum
// breakdown needs a new circe CLI entry point that compiles a standalone
// CriteriaGroup to a filtering SQL fragment.

// timeAtRisk.start/end: { DateField: 'StartDate'|'EndDate', Offset: number }
// DateField maps to the target cohort's cohort_start_date/cohort_end_date.
function dateFieldColumn (dateField, defaultField) {
  const field = dateField || defaultField
  return field === 'EndDate' ? 'cohort_end_date' : 'cohort_start_date'
}

// Builds the parameterized SQL text for one target/outcome pair. Exported
// separately from execution so the query shape can be reviewed/tested
// without a live mssql connection.
export function buildIrQuery ({ resultsSchema, cdmSchema, timeAtRisk, studyWindow }) {
  const startCol = dateFieldColumn(timeAtRisk?.start?.DateField, 'StartDate')
  const endCol = dateFieldColumn(timeAtRisk?.end?.DateField, 'EndDate')

  return `
    WITH tar AS (
      SELECT
        c.subject_id,
        CASE
          WHEN DATEADD(day, @startOffset, c.${startCol}) < op.observation_period_start_date
            THEN op.observation_period_start_date
          ELSE DATEADD(day, @startOffset, c.${startCol})
        END AS tar_start,
        CASE
          WHEN DATEADD(day, @endOffset, c.${endCol}) > op.observation_period_end_date
            THEN op.observation_period_end_date
          ELSE DATEADD(day, @endOffset, c.${endCol})
        END AS tar_end
      FROM ${resultsSchema}.cohort c
      JOIN ${cdmSchema}.observation_period op ON op.person_id = c.subject_id
      WHERE c.cohort_definition_id = @targetId
    ),
    clipped AS (
      SELECT
        subject_id,
        CASE WHEN @studyStart IS NOT NULL AND tar_start < @studyStart THEN @studyStart ELSE tar_start END AS tar_start,
        CASE WHEN @studyEnd IS NOT NULL AND tar_end > @studyEnd THEN @studyEnd ELSE tar_end END AS tar_end
      FROM tar
    ),
    eligible AS (
      SELECT * FROM clipped WHERE tar_end > tar_start
    )
    SELECT
      COUNT(*) AS totalPersons,
      COALESCE(SUM(DATEDIFF(day, tar_start, tar_end)), 0) / 365.25 AS timeAtRisk,
      (
        SELECT COUNT(DISTINCT e.subject_id)
        FROM eligible e
        JOIN ${resultsSchema}.cohort oc
          ON oc.subject_id = e.subject_id
         AND oc.cohort_definition_id = @outcomeId
         AND oc.cohort_start_date BETWEEN e.tar_start AND e.tar_end
      ) AS cases
    FROM eligible
  `
}

export async function computeIrResult (pool, { resultsSchema, cdmSchema, targetId, outcomeId, timeAtRisk, studyWindow }) {
  const query = buildIrQuery({ resultsSchema, cdmSchema, timeAtRisk, studyWindow })

  const result = await pool.request()
    .input('targetId', mssql.Int, targetId)
    .input('outcomeId', mssql.Int, outcomeId)
    .input('startOffset', mssql.Int, timeAtRisk?.start?.Offset || 0)
    .input('endOffset', mssql.Int, timeAtRisk?.end?.Offset || 0)
    .input('studyStart', mssql.Date, studyWindow?.startDate || null)
    .input('studyEnd', mssql.Date, studyWindow?.endDate || null)
    .query(query)

  const row = result.recordset[0]
  return {
    totalPersons: Number(row.totalPersons) || 0,
    cases: Number(row.cases) || 0,
    timeAtRisk: Number(row.timeAtRisk) || 0
  }
}
