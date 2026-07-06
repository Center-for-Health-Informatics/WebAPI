import sql from 'mssql'
import config from './config.js'
import { loadSql, renderSql } from './sqlrender.js'

// One mssql connection pool per source, keyed by sourceKey
const pools = new Map()

// Connection status per source, keyed by sourceKey — { connected, error, lastAttempt }
const statuses = new Map()

// Build a config object for a dedicated no-timeout pool used by long-running DDL jobs.
// mssql's ConnectionPool only parses a connection string when passed as a bare string —
// an object with a `connectionString` key is used as-is, leaving `config.server` unset.
function buildDdlPoolConfig (source) {
  const base = source.connectionString
    ? sql.ConnectionPool.parseConnectionString(source.connectionString)
    : buildPoolConfig(source)
  return { ...base, requestTimeout: 0 }
}

function buildPoolConfig (source) {
  return {
    server: source.server,
    port: source.port || 1433,
    database: source.database,
    user: source.username,
    password: source.password,
    connectionString: source.connectionString || undefined,
    options: {
      encrypt: source.encrypt !== false,
      trustServerCertificate: source.trustServerCertificate || false,
      enableArithAbort: true
    },
    requestTimeout: 60000,
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  }
}

// Create achilles_result_concept_count if missing and populate it from achilles_results.
// Runs in the background after pool connects — does not block startup.
async function initConceptCount (pool, source) {
  if (!source.resultsSchema || !source.vocabSchema) return

  const createSql = renderSql(loadSql('ddl/concept_count_create.sql'), source)
  await pool.request().query(createSql)

  const countSql = renderSql('SELECT COUNT(*) AS cnt FROM @results_database_schema.achilles_result_concept_count', source)
  try {
    const { recordset } = await pool.request().query(countSql)
    if (recordset[0].cnt > 0) return
  } catch (err) {
    if (err.number === 208) return  // achilles_results doesn't exist yet
    throw err
  }

  const ddlPool = await new sql.ConnectionPool(buildDdlPoolConfig(source)).connect()
  try {
    console.log(`[${source.sourceKey}] Populating achilles_result_concept_count...`)
    const populateSql = renderSql(loadSql('ddl/concept_count_populate.sql'), source)
    await ddlPool.request().query(populateSql)
    console.log(`[${source.sourceKey}] achilles_result_concept_count populated`)
  } finally {
    await ddlPool.close()
  }
}

// Create concept_hierarchy if missing and populate it if empty.
// Runs in the background after pool connects — does not block startup.
async function initConceptHierarchy (pool, source) {
  if (!source.resultsSchema || !source.vocabSchema) return

  const createSql = renderSql(loadSql('ddl/concept_hierarchy_create.sql'), source)
  await pool.request().query(createSql)

  const countSql = renderSql('SELECT COUNT(*) AS cnt FROM @results_database_schema.concept_hierarchy', source)
  const { recordset } = await pool.request().query(countSql)
  if (recordset[0].cnt > 0) return

  // requestTimeout is baked into the tedious connection, not settable per-request,
  // so use a dedicated pool with no timeout for the long-running vocab joins.
  const ddlPool = await new sql.ConnectionPool(buildDdlPoolConfig(source)).connect()
  try {
    console.log(`[${source.sourceKey}] Populating concept_hierarchy (this may take several minutes)...`)
    const populateSql = renderSql(loadSql('ddl/concept_hierarchy_populate.sql'), source)
    await ddlPool.request().query(populateSql)
    console.log(`[${source.sourceKey}] concept_hierarchy populated`)
  } finally {
    await ddlPool.close()
  }
}

async function initCohortTable (pool, source) {
  if (!source.resultsSchema) return
  const createSql = renderSql(loadSql('ddl/cohort_table_create.sql'), source)
  await pool.request().query(createSql)
}

async function initStatsTable (pool, source) {
  if (!source.resultsSchema) return
  const createSql = renderSql(loadSql('ddl/cohort_stats_create.sql'), source)
  await pool.request().query(createSql)
}

// Attempt to connect a single source, updating pools/statuses. Returns true on success.
async function connectSource (source) {
  try {
    const pool = source.connectionString
      ? await new sql.ConnectionPool(source.connectionString).connect()
      : await new sql.ConnectionPool(buildPoolConfig(source)).connect()
    pools.set(source.sourceKey, pool)
    statuses.set(source.sourceKey, { connected: true, error: null, lastAttempt: new Date() })
    console.log(`Connected to source: ${source.sourceKey}`)
    initCohortTable(pool, source).catch(err =>
      console.error(`[${source.sourceKey}] cohort table init failed: ${err.message}`)
    )
    initStatsTable(pool, source).catch(err =>
      console.error(`[${source.sourceKey}] cohort stats tables init failed: ${err.message}`)
    )
    initConceptHierarchy(pool, source).catch(err =>
      console.error(`[${source.sourceKey}] concept_hierarchy init failed: ${err.message}`)
    )
    initConceptCount(pool, source).catch(err =>
      console.error(`[${source.sourceKey}] achilles_result_concept_count init failed: ${err.message}`)
    )
    return true
  } catch (err) {
    statuses.set(source.sourceKey, { connected: false, error: err.message, lastAttempt: new Date() })
    console.error(`Failed to connect to source ${source.sourceKey}: ${err.message}`)
    return false
  }
}

// Eagerly open all pools on startup
export async function initSources () {
  for (const source of config.sources) {
    await connectSource(source)
  }
}

// Re-attempt connection for any source that isn't currently connected.
// Does not touch sources that are already connected — avoids dropping a live pool.
export async function refreshSources () {
  for (const source of config.sources) {
    if (!pools.has(source.sourceKey)) {
      await connectSource(source)
    }
  }
  return getAllSourceInfos()
}

// Get a connected pool by sourceKey; throws if not found
export function getPool (sourceKey) {
  const pool = pools.get(sourceKey)
  if (!pool) throw Object.assign(new Error(`Unknown source: ${sourceKey}`), { status: 404 })
  return pool
}

// Get source config object by sourceKey; throws if not found
export function getSource (sourceKey) {
  const source = config.sources.find(s => s.sourceKey === sourceKey)
  if (!source) throw Object.assign(new Error(`Unknown source: ${sourceKey}`), { status: 404 })
  return source
}

// Build the Atlas-compatible SourceInfo shape for one source
export function toSourceInfo (source, index) {
  const id = index + 1
  const daimonBase = id * 10
  const daimons = []

  if (source.cdmSchema) {
    daimons.push({ sourceDaimonId: daimonBase + 1, daimonType: 'CDM', tableQualifier: source.cdmSchema, priority: 0 })
  }
  if (source.vocabSchema) {
    daimons.push({ sourceDaimonId: daimonBase + 2, daimonType: 'Vocabulary', tableQualifier: source.vocabSchema, priority: 0 })
  }
  if (source.resultsSchema) {
    daimons.push({ sourceDaimonId: daimonBase + 3, daimonType: 'Results', tableQualifier: source.resultsSchema, priority: 0 })
  }
  if (source.tempSchema) {
    daimons.push({ sourceDaimonId: daimonBase + 4, daimonType: 'Temp', tableQualifier: source.tempSchema, priority: 0 })
  }

  const status = statuses.get(source.sourceKey)

  return {
    sourceId: id,
    sourceName: source.sourceName,
    sourceKey: source.sourceKey,
    sourceDialect: 'sql server',
    daimons,
    sourceStatus: status
      ? (status.connected ? 'connected' : 'disconnected')
      : 'unknown',
    sourceStatusError: status && !status.connected ? status.error : undefined
  }
}

export function getAllSourceInfos () {
  return config.sources.map((s, i) => toSourceInfo(s, i))
}
