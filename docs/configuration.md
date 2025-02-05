# Configuration

### connectionConfig

- Type: `object | Client`
- Default: `null`
- Required: `true`

Connection configuration object for [node-postgres](https://node-postgres.com/features/connecting#programmatic).

It can be an existing `pg.Client` instance, too. In this case the instance already has to be connected.

### defaultSchema

- Type: `string`
- Default: `'public'`
- Required: `false`

It will be used in objects whose names do not contain a schema name.

### logging

- Type: `boolean | function`
- Default: `console.info`
- Required: `false`

Option to enable logging in the console or callback of the format `function(...messages) {}` for displaying a message about changes.
