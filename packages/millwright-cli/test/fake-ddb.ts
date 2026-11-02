import { GetCommand, QueryCommand, QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { DynamoDocClientLike } from '../src/state-reads';

type Item = Record<string, unknown> & { pk: string; sk: string };

/**
 * In-memory DynamoDB document client covering the reads the CLI issues:
 * GetCommand and pk-equality queries with an optional begins_with(sk, …),
 * an optional single-attribute equality FilterExpression, and paging via
 * Limit / ExclusiveStartKey / LastEvaluatedKey. `pageSize` caps items per
 * page the way DynamoDB's 1 MB page does, so tests can prove a caller keeps
 * following LastEvaluatedKey.
 */
export class FakeDdb implements DynamoDocClientLike {
  private readonly tables = new Map<string, Map<string, Item>>();
  /** Every QueryCommand input seen, oldest first. */
  readonly queries: QueryCommandInput[] = [];
  pageSize?: number;

  put(table: string, item: Item): void {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = new Map();
      this.tables.set(table, rows);
    }
    rows.set(`${item.pk}\u0000${item.sk}`, item);
  }

  async send(command: unknown): Promise<any> {
    if (command instanceof GetCommand) {
      const { TableName, Key } = command.input;
      const rows = this.tables.get(TableName!);
      const item = rows?.get(`${(Key as Item).pk}\u0000${(Key as Item).sk}`);
      return { Item: item };
    }
    if (command instanceof QueryCommand) {
      this.queries.push(command.input);
      const {
        TableName,
        KeyConditionExpression,
        ExpressionAttributeValues,
        ExpressionAttributeNames,
        FilterExpression,
        Limit,
        ExclusiveStartKey,
      } = command.input;
      const values = ExpressionAttributeValues as Record<string, unknown>;
      const pk = values[':pk'] as string;
      const skPrefix = KeyConditionExpression?.includes('begins_with')
        ? (values[':sk'] as string)
        : undefined;
      const rows = this.tables.get(TableName!) ?? new Map<string, Item>();
      const startSk = (ExclusiveStartKey as Item | undefined)?.sk;
      const ordered = [...rows.values()]
        .filter((item) => item.pk === pk && (skPrefix === undefined || item.sk.startsWith(skPrefix)))
        .filter((item) => startSk === undefined || item.sk > startSk)
        .sort((a, b) => {
          if (a.sk === b.sk) {
            return 0;
          }
          return a.sk < b.sk ? -1 : 1;
        });

      // Like DynamoDB, Limit and the page cap bound the items *read*; the
      // filter is applied afterwards to that page.
      const pageCap = Math.min(Limit ?? Infinity, this.pageSize ?? Infinity);
      const page = pageCap === Infinity ? ordered : ordered.slice(0, pageCap);
      const items = FilterExpression
        ? page.filter((item) => matchesFilter(item, FilterExpression, values, ExpressionAttributeNames))
        : page;
      const last = page[page.length - 1];
      const more = page.length < ordered.length && last !== undefined;
      return {
        Items: items,
        ...(more ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}),
      };
    }
    throw new Error(`FakeDdb: unexpected command ${(command as object)?.constructor?.name}`);
  }
}

/** Supports `<attr> = :value` where `<attr>` is a name or a `#placeholder`. */
function matchesFilter(
  item: Item,
  expression: string,
  values: Record<string, unknown>,
  names: Record<string, string> | undefined,
): boolean {
  const match = /^\s*(#?[\w]+)\s*=\s*(:[\w]+)\s*$/.exec(expression);
  if (!match) {
    throw new Error(`FakeDdb: unsupported FilterExpression "${expression}"`);
  }
  const [, attr, placeholder] = match;
  const name = attr.startsWith('#') ? names?.[attr] : attr;
  if (name === undefined) {
    throw new Error(`FakeDdb: FilterExpression names ${attr} but no ExpressionAttributeNames entry`);
  }
  if (!(placeholder in values)) {
    throw new Error(`FakeDdb: FilterExpression uses ${placeholder} but no value was supplied`);
  }
  return item[name] === values[placeholder];
}
