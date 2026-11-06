-- WebAPI 3 schemas and permissions on the CDM database (OMOP_CDM_2026).
-- Run once by someone with db_owner (or a DBA), with sqlcmd:
--
--   sqlcmd -S chi-resdbstg.healthall.com -d OMOP_CDM_2026 -b \
--     -v WEBAPI_USER=<database user WebAPI connects as> -i 10-schemas.sql
--
-- (or paste into SSMS with SQLCMD mode on). Safe to re-run.
--
-- New schemas, so the Node demo's results/temp tables are left alone until
-- it is retired. WebAPI reads the CDM and vocabulary (dbo) and writes only
-- to webapi_results and webapi_temp.

IF SCHEMA_ID('webapi_results') IS NULL EXEC('CREATE SCHEMA webapi_results AUTHORIZATION dbo');
IF SCHEMA_ID('webapi_temp') IS NULL EXEC('CREATE SCHEMA webapi_temp AUTHORIZATION dbo');
GO

-- CDM + vocabulary: read-only
GRANT SELECT ON SCHEMA::dbo TO [$(WEBAPI_USER)];

-- Results and temp: create, change and drop tables; read and write rows.
-- CREATE TABLE is database-level, but only usable in schemas where the user
-- also holds ALTER.
GRANT CREATE TABLE TO [$(WEBAPI_USER)];
GRANT ALTER, SELECT, INSERT, UPDATE, DELETE, REFERENCES ON SCHEMA::webapi_results TO [$(WEBAPI_USER)];
GRANT ALTER, SELECT, INSERT, UPDATE, DELETE, REFERENCES ON SCHEMA::webapi_temp TO [$(WEBAPI_USER)];
GO

SELECT s.name AS [schema], p.permission_name
FROM sys.database_permissions p
JOIN sys.schemas s ON p.class = 3 AND s.schema_id = p.major_id
WHERE p.grantee_principal_id = DATABASE_PRINCIPAL_ID('$(WEBAPI_USER)')
ORDER BY 1, 2;
