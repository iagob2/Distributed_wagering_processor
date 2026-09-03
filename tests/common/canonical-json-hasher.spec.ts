import { describe, expect, it } from 'bun:test';
import { CanonicalJsonHasher } from '../../src/common/utils/canonical-json-hasher.util';

describe('CanonicalJsonHasher', () => {
    it('deve produzir o mesmo hash para objetos com chaves em ordens diferentes', () => {
        const payloadA = {
            providerId: 'provider-a',
            amount: '50.00',
            roundId: 'round-1',
            details: { foo: 'bar', baz: 123 },
        };

        const payloadB = {
            roundId: 'round-1',
            details: { baz: 123, foo: 'bar' },
            amount: '50.00',
            providerId: 'provider-a',
        };

        const hashA = CanonicalJsonHasher.hash(payloadA);
        const hashB = CanonicalJsonHasher.hash(payloadB);

        expect(hashA).toBe(hashB);
    });

    it('deve produzir hashes diferentes se qualquer valor for alterado', () => {
        const payloadA = { amount: '50.00', currency: 'BRL' };
        const payloadB = { amount: '50.01', currency: 'BRL' };

        const hashA = CanonicalJsonHasher.hash(payloadA);
        const hashB = CanonicalJsonHasher.hash(payloadB);

        expect(hashA).not.toBe(hashB);
    });
});