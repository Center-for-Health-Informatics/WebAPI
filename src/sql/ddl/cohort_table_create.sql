IF OBJECT_ID('@results_database_schema.cohort', 'U') IS NULL
CREATE TABLE @results_database_schema.cohort (
  cohort_definition_id INT    NOT NULL,
  subject_id           BIGINT NOT NULL,
  cohort_start_date    DATE   NOT NULL,
  cohort_end_date      DATE   NOT NULL
)
