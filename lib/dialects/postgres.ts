import { Knex } from 'knex';
import { SchemaInspector } from '../types/schema-inspector';
import { Table } from '../types/table';
import { Column } from '../types/column';
import { ForeignKey } from '../types/foreign-key';

type RawTable = {
  table_name: string;
  table_schema: 'public' | string;
  table_comment: string | null;
};

type RawColumn = {
  column_name: string;
  table_name: string;
  table_schema: string;
  data_type: string;
  column_default: any | null;
  character_maximum_length: number | null;
  is_nullable: 'YES' | 'NO';
  is_unique: 'YES' | 'NO';
  is_primary: null | 'YES';
  numeric_precision: null | number;
  numeric_scale: null | number;
  serial: null | string;
  column_comment: string | null;
  referenced_table_schema: null | string;
  referenced_table_name: null | string;
  referenced_column_name: null | string;
};

export default class Postgres implements SchemaInspector {
  knex: Knex;
  schema: string;
  explodedSchema: string[];

  constructor(knex: Knex) {
    this.knex = knex;
    const config = knex.client.config;
    if (!config.searchPath) {
      this.schema = 'public';
      this.explodedSchema = [this.schema];
    } else if (typeof config.searchPath === 'string') {
      this.schema = config.searchPath;
      this.explodedSchema = [config.searchPath];
    } else {
      this.schema = config.searchPath[0];
      this.explodedSchema = config.searchPath;
    }
  }

  // Postgres specific
  // ===============================================================================================

  /**
   * Set the schema to be used in other methods
   */
  withSchema(schema: string) {
    this.schema = schema;
    this.explodedSchema = [this.schema];
    return this;
  }

  /**
   * Converts Postgres default value to JS
   * Eg `'example'::character varying` => `example`
   */
  parseDefaultValue(type: string) {
    if (!type) return null;
    if (type.startsWith('nextval(')) return type;

    const parts = type.split('::');

    let value = parts[0];

    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    if (parts[1] && parts[1].includes('json')) return JSON.parse(value);
    if (parts[1] && (parts[1].includes('char') || parts[1].includes('text')))
      return String(value);

    if (Number.isNaN(Number(value))) return value;

    return Number(value);
  }

  // Tables
  // ===============================================================================================

  /**
   * List all existing tables in the current schema/database
   */
  async tables() {
    const records = await this.knex
      .select<{ tablename: string }[]>('tablename')
      .from('pg_catalog.pg_tables')
      .whereIn('schemaname', this.explodedSchema);
    return records.map(({ tablename }) => tablename);
  }

  /**
   * Get the table info for a given table. If table parameter is undefined, it will return all tables
   * in the current schema/database
   */
  tableInfo(): Promise<Table[]>;
  tableInfo(table: string): Promise<Table>;
  async tableInfo(table?: string) {
    const query = this.knex
      .select(
        'table_name',
        'table_schema',
        this.knex
          .select(this.knex.raw('obj_description(oid)'))
          .from('pg_class')
          .where({ relkind: 'r' })
          .andWhere({ relname: 'table_name' })
          .as('table_comment')
      )
      .from('information_schema.tables')
      .whereIn('table_schema', this.explodedSchema)
      .andWhereRaw(`"table_catalog" = current_database()`)
      .andWhere({ table_type: 'BASE TABLE' })
      .orderBy('table_name', 'asc');

    if (table) {
      const rawTable: RawTable = await query
        .andWhere({ table_name: table })
        .limit(1)
        .first();

      return {
        name: rawTable.table_name,
        schema: rawTable.table_schema,
        comment: rawTable.table_comment,
      } as Table;
    }

    const records = await query;

    return records.map(
      (rawTable: RawTable): Table => {
        return {
          name: rawTable.table_name,
          schema: rawTable.table_schema,
          comment: rawTable.table_comment,
        };
      }
    );
  }

  /**
   * Check if a table exists in the current schema/database
   */
  async hasTable(table: string) {
    const subquery = this.knex
      .select()
      .from('information_schema.tables')
      .whereIn('table_schema', this.explodedSchema)
      .andWhere({ table_name: table });
    const record = await this.knex
      .select<{ exists: boolean }>(this.knex.raw('exists (?)', [subquery]))
      .first();
    return record?.exists || false;
  }

  // Columns
  // ===============================================================================================

  /**
   * Get all the available columns in the current schema/database. Can be filtered to a specific table
   */
  async columns(table?: string) {
    const query = this.knex
      .select<{ table_name: string; column_name: string }[]>(
        'table_name',
        'column_name'
      )
      .from('information_schema.columns')
      .whereIn('table_schema', this.explodedSchema);

    if (table) {
      query.andWhere({ table_name: table });
    }

    const records = await query;

    return records.map(({ table_name, column_name }) => ({
      table: table_name,
      column: column_name,
    }));
  }

  /**
   * Get the column info for all columns, columns in a given table, or a specific column.
   */
  columnInfo(): Promise<Column[]>;
  columnInfo(table: string): Promise<Column[]>;
  columnInfo(table: string, column: string): Promise<Column>;
  async columnInfo<T>(table?: string, column?: string) {
    const { knex } = this;

    const query = knex
      .select(
        'c.column_name',
        'c.table_name',
        'c.data_type',
        'c.column_default',
        'c.character_maximum_length',
        'c.is_nullable',
        'c.numeric_precision',
        'c.numeric_scale',
        'c.table_schema',

        knex
          .select(knex.raw(`'YES'`))
          .from('pg_index')
          .join('pg_attribute', function () {
            this.on('pg_attribute.attrelid', '=', 'pg_index.indrelid').andOn(
              knex.raw('pg_attribute.attnum = any(pg_index.indkey)')
            );
          })
          .whereRaw('pg_index.indrelid = quote_ident(c.table_name)::regclass')
          .andWhere(knex.raw('pg_attribute.attname = c.column_name'))
          .andWhere(knex.raw('pg_index.indisprimary'))
          .as('is_primary'),

        knex
          .select(knex.raw(`case when count(1) >0 then 'YES' else null end`))
          .from('pg_index')
          .join('pg_attribute', function () {
            this.on('pg_attribute.attrelid', '=', 'pg_index.indrelid').andOn(
              knex.raw('pg_attribute.attnum = any(pg_index.indkey)')
            );
          })
          .whereRaw('pg_index.indrelid = quote_ident(c.table_name)::regclass')
          .andWhere(knex.raw('pg_attribute.attname = c.column_name'))
          .andWhere(knex.raw('pg_index.indisunique'))
          .as('is_unique'),

        knex
          .select(
            knex.raw(
              'pg_catalog.col_description(pg_catalog.pg_class.oid, c.ordinal_position:: int)'
            )
          )
          .from('pg_catalog.pg_class')
          .whereRaw(
            `pg_catalog.pg_class.oid = (select quote_ident(c.table_name):: regclass:: oid)`
          )
          .andWhere({ 'pg_catalog.pg_class.relname': 'c.table_name' })
          .as('column_comment'),

        knex.raw(
          'pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) as serial'
        ),

        'ffk.referenced_table_schema',
        'ffk.referenced_table_name',
        'ffk.referenced_column_name'
      )
      .from(knex.raw('information_schema.columns c'))
      .joinRaw(
        `
        LEFT JOIN (
          SELECT
            k1.table_schema,
            k1.table_name,
            k1.column_name,
            k2.table_schema AS referenced_table_schema,
            k2.table_name AS referenced_table_name,
            k2.column_name AS referenced_column_name
          FROM
            information_schema.key_column_usage k1
            JOIN information_schema.referential_constraints fk using (
              constraint_schema, constraint_name
            )
            JOIN information_schema.key_column_usage k2 ON k2.constraint_schema = fk.unique_constraint_schema
            AND k2.constraint_name = fk.unique_constraint_name
            AND k2.ordinal_position = k1.position_in_unique_constraint
        ) ffk ON ffk.table_name = c.table_name
        AND ffk.column_name = c.column_name
      `
      )
      .whereIn('c.table_schema', this.explodedSchema)
      .orderBy(['c.table_name', 'c.ordinal_position']);

    if (table) {
      query.andWhere({ 'c.table_name': table });
    }

    if (column) {
      const rawColumn = await query
        .andWhere({ 'c.column_name': column })
        .first();

      return {
        name: rawColumn.column_name,
        table: rawColumn.table_name,
        data_type: rawColumn.data_type,
        default_value: rawColumn.column_default
          ? this.parseDefaultValue(rawColumn.column_default)
          : null,
        max_length: rawColumn.character_maximum_length,
        numeric_precision: rawColumn.numeric_precision,
        numeric_scale: rawColumn.numeric_scale,
        is_nullable: rawColumn.is_nullable === 'YES',
        is_unique: rawColumn.is_unique === 'YES',
        is_primary_key: rawColumn.is_primary === 'YES',
        has_auto_increment: rawColumn.serial !== null,
        foreign_key_column: rawColumn.referenced_column_name,
        foreign_key_table: rawColumn.referenced_table_name,
        comment: rawColumn.column_comment,
        schema: rawColumn.table_schema,
        foreign_key_schema: rawColumn.referenced_table_schema,
      } as T extends string ? Column : Column[];
    }

    const records: RawColumn[] = await query;

    return records.map(
      (rawColumn): Column => {
        return {
          name: rawColumn.column_name,
          table: rawColumn.table_name,
          data_type: rawColumn.data_type,
          default_value: rawColumn.column_default
            ? this.parseDefaultValue(rawColumn.column_default)
            : null,
          max_length: rawColumn.character_maximum_length,
          numeric_precision: rawColumn.numeric_precision,
          numeric_scale: rawColumn.numeric_scale,
          is_nullable: rawColumn.is_nullable === 'YES',
          is_unique: rawColumn.is_unique === 'YES',
          is_primary_key: rawColumn.is_primary === 'YES',
          has_auto_increment: rawColumn.serial !== null,
          foreign_key_column: rawColumn.referenced_column_name,
          foreign_key_table: rawColumn.referenced_table_name,

          comment: rawColumn.column_comment,
          schema: rawColumn.table_schema,
          foreign_key_schema: rawColumn.referenced_table_schema,
        };
      }
    ) as T extends string ? Column : Column[];
  }

  /**
   * Check if the given table contains the given column
   */
  async hasColumn(table: string, column: string) {
    const subquery = this.knex
      .select()
      .from('information_schema.columns')
      .whereIn('table_schema', this.explodedSchema)
      .andWhere({
        table_name: table,
        column_name: column,
      });
    const record = await this.knex
      .select<{ exists: boolean }>(this.knex.raw('exists (?)', [subquery]))
      .first();
    return record?.exists || false;
  }

  /**
   * Get the primary key column for the given table
   */
  async primary(table: string): Promise<string> {
    const result = await this.knex
      .select('information_schema.key_column_usage.column_name')
      .from('information_schema.key_column_usage')
      .leftJoin(
        'information_schema.table_constraints',
        'information_schema.table_constraints.constraint_name',
        'information_schema.key_column_usage.constraint_name'
      )
      .whereIn(
        'information_schema.table_constraints.table_schema',
        this.explodedSchema
      )
      .andWhere({
        'information_schema.table_constraints.constraint_type': 'PRIMARY KEY',
        'information_schema.table_constraints.table_name': table,
      })
      .first();

    return result ? result.column_name : null;
  }

  // Foreign Keys
  // ===============================================================================================

  async foreignKeys(table?: string) {
    const result = await this.knex.raw<{ rows: ForeignKey[] }>(`
      SELECT
        c.conrelid::regclass::text AS "table",
        (
          SELECT
            STRING_AGG(QUOTE_IDENT(a.attname), ','
            ORDER BY
              t.seq)
          FROM (
            SELECT
              ROW_NUMBER() OVER (ROWS UNBOUNDED PRECEDING) AS seq,
              attnum
            FROM
              UNNEST(c.conkey) AS t (attnum)) AS t
          INNER JOIN pg_attribute AS a ON a.attrelid = c.conrelid
            AND a.attnum = t.attnum) AS "column",
        tt.name AS foreign_key_table,
        (
          SELECT
            STRING_AGG(QUOTE_IDENT(a.attname), ','
            ORDER BY
              t.seq)
          FROM (
            SELECT
              ROW_NUMBER() OVER (ROWS UNBOUNDED PRECEDING) AS seq,
              attnum
            FROM
              UNNEST(c.confkey) AS t (attnum)) AS t
        INNER JOIN pg_attribute AS a ON a.attrelid = c.confrelid
          AND a.attnum = t.attnum) AS foreign_key_column,
        tt.schema AS foreign_key_schema,
        c.conname AS constraint_name,
        CASE confupdtype
        WHEN 'r' THEN
          'RESTRICT'
        WHEN 'c' THEN
          'CASCADE'
        WHEN 'n' THEN
          'SET NULL'
        WHEN 'd' THEN
          'SET DEFAULT'
        WHEN 'a' THEN
          'NO ACTION'
        ELSE
          NULL
        END AS on_update,
        CASE confdeltype
        WHEN 'r' THEN
          'RESTRICT'
        WHEN 'c' THEN
          'CASCADE'
        WHEN 'n' THEN
          'SET NULL'
        WHEN 'd' THEN
          'SET DEFAULT'
        WHEN 'a' THEN
          'NO ACTION'
        ELSE
          NULL
        END AS
        on_delete
      FROM
        pg_catalog.pg_constraint AS c
        INNER JOIN (
          SELECT
            pg_class.oid,
            QUOTE_IDENT(pg_namespace.nspname) AS SCHEMA,
            QUOTE_IDENT(pg_class.relname) AS name
          FROM
            pg_class
            INNER JOIN pg_namespace ON pg_class.relnamespace = pg_namespace.oid) AS tf ON tf.oid = c.conrelid
        INNER JOIN (
          SELECT
            pg_class.oid,
            QUOTE_IDENT(pg_namespace.nspname) AS SCHEMA,
            QUOTE_IDENT(pg_class.relname) AS name
          FROM
            pg_class
            INNER JOIN pg_namespace ON pg_class.relnamespace = pg_namespace.oid) AS tt ON tt.oid = c.confrelid
      WHERE
        c.contype = 'f';
    `);

    if (table) {
      return result.rows?.filter((row) => row.table === table);
    }

    return result.rows;
  }
}
