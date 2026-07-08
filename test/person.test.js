import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { rowsToProfile } from '../src/routes/person.js'

// mssql returns recordset column names in the exact (lowercase) case written
// in the SQL templates — regression test for a bug where the DTO builder
// read UPPER_CASE fields that never matched, silently producing an empty
// profile (blank gender/records) instead of an error.
describe('rowsToProfile', () => {
  test('reads lowercase mssql column names into the camelCase DTO', () => {
    const personRow = { gender: 'FEMALE', year_of_birth: 1997 }
    const opRows = [{ observation_period_id: 1, start_date: '2001-01-01', end_date: '2025-01-01', observation_period_type: 'Standard' }]
    const recRows = [{ concept_id: 123, concept_name: 'Aspirin', domain: 'drug', start_date: '2022-01-01', end_date: '2022-01-01' }]

    const profile = rowsToProfile(personRow, opRows, recRows)

    assert.equal(profile.gender, 'FEMALE')
    assert.equal(profile.yearOfBirth, 1997)
    assert.equal(profile.observationPeriods.length, 1)
    assert.equal(profile.observationPeriods[0].id, 1)
    assert.equal(profile.observationPeriods[0].type, 'Standard')
    assert.equal(profile.records.length, 1)
    assert.equal(profile.records[0].conceptName, 'Aspirin')
    assert.equal(profile.records[0].domain, 'drug')
  })

  test('defaults gender/yearOfBirth when absent', () => {
    const profile = rowsToProfile({}, [], [])
    assert.equal(profile.gender, '')
    assert.equal(profile.yearOfBirth, 0)
    assert.deepEqual(profile.observationPeriods, [])
    assert.deepEqual(profile.records, [])
  })
})
