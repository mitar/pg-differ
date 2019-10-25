/**
 * Copyright (c) 2018-present Andrey Vereshchak
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const R = require('ramda')
const utils = require('./utils')
const { TYPES, COLUMNS, EXTENSIONS, SEQUENCES } = require('./constants')

exports.getTypeGroup = (type) => {
  if (type) {
    type = exports.trimType(type)
    return Object.values(TYPES.GROUPS)
      .find((group) => group.includes(type))
  }
}

const regExpTypeOptions = /\[]|\[\w+]|\(\w+\)|'(\w+|\d+)'/g

exports.trimType = (type) =>
  type.replace(regExpTypeOptions, '').trim()

exports.normalizeType = (type) => {
  const values = type.match(regExpTypeOptions) || []
  type = exports.trimType(type)

  // decode type alias
  const aliasDescription = TYPES.ALIASES[type]
  if (utils.isExist(aliasDescription)) {
    type = TYPES.ALIASES[type]
  }
  return values ? `${type}${values.join('')}` : type
}

exports.defaultValueInformationSchema = (value) => {
  switch (typeof value) {
    case 'string': {
      // adding the public scheme in case of its absence
      value = value.replace(/(?<=nextval\(')(?=[^.]*$)/, 'public.')
      //
      const regExp = /::[a-zA-Z ]+(?:\[\d+]|\[]){0,2}$/
      if (value.match(regExp)) {
        return value.replace(regExp, '')
      } else {
        return value
      }
    }
    default: {
      return value
    }
  }
}

exports.checkCondition = (definition) => definition.match(/[^(]+(?=\))/)[0]

exports.normalizeAutoIncrement = (value) => {
  if (R.is(Object, value)) {
    return {
      ...SEQUENCES.DEFAULTS,
      ...value,
    }
  } else if (value) {
    return { ...SEQUENCES.DEFAULTS }
  }
  return value
}

exports.encodeValue = (value) => {
  switch (typeof value) {
    case 'number' :
      return value
    case 'string': {
      const regExp = /::sql$/
      if (value.match(regExp)) {
        return value.replace(regExp, '')
      } else {
        return exports.quoteLiteral(value)
      }
    }
    default: {
      return R.is(Object, value)
        ? exports.quoteLiteral(JSON.stringify(value))
        : value
    }
  }
}

exports.decodeValue = (value, type) => {
  if (typeof value === 'string') {
    const bracketsContent = /(?<=^').*(?='$)/
    const typeGroup = exports.getTypeGroup(type)
    const defaultValue = `${value}::sql`
    switch (typeGroup) {
      case TYPES.GROUPS.JSON: {
        const match = value.match(bracketsContent)
        return match ? JSON.parse(match[0]) : defaultValue
      }
      case TYPES.GROUPS.INTEGER: {
        const match = value.match(/^[0-9]*$/)
        return match ? match[0] : defaultValue
      }
      case TYPES.GROUPS.BOOLEAN: {
        if (value === 'true') {
          return true
        } else if (value === 'false') {
          return false
        } else {
          return defaultValue
        }
      }
      default: {
        const match = value.match(bracketsContent)
        return match ? match[0] : defaultValue
      }
    }
  } else {
    return value
  }
}

const _encodeExtensionTypes = {
  primaryKey: EXTENSIONS.TYPES.PRIMARY_KEY,
  unique: EXTENSIONS.TYPES.UNIQUE,
  foreignKey: EXTENSIONS.TYPES.FOREIGN_KEY,
  index: EXTENSIONS.TYPES.INDEX,
  check: EXTENSIONS.TYPES.CHECK,
}

exports.encodeExtensionType = (key) => _encodeExtensionTypes[key] || null

const _cleanableDefaults = {
  primaryKey: true,
  foreignKey: false,
  unique: false,
  check: false,
}

const _encryptedNamesListExtensions = {
  primaryKeys: 'primaryKey',
  indexes: 'index',
  foreignKeys: 'foreignKey',
  checks: 'check',
  unique: 'unique',
}

const _getExtensionDefaults = (listName) => {
  const type = _encryptedNamesListExtensions[listName]
  if (type === 'foreignKey') {
    return { type, ...EXTENSIONS.FOREIGN_KEY_DEFAULTS }
  } else {
    return { type }
  }
}

const _normalizeCleanableObject = (object) => {
  if (object) {
    const encrypted = Object.entries(object)
      .reduce((acc, [ listName, value ]) => {
        acc[_encryptedNamesListExtensions[listName]] = value
        return acc
      }, {})
    return { ..._cleanableDefaults, ...encrypted }
  }
  return _cleanableDefaults
}

exports.schema = (schema) => {
  const columns = schema.columns
    .map((column) => {
      column = {
        ...COLUMNS.DEFAULTS,
        ...R.pick(COLUMNS.ALL_PROPERTIES, column),
      }

      const type = exports.normalizeType(column['type'])
      const defaultValue = exports.encodeValue(column.default)
      const autoIncrement = exports.normalizeAutoIncrement(column.autoIncrement)

      return {
        ...column,
        type,
        autoIncrement,
        default: defaultValue,
      }
    })

  const extensions = R.pipe(
    R.pick([ 'indexes', 'unique', 'foreignKeys', 'primaryKeys' ]), // without 'checks'
    R.toPairs,
    R.reduce((acc, [ listName, elements ]) => {
      if (elements) {
        const defaults = _getExtensionDefaults(listName)
        acc[defaults.type] = elements.map((props) => ({ ...defaults, ...props }))
      }
      return acc
    }, {}),
    R.mergeWith(R.concat, _getExtensionsFromColumns(columns)),
  )(schema)

  const cleanable = _normalizeCleanableObject(schema.cleanable)

  return {
    name: schema.name,
    force: schema.force,
    seeds: schema.seeds,
    checks: schema.checks,
    columns,
    extensions,
    cleanable,
  }
}

const _getExtensionsFromColumns = (
  R.pipe(
    R.reduce((acc, column) => (
      R.pipe(
        R.pick(COLUMNS.EXTENSIONS),
        R.toPairs,
        R.map(([ type, value ]) => value === true ? ({ type, columns: [ column.name ] }) : null),
        R.filter(Boolean),
        R.concat(acc),
      )(column)
    ), []),
    R.groupBy(R.prop('type')),
  )
)

exports.quoteLiteral = (value) => {
  const literal = value.slice(0) // create copy

  let hasBackslash = false
  let quoted = '\''

  for (let i = 0; i < literal.length; i++) {
    const c = literal[i]
    if (c === '\'') {
      quoted += c + c
    } else if (c === '\\') {
      quoted += c + c
      hasBackslash = true
    } else {
      quoted += c
    }
  }

  quoted += '\''

  if (hasBackslash === true) {
    quoted = 'E' + quoted
  }

  return quoted
}

exports.separateSchema = (name) => {
  const chunks = name.split('.')
  return [
    chunks[1] ? chunks[0] : undefined,
    chunks[1] || chunks[0],
  ]
}

exports.dbSequence = (response) => {
  if (response) {
    const {
      start_value: start,
      minimum_value: min,
      maximum_value: max,
      cycle_option: cycle,
      increment,
    } = response
    return { start, min, max, increment, cycle: cycle === 'YES' }
  }
}
