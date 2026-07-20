import { describe, it, expect } from 'vitest';
import { describeError } from './describeError.js';

describe('describeError', () => {
  it('uses the stack (falling back to message) for a real Error', () => {
    const err = new Error('boom');
    expect(describeError(err)).toBe(err.stack);
    const noStack = new Error('boom');
    delete (noStack as { stack?: string }).stack;
    expect(describeError(noStack)).toBe('boom');
  });

  it('renders a DOMException with its name + message, not [object DOMException]', () => {
    // Node's DOMException happens to extend Error (with a .stack); the browser's
    // real DOMException (what this code actually runs against, in the Chromium
    // renderer) does not — that case is covered by the duck-typed test below.
    const err = new DOMException('Permission denied', 'NotAllowedError');
    expect(describeError(err)).toContain('NotAllowedError: Permission denied');
  });

  it('renders a browser-style DOMException (name/message, not instanceof Error) the same way', () => {
    expect(describeError({ name: 'RealtimeError', message: 'ICE failed' })).toBe(
      'RealtimeError: ICE failed',
    );
  });

  it('falls back to JSON for an arbitrary object', () => {
    expect(describeError({ code: 409, detail: 'live session exists' })).toBe(
      '{"code":409,"detail":"live session exists"}',
    );
  });

  it('falls back to String() for primitives and unstringifiable values', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError(42)).toBe('42');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeError(circular)).toBe(String(circular));
  });
});
