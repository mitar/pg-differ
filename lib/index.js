/**
 * Copyright (c) 2018-present Andrew Vereshchak
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const chalk = require('chalk');
const utils = require('./utils');
const helpers = require('./helpers');
const parser = require('./parser');
const path = require('path');
const validate = require('./validate');
const errors = require('./errors');

const Metalize = require('metalize');

const { Client } = require('pg');

const Logger = require('./logger');
const ConnectionManager = require('./connection-manager');

const Table = require('./objects/table');
const Sequence = require('./objects/sequence');

const _defaultOptions = {
  logging: false,
  connectionConfig: null,
  defaultSchema: 'public',
};

class Differ {
  constructor(options) {
    options = { ..._defaultOptions, ...options };
    this._defaultSchema = options.defaultSchema;

    let loggingCallback;
    if (options.logging && typeof options.logging === 'function') {
      loggingCallback = options.logging;
    }

    this._logger = new Logger({
      logging: options.logging,
      callback: loggingCallback,
    });

    this._connectionConfig = options.connectionConfig;

    this._metalize = new Metalize('postgres');

    this.objects = new Map();
  }

  setDefaultSchema(schema) {
    this._defaultSchema = schema;
    return this;
  }

  getDefaultSchema() {
    return this._defaultSchema;
  }

  import(...args) {
    let options;
    if (typeof args[0] === 'string') {
      options = { path: args[0], locals: args[1] };
    } else {
      options = { ...args[0] };
    }
    // is it a relative path?
    if (path.normalize(options.path) !== path.resolve(options.path)) {
      // make path relative to the caller
      const callerFilename = utils.getCaller();
      const callerPath = path.dirname(callerFilename);
      options.path = path.resolve(callerPath, options.path);
    }

    helpers.importSchemas(options).forEach((schema) => {
      this.define(schema.type, schema.properties);
    });

    return this;
  }

  _createObject(type, properties) {
    let Controller;
    switch (type) {
      case 'table': {
        Controller = Table;
        break;
      }
      case 'sequence': {
        Controller = Sequence;
        break;
      }
      default:
        throw new errors.ValidationError({
          path: 'type',
          message: `should be one of ['table', 'sequence']`,
        });
    }
    validate[type]('properties', properties);
    return new Controller(this, properties);
  }

  define(type, properties) {
    const object = this._createObject(type, properties);
    this.objects.set(properties.name, object);
    return object;
  }

  async _prepare(client, options) {
    const values = [...this.objects.values()];

    const objects = {
      tables: values.filter((object) => object.type === 'table'),
      sequences: values.filter((object) => object.type === 'sequence'),
    };

    const metadata = await this._metalize.find(
      {
        tables: objects.tables.map((t) => t.getObjectName()),
        sequences: objects.sequences.map((s) => s.getObjectName()),
      },
      { client }
    );

    const promises = {
      updatingSequences: [],
      cleaningExtensions: [],
      updatingTables: [],
      creatingExtensions: [],
      updatingIdentities: [],
    };

    for (const sequence of objects.sequences) {
      const structure = metadata.sequences.get(sequence.getObjectName());
      promises.updatingSequences.push(
        sequence._getChangeQueries(client, structure, options)
      );
    }

    for (const table of objects.tables) {
      const structure = metadata.tables.get(table.getObjectName());
      const extensions = [
        // order is important
        'index',
        'check',
        'unique',
        'primaryKey',
        'foreignKey',
      ];
      extensions.forEach((type) => {
        promises.creatingExtensions.push(
          table._getAddExtensionQueries(client, type, structure, options)
        );
      });
      extensions.reverse().forEach((type) => {
        promises.cleaningExtensions.push(
          table._getExtensionCleanupQueries(client, type, structure, options)
        );
      });
      promises.updatingTables.push(
        table._getCreateOrAlterTableQueries(client, structure, options)
      );
      promises.updatingIdentities.push(
        table._getIdentityUpdateQueries(client, structure, options)
      );
    }

    const result = await Promise.all([
      // order is important
      ...promises.updatingSequences,
      ...promises.cleaningExtensions,
      ...promises.updatingTables,
      ...promises.creatingExtensions,
      ...promises.updatingIdentities,
    ]);

    return utils.unnest(result.map((i) => i.values()));
  }

  async _execute(client, queries) {
    const results = [];
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      this._logger.log(query);
      results.push(await client.query(query));
    }
    return results;
  }

  async sync(options) {
    options = parser.syncOptions(options);

    let error;
    let preparedChanges;
    let client;

    this._logger.info(chalk.green('Sync started'));

    if (this._connectionConfig instanceof Client) {
      client = this._connectionConfig;
    } else {
      client = ConnectionManager.getClient(this._connectionConfig);
      await client.connect();
    }

    try {
      await client.query('set search_path to public');
      preparedChanges = await ConnectionManager.transaction(
        client,
        () => this._prepare(client, options),
        options.transaction
      );
      if (preparedChanges.length === 0) {
        this._logger.info('Database does not need updating');
      } else {
        await ConnectionManager.transaction(
          client,
          () => this._execute(client, preparedChanges),
          options.transaction
        );
      }
    } catch (e) {
      error = e;
    }

    if (!(this._connectionConfig instanceof Client)) {
      await client.end();
    }

    if (error) throw error;

    this._logger.info(chalk.green('Sync successful'));

    return { queries: preparedChanges };
  }
}

Differ.Error = errors.BaseError;

for (const error of Object.keys(errors)) {
  Differ[error] = errors[error];
}

module.exports = Differ;
