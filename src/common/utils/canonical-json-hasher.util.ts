import { createHash } from 'crypto';

export class CanonicalJsonHasher {
    /**
     * Ordena recursivamente as propriedades de um objeto e calcula o hash SHA-256.
     * Garante determinismo independente da ordem de envio das chaves no JSON.
     */
    public static hash(data: Record<string, unknown>): string {
        const canonicalString = this.stringifyCanonical(data);
        return createHash('sha256').update(canonicalString).digest('hex');
    }

    private static stringifyCanonical(val: unknown): string {
        if (val === null || typeof val !== 'object') {
            return JSON.stringify(val);
        }

        if (Array.isArray(val)) {
            return `[${val.map((item) => this.stringifyCanonical(item)).join(',')}]`;
        }

        const record = val as Record<string, unknown>;
        const sortedKeys = Object.keys(record).sort();
        const entries = sortedKeys.map((key) => {
            return `${JSON.stringify(key)}:${this.stringifyCanonical(record[key])}`;
        });

        return `{${entries.join(',')}}`;
    }
}