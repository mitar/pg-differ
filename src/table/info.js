/**
 * Copyright (c) 2018-present Andrey Vereshchak
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const R = require('ramda')

const queries = require('./queries')
const parser = require('../parser')

/**
 * @typedef {object} TableInfo
 * @property {function} getRows
 * @property {function} getChecks
 */

/**
 *
 * @param {object} options
 * @param {PostgresClient} options.client
 * @param {string} options.name
 * @returns {TableInfo}
 */

function TableInfo (options) {
  const { client, name } = options

  const getRows = (orderBy, range) => (
    client.query(
      queries.getRows(name, orderBy, range),
    ).then(
      R.pipe(
        R.prop('rows'),
      ),
    )
  )

  const getChecks = (table = name) => (
    client.query(
      queries.getChecks(table),
    ).then(
      R.pipe(
        R.prop('rows'),
        R.map(({ name, definition }) => ({
          name,
          condition: parser.checkCondition(definition),
        })),
      ),
    )
  )

  return Object.freeze({
    getRows,
    getChecks,
  })
}

module.exports = TableInfo
