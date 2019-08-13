/**
 * Copyright (c) 2018-present Andrey Vereshchak
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const R = require('ramda')
const utils = require('./utils')
const validate = require('./validate')

const Logger = require('./logger')
const Client = require('./postgres-client')
const Table = require('./table')
const Sequence = require('./sequence')

const _defaultOptions = {
  logging: false,
  schemaFolder: null,
  connectionConfig: null,
  force: false,
  reconnection: { attempts: Infinity, delay: 5000 },
}

const _defaultSyncOptions = {
  transaction: true,
}

const _getSchemas = ({ filePattern, pathFolder, placeholders }) => (
  fs.readdirSync(pathFolder)
    .filter((file) => filePattern.test(file))
    .map((file) => (
      utils.loadJSON(
        path.resolve(pathFolder, file),
        placeholders,
      )
    ))
)

const _calculateSuccessfulInsets = R.ifElse(
  R.is(Array),
  R.reduce((acc, insert) => acc + insert.rowCount, 0),
  R.prop('rowCount'),
)

function Differ (options) {
  options = { ..._defaultOptions, ...options }
  const {
    schemaFolder,
    placeholders,
    force,
    connectionConfig,
  } = options

  let reconnection
  let logging

  if (options.reconnection) {
    if (typeof options.reconnection === 'boolean') {
      reconnection = _defaultOptions.reconnection
    } else {
      reconnection = { ..._defaultOptions.reconnection, ...options.reconnection }
    }
  } else {
    reconnection = false
  }

  if (options.logging) {
    if (typeof options.logging === 'function') {
      logging = options.logging
    } else {
      logging = console.info
    }
  } else {
    logging = false
  }

  const logger = new Logger({ prefix: 'Postgres Differ', callback: logging })

  const _client = new Client(connectionConfig, { reconnection })
  const _tables = new Map()
  const _sequences = new Map()

  const _getDatabaseVersion = async () => {
    const { rows: [ row ] } = await _client.query('select version()')
    const version = row.version.match(/[0-9]+.[0-9]+/)
    return version ? Number(version[0]) : null
  }

  const _setup = () => {
    if (schemaFolder) {
      const schemas = _getSchemas({
        placeholders,
        pathFolder: schemaFolder,
        filePattern: /^.*\.schema.json$/,
      })
      schemas.forEach(_define)
    }
  }

  const _supportSeeds = (currentVersion) => currentVersion >= 9.5

  const _define = (type, properties) => {
    if (typeof type === 'object') {
      properties = type.properties
      type = type.type
    }

    switch (type) {
      case 'table': {
        const table = new Table({
          client: _client,
          schema: properties,
          force,
          logging,
        })
        const sequences = table._getSequences()
        sequences && sequences.forEach(([ , sequence ]) => {
          const { name } = sequence._getProperties()
          _sequences.set(name, sequence)
        })
        _tables.set(properties.name, table)
        return table
      }
      case 'sequence': {
        const sequence = new Sequence({
          client: _client,
          properties,
        })
        _sequences.set(properties.name, sequence)
        return sequence
      }
      default:
        logger.error(`Invalid schema type: ${type}`)
    }
  }

  const _getFlatAndSortedSqlList = async (orderOfOperations, promises) => {
    const result = await Promise.all(promises)
    let store = result
      .filter(Boolean)
      .map((sql) => sql.getStore())

    store = R.unnest(store)

    if (orderOfOperations) {
      store = utils.sortByList(
        R.prop('operation'),
        orderOfOperations,
        store,
      )
    }

    return store.map(R.prop('value'))
  }

  const _entitySync = async ({ entity, orderOfOperations, promises, logging = true }) => {
    let sql = await _getFlatAndSortedSqlList(orderOfOperations, promises)
    if (R.isEmpty(sql)) {
      return false
    } else {
      sql = R.uniq(sql)
      const result = []
      entity = `[ ${chalk.green(entity)} ]`
      logging && logger.info(`${entity} updating...`, sql.join('\n'))
      for (let i = 0; i < sql.length; i++) {
        result.push(await _client.query(sql[i]))
      }
      logging && logger.info(`${entity} updated successfully`, null)
      return result
    }
  }

  const sync = async (options) => {
    options = { ..._defaultSyncOptions, ...options }

    const tables = [ ..._tables.values() ]
    const sequences = [ ..._sequences.values() ]
    const databaseVersion = await _getDatabaseVersion()

    logger.info(chalk.green('Sync started'), null)
    logger.info(chalk.green(`Current version PostgreSQL: ${databaseVersion}`), null)

    options.transaction && await _client.query('begin')

    try {
      const queries = [
        await _entitySync({
          entity: 'Sequences',
          orderOfOperations: null,
          promises: sequences.map((sequence) => sequence._getSqlChanges()),
        }),
        await _entitySync({
          entity: 'Tables',
          orderOfOperations: null,
          promises: tables.map((table) => table._getSqlCreateOrAlterTable()),
        }),
        await _entitySync({
          entity: 'Extensions',
          orderOfOperations: [
            'drop foreignKey',
            'drop primaryKey',
            'drop unique',
            'delete rows',
            'add unique',
          ],
          promises: tables.map((table) => table._getSqlExtensionChanges()),
        }),
      ]

      let insertSeedCount = 0
      if (_supportSeeds(databaseVersion)) {
        const insertSeedQueries = await _entitySync({
          entity: 'Seeds',
          orderOfOperations: null,
          promises: tables.map((table) => table._getSqlInsertSeeds()),
          logging: false,
        })
        if (insertSeedQueries) {
          insertSeedCount = _calculateSuccessfulInsets(insertSeedQueries)
          logger.info(`Inserted ${chalk.green('seeds')}: ${chalk.green(insertSeedCount)}`, null)
          queries.push(insertSeedCount)
        }
      } else {
        logger.warn(`For Seeds need a PostgreSQL v9.5 or more`)
      }

      queries.push(
        await _entitySync({
          entity: 'Sequence values',
          orderOfOperations: null,
          promises: tables.map((table) => table._getSqlSequenceActualize()),
        }),
      )

      if (queries.filter(Boolean).length === 0) {
        logger.info('Database does not need updating', null)
      }

      options.transaction && await _client.query('commit')
      logger.info(chalk.green('Sync successful!'), null)

      await _client.end()
    } catch (error) {
      options.transaction && await _client.query('rollback')
      await _client.end()
      throw error
    }
  }

  const _read = async (type, options) => {
    let properties
    await _client.query('begin')
    try {
      switch (type) {
        case 'table': {
          validate.tableReading(options)
          properties = await Table._read(_client, options)
          break
        }
        case 'sequence': {
          validate.sequenceReading(options)
          properties = await Sequence._read(_client, options)
          break
        }
      }
      await _client.query('commit')
      await _client.end()
      return properties
    } catch (error) {
      await _client.query('rollback')
      await _client.end()
      throw error
    }
  }

  const read = {
    table: (options) => _read('table', options),
    sequence: (options) => _read('sequence', options),
  }

  const define = (type, properties) => {
    logger.warn(
      `The method 'define(type, properties)' is deprecated.` +
      ` Use 'define.table(properties)' or 'define.sequence(properties)'`,
    )
    return _define(type, properties)
  }

  define.table = (properties) => _define('table', properties)

  define.sequence = (properties) => _define('sequence', properties)

  _setup()

  return Object.freeze({
    sync,
    define,
    read,
  })
}

module.exports = Differ
