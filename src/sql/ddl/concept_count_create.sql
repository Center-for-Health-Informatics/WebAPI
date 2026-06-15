IF OBJECT_ID('@results_database_schema.achilles_result_concept_count', 'U') IS NULL
CREATE TABLE @results_database_schema.achilles_result_concept_count (
  concept_id              INT,
  record_count            BIGINT,
  descendant_record_count BIGINT
)
