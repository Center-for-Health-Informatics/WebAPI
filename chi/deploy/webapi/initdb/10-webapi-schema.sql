-- Runs once, when the Postgres volume is first initialised. WebAPI's Flyway
-- migrations expect the schema to exist.
CREATE SCHEMA IF NOT EXISTS webapi AUTHORIZATION webapi;
