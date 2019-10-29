/**
 * Copyright (c) 2018-present Andrey Vereshchak
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const R = require('ramda');
const Metalize = require('metalize');
const parser = require('../parser');
const Sql = require('../sql');
const utils = require('../utils');
const queries = require('./queries');
const validate = require('../validate');

const { DEFAULTS, ATTRIBUTES } = require('../constants/sequences');

/**
 * @typedef {object} Sequence
 * @property {function} _getSqlChanges
 * @property {function} _getQueryIncrement
 * @property {function} _getQueryRestart
 * @property {function} _getCurrentValue
 */

/**
 *
 * @param {object} options
 * @param {PostgresClient} options.client
 * @returns {Sequence}
 */
function Sequence(options) {
  let { properties, client, force } = options;

  properties = validate.sequenceDefinition({ ...DEFAULTS, ...properties });
  const _forceCreate = R.isNil(properties.force) ? force : properties.force;
  const [schema = 'public', name] = parser.separateSchema(properties.name);
  const _fullName = `${schema}.${name}`;

  const _buildSql = ({ action, ...rest }) => {
    const chunks = [];
    Object.entries(rest).forEach(([key, value]) => {
      switch (key) {
        case 'start':
          value ? chunks.push(`start ${value}`) : chunks.push('no start');
          break;
        case 'increment':
          value
            ? chunks.push(`increment ${value}`)
            : chunks.push(`increment ${DEFAULTS.increment}`);
          break;
        case 'min':
          value ? chunks.push(`minvalue ${value}`) : chunks.push('no minvalue');
          break;
        case 'max':
          value ? chunks.push(`maxvalue ${value}`) : chunks.push('no maxvalue');
          break;
        case 'cycle':
          value ? chunks.push('cycle') : chunks.push('no cycle');
          break;
        case 'current':
          utils.isExist(value) && chunks.push(`restart with ${value}`);
          break;
        default:
          break;
      }
    });

    if (chunks.length) {
      chunks.unshift(`${action} sequence ${_fullName}`);
      return new Sql(Sql.create(`${action} sequence`, chunks.join(' ') + ';'));
    }

    return null;
  };

  const _getDifference = (a, b) =>
    ATTRIBUTES.reduce((acc, key) => {
      const leftValue = a[key];
      const rightValue = b[key];
      if (String(leftValue) !== String(rightValue)) {
        acc[key] = leftValue;
      }
      return acc;
    }, {});

  const _getSqlChanges = async structures => {
    if (_forceCreate) {
      return new Sql([
        Sql.create(
          'drop sequence',
          `drop sequence if exists ${_fullName} cascade;`
        ),
        ..._buildSql({ action: 'create', ...properties }).getStore(),
      ]);
    } else {
      const structure = structures.get(_fullName);
      if (structure) {
        const diff = _getDifference(properties, structure);
        if (utils.isExist(diff.min) || utils.isExist(diff.max)) {
          const {
            rows: [{ correct }],
          } = await client.query(
            queries.hasCorrectCurrValue(
              _fullName,
              properties.min,
              properties.max
            )
          );
          if (!correct) {
            diff.current = properties.min;
          }
        }
        return _buildSql({ action: 'alter', ...diff });
      } else {
        return _buildSql({ action: 'create', ...properties });
      }
    }
  };

  const _getProperties = () => ({ ...properties });

  const _getQueryIncrement = () => queries.increment(_fullName);

  const _getQueryRestart = value => queries.restart(_fullName, value);

  const _getCurrentValue = async () => {
    const {
      rows: [{ currentValue }],
    } = await client.query(queries.getCurrentValue(_fullName));
    return currentValue;
  };

  return Object.freeze({
    _getSqlChanges,
    _getQueryIncrement,
    _getProperties,
    _getQueryRestart,
    _getCurrentValue,
    _name: _fullName,
  });
}

Sequence._read = async (client, options) => {
  const [_schemaName = 'public', _sequenceName] = parser.separateSchema(
    options.name
  );
  const fullName = `${_schemaName}.${_sequenceName}`;
  const metalize = new Metalize({ client, dialect: 'postgres' });
  const structures = await metalize.read.sequences([fullName]);
  return structures.get(fullName);
};

module.exports = Sequence;
