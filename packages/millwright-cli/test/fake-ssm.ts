import {
  DeleteParametersCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { SsmClientLike } from '../src';

export interface StoredParameter {
  Value: string;
  Type: 'String' | 'SecureString';
  KeyId?: string;
}

/** In-memory SSM parameter store covering the commands the CLI issues. */
export class FakeSsm implements SsmClientLike {
  readonly parameters = new Map<string, StoredParameter>();
  readonly puts: Array<{ Name: string; Type: string; KeyId?: string }> = [];

  set(name: string, value: string, type: 'String' | 'SecureString' = 'String'): void {
    this.parameters.set(name, { Value: value, Type: type });
  }

  setManifest(name: string, extraResources: Record<string, unknown> = {}): void {
    this.set(
      `/millwright/${name}/manifest`,
      JSON.stringify({
        deploymentName: name,
        version: '0.1.0',
        schemaVersion: 1,
        resources: {
          configKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-cmk',
          ...extraResources,
        },
      }),
    );
  }

  async send(command: unknown): Promise<any> {
    if (command instanceof GetParameterCommand) {
      const found = this.parameters.get(command.input.Name!);
      if (!found) {
        throw new ParameterNotFound({ message: 'not found', $metadata: {} });
      }
      return { Parameter: { Name: command.input.Name, Value: found.Value } };
    }
    if (command instanceof PutParameterCommand) {
      const { Name, Value, Type, KeyId } = command.input;
      this.parameters.set(Name!, { Value: Value!, Type: Type as StoredParameter['Type'], KeyId });
      this.puts.push({ Name: Name!, Type: Type!, KeyId });
      return {};
    }
    if (command instanceof DeleteParametersCommand) {
      const deleted: string[] = [];
      for (const name of command.input.Names ?? []) {
        if (this.parameters.delete(name)) {
          deleted.push(name);
        }
      }
      return { DeletedParameters: deleted };
    }
    if (command instanceof GetParametersByPathCommand) {
      const prefix = command.input.Path!.endsWith('/')
        ? command.input.Path!
        : `${command.input.Path!}/`;
      const matches = [...this.parameters.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, stored]) => ({ Name: name, Value: stored.Value }));
      return { Parameters: matches };
    }
    throw new Error(`FakeSsm: unexpected command ${command?.constructor?.name}`);
  }
}
