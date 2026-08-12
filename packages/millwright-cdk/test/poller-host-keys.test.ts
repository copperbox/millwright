import { describe, expect, it } from 'vitest';
import {
  COMPILED_IN_HOST_KEYS,
  confirmRotation,
  parseHostKeyPins,
  resolveHostKeyPins,
} from '../src/runtime/poller/host-keys';

const CUSTOM = `ssh-ed25519 ${Buffer.from('custom-pin').toString('base64')}`;
const ROTATED = `ssh-ed25519 ${Buffer.from('rotated-pin').toString('base64')}`;

describe('parseHostKeyPins', () => {
  it('accepts bare /meta lines, known_hosts lines, comments and blanks', () => {
    const parsed = parseHostKeyPins(
      ['# comment', '', `github.com ${CUSTOM}`, COMPILED_IN_HOST_KEYS[0]].join('\n'),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0].toString()).toBe('custom-pin');
  });
});

describe('resolveHostKeyPins', () => {
  it('falls back to the compiled-in GitHub keys before setup seeds the parameter', () => {
    expect(resolveHostKeyPins(undefined, undefined)).toHaveLength(COMPILED_IN_HOST_KEYS.length);
    expect(resolveHostKeyPins('  ', undefined)).toHaveLength(COMPILED_IN_HOST_KEYS.length);
  });

  it('prefers the SSM parameter and unions reconciled pins without duplicates', () => {
    const pins = resolveHostKeyPins(CUSTOM, [CUSTOM, ROTATED].join('\n'));
    expect(pins).toHaveLength(2);
    expect(pins[0].toString()).toBe('custom-pin');
    expect(pins[1].toString()).toBe('rotated-pin');
  });
});

describe('confirmRotation', () => {
  it('confirms only keys /meta vouches for', async () => {
    const meta = { ssh_keys: [ROTATED] };
    const confirmed = await confirmRotation(Buffer.from('rotated-pin'), async () => meta);
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.currentKeys).toEqual([ROTATED]);

    const denied = await confirmRotation(Buffer.from('evil-pin'), async () => meta);
    expect(denied.confirmed).toBe(false);
  });

  it('treats a missing ssh_keys field as unconfirmed', async () => {
    const result = await confirmRotation(Buffer.from('rotated-pin'), async () => ({}));
    expect(result.confirmed).toBe(false);
  });
});
