-- Derive achilles_result_concept_count from achilles_results + concept_ancestor.
-- Uses analysis IDs from the x01 family (record counts by concept_id in stratum_1).
WITH direct_counts AS (
  SELECT
    TRY_CAST(stratum_1 AS INT) AS concept_id,
    SUM(count_value)           AS record_count
  FROM @results_database_schema.achilles_results
  WHERE analysis_id IN (201, 401, 501, 601, 701, 801, 901, 1001, 1801, 2101)
    AND TRY_CAST(stratum_1 AS INT) IS NOT NULL
    AND TRY_CAST(stratum_1 AS INT) != 0
  GROUP BY stratum_1
),
descendant_counts AS (
  SELECT
    ca.ancestor_concept_id    AS concept_id,
    SUM(dc.record_count)      AS descendant_record_count
  FROM @vocabulary_database_schema.concept_ancestor ca
  JOIN direct_counts dc ON ca.descendant_concept_id = dc.concept_id
  GROUP BY ca.ancestor_concept_id
)
INSERT INTO @results_database_schema.achilles_result_concept_count
  (concept_id, record_count, descendant_record_count)
SELECT
  COALESCE(d.concept_id, desc_c.concept_id),
  COALESCE(d.record_count, 0),
  COALESCE(desc_c.descendant_record_count, d.record_count, 0)
FROM direct_counts d
FULL OUTER JOIN descendant_counts desc_c ON d.concept_id = desc_c.concept_id
