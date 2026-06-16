import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toCamelCase, normalizeRow } from '../src/routes/cdmresults.js'

describe('toCamelCase', () => {
  test('passes through strings without underscores unchanged', () => {
    assert.equal(toCamelCase('conceptId'), 'conceptId')
    assert.equal(toCamelCase('numPersons'), 'numPersons')
    assert.equal(toCamelCase('attributeName'), 'attributeName')
  })

  test('converts lower_snake_case to camelCase', () => {
    assert.equal(toCamelCase('concept_id'), 'conceptId')
    assert.equal(toCamelCase('num_persons'), 'numPersons')
    assert.equal(toCamelCase('attribute_name'), 'attributeName')
    assert.equal(toCamelCase('records_per_person'), 'recordsPerPerson')
  })

  test('converts UPPER_SNAKE_CASE to camelCase', () => {
    assert.equal(toCamelCase('ANALYSIS_ID'), 'analysisId')
    assert.equal(toCamelCase('COUNT_VALUE'), 'countValue')
  })
})

describe('normalizeRow', () => {
  test('converts all snake_case keys to camelCase', () => {
    assert.deepEqual(
      normalizeRow({ concept_id: 1, attribute_name: 'Age', num_persons: 42 }),
      { conceptId: 1, attributeName: 'Age', numPersons: 42 }
    )
  })

  test('preserves values of all types', () => {
    assert.deepEqual(
      normalizeRow({ num_persons: 0, percent_persons: 0.5, concept_name: 'Foo', is_valid: null }),
      { numPersons: 0, percentPersons: 0.5, conceptName: 'Foo', isValid: null }
    )
  })

  test('passes through already-camelCase keys unchanged', () => {
    assert.deepEqual(normalizeRow({ conceptId: 1 }), { conceptId: 1 })
  })

  test('handles empty row', () => {
    assert.deepEqual(normalizeRow({}), {})
  })
})
