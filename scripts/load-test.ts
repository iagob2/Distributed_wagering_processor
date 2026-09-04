type JsonObject = Record<string, unknown>;

type Sample = {
    durationMs: number;
    status: number;
    ok: boolean;
};

const baseUrl = process.env.LOAD_BASE_URL ?? 'http://localhost:3000';
const requestCount = Number(process.env.LOAD_REQUESTS ?? 100);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 20);
const amount = process.env.LOAD_AMOUNT ?? '1.00';

async function createWallet(): Promise<{ walletId: string; playerId: string }> {
    const playerId = `load-${crypto.randomUUID()}`;
    const response = await fetch(`${baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            playerId,
            initialBalance: { amount: String(requestCount + 100), currency: 'BRL' },
        }),
    });

    if (!response.ok) {
        throw new Error(`Falha ao criar wallet: HTTP ${response.status} ${await response.text()}`);
    }

    const body = await response.json() as { id?: string };
    if (!body.id) throw new Error('Resposta de criação não contém wallet id.');
    return { walletId: body.id, playerId };
}

async function submitBet(walletId: string, playerId: string, index: number): Promise<Sample> {
    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'idempotency-key': `load:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
            providerId: 'load-test',
            externalTransactionId: `load-${index}-${crypto.randomUUID()}`,
            playerId,
            walletId,
            roundId: `load-round-${index}`,
            gameId: 'load-test',
            kind: 'BET',
            money: { amount, currency: 'BRL' },
        }),
    });

    return {
        durationMs: performance.now() - startedAt,
        status: response.status,
        ok: response.ok,
    };
}

async function readMetrics(): Promise<JsonObject> {
    const response = await fetch(`${baseUrl}/metrics`);
    const text = await response.text();
    const values: JsonObject = {};

    for (const line of text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([a-zA-Z0-9_]+)(?:\{[^}]*\})?\s+([0-9.eE+-]+)$/);
        if (match) values[match[1]] = Number(match[2]);
    }

    return values;
}

function percentile(values: number[], percentage: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.ceil((percentage / 100) * sorted.length) - 1);
    return sorted[index];
}

async function main(): Promise<void> {
    const wallet = await createWallet();
    const samples: Sample[] = [];
    let nextIndex = 0;
    const startedAt = performance.now();

    // Workers concorrentes exercitam o mesmo caminho HTTP/SQL sem criar dependência externa.
    async function worker(): Promise<void> {
        while (true) {
            const index = nextIndex++;
            if (index >= requestCount) return;
            samples.push(await submitBet(wallet.walletId, wallet.playerId, index));
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, requestCount) }, worker));
    const elapsedMs = performance.now() - startedAt;
    const latencies = samples.map((sample) => sample.durationMs);
    const errors = samples.filter((sample) => !sample.ok).length;
    const metrics = await readMetrics();
    const report = {
        timestamp: new Date().toISOString(),
        baseUrl,
        requests: requestCount,
        concurrency: Math.min(concurrency, requestCount),
        elapsedMs: Number(elapsedMs.toFixed(2)),
        throughputRps: Number((requestCount / (elapsedMs / 1000)).toFixed(2)),
        errorRate: Number((errors / requestCount).toFixed(4)),
        latencyMs: {
            p50: Number(percentile(latencies, 50).toFixed(2)),
            p95: Number(percentile(latencies, 95).toFixed(2)),
            p99: Number(percentile(latencies, 99).toFixed(2)),
        },
        lockConflicts: metrics.db_lock_conflicts_total ?? 0,
        outboxLag: metrics.outbox_lag_gauge ?? 0,
        statuses: samples.reduce<Record<string, number>>((counts, sample) => {
            counts[sample.status] = (counts[sample.status] ?? 0) + 1;
            return counts;
        }, {}),
    };

    console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
