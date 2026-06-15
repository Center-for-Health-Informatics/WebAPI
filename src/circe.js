import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const JAR = path.join(__dirname, '..', 'lib', 'circe.jar')

export function generateCohortSql (expression, { cohortId, cdmSchema, targetTable, resultSchema, vocabularySchema }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('java', ['-jar', JAR])
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`CIRCE exit ${code}: ${err.trim()}`))
      else resolve(out)
    })
    proc.on('error', reject)
    proc.stdin.end(JSON.stringify({ cohortId, cdmSchema, targetTable, resultSchema, vocabularySchema, expression }))
  })
}
