import { describe, expect, it } from 'bun:test';
import { MetricsService } from '../../src/common/metrics/metrics.service';

describe('HTTP Layer & Contracts Validation', () => {
    it('deve registrar métricas e exportar formato legível pelo Prometheus', async () => {
        const metrics = new MetricsService();

        metrics.transactionsTotal.inc({ status: 'PROCESSED', kind: 'BET', provider: 'test-p' }, 1);
        metrics.duplicateTransactionsTotal.inc({ provider: 'test-p' }, 1);

        const exported = await metrics.getMetricsFormatted();

        expect(exported).toContain('wager_transactions_total');
        expect(exported).toContain('idempotency_duplicates_total');
        expect(exported).toContain('status="PROCESSED"');
    });

    it('deve validar formatação de cursor Base64 para a paginação do ledger', () => {
        const nowIso = new Date().toISOString();
        const id = 'ledger-uuid-123';
        const raw = `${nowIso}#${id}`;

        const cursor = Buffer.from(raw).toString('base64');
        const decoded = Buffer.from(cursor, 'base64').toString('utf8');

        expect(decoded).toBe(raw);
    });
});