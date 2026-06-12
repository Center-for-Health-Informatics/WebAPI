import sql from 'mssql'
import config from './config.js'
import { loadSql, renderSql } from './sqlrender.js'

// One mssql connection pool per source, keyed by sourceKey
const pools = new Map()

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
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
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

  console.log(`[${source.sourceKey}] Populating concept_hierarchy (this may take several minutes)...`)
  const populateSql = renderSql(loadSql('ddl/concept_hierarchy_populate.sql'), source)
  const req = pool.request()
  req.timeout = 30 * 60 * 1000 // 30 minutes — vocab joins can be slow
  await req.query(populateSql)
  console.log(`[${source.sourceKey}] concept_hierarchy populated`)
}

// Eagerly open all pools on startup
export async function initSources () {
  for (const source of config.sources) {
    try {
      const pool = source.connectionString
        ? await new sql.ConnectionPool(source.connectionString).connect()
        : await new sql.ConnectionPool(buildPoolConfig(source)).connect()
      pools.set(source.sourceKey, pool)
      console.log(`Connected to source: ${source.sourceKey}`)
      initConceptHierarchy(pool, source).catch(err =>
        console.error(`[${source.sourceKey}] concept_hierarchy init failed: ${err.message}`)
      )
    } catch (err) {
      console.error(`Failed to connect to source ${source.sourceKey}: ${err.message}`)
    }
  }
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

  return {
    sourceId: id,
    sourceName: source.sourceName,
    sourceKey: source.sourceKey,
    sourceDialect: 'sql server',
    daimons
  }
}

export function getAllSourceInfos () {
  return config.sources.map((s, i) => toSourceInfo(s, i))
}
