import { RegistryItem, registryKey } from '@copperbox/millwright-state';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { CronRegistryReader } from './cron-tick';

/**
 * The poller's ONLY state-table access: reading `REG#` registry rows so the
 * cron pass can evaluate `Trigger.cron` entries from the default-branch map
 * (spec §6.4). The IAM grant is scoped to exactly this partition prefix —
 * the poller never touches run history.
 */
export class DynamoRegistryReader implements CronRegistryReader {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getRegistryEntry(repo: string, ref: string): Promise<RegistryItem | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: registryKey(repo, ref) }),
    );
    return result.Item as RegistryItem | undefined;
  }
}
