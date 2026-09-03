import { Module, OnModuleInit, OnModuleDestroy, Injectable, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';

import { WalletDbEntity } from './infrastructure/database/entities/wallet.db-entity';
import { WalletLedgerEntryDbEntity } from './infrastructure/database/entities/wallet-ledger-entry.db-entity';
import { WagerTransactionDbEntity } from './infrastructure/database/entities/wager-transaction.db-entity';
import { IdempotencyKeyDbEntity } from './infrastructure/database/entities/idempotency-key.db-entity';
import { OutboxEventDbEntity } from './infrastructure/database/entities/outbox-event.db-entity';
import { InboxMessageDbEntity } from './infrastructure/database/entities/inbox-message.db-entity';

import { WalletsController } from './interface/http/controllers/wallets.controller';
import { WageringController } from './interface/http/controllers/wagering.controller';
import { HealthAndMetricsController } from './interface/http/controllers/health.controller';

import { SubmitWagerTransactionService } from './application/services/submit-wager-transaction.service';
import { MetricsService } from './common/metrics/metrics.service';
import { NoopAuthGuard } from './common/guards/noop-auth.guard';
import { IdempotencyValidationInterceptor } from './common/interceptors/idempotency.interceptor';
import { OutboxPublisherWorker } from './infrastructure/messaging/outbox-publisher.worker';
import { SqsWagerConsumerService } from './infrastructure/messaging/sqs-wager-consumer.service';
import { PendingReferenceWorker } from './application/workers/pending-reference.worker';

const ENTITIES = [
    WalletDbEntity,
    WalletLedgerEntryDbEntity,
    WagerTransactionDbEntity,
    IdempotencyKeyDbEntity,
    OutboxEventDbEntity,
    InboxMessageDbEntity,
];

@Injectable()
class BackgroundPollersBootstrap implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(BackgroundPollersBootstrap.name);
    private outboxTimer?: Timer;
    private pendingTimer?: Timer;

    constructor(
        private readonly outbox: OutboxPublisherWorker,
        private readonly pending: PendingReferenceWorker,
    ) { }

    public onModuleInit(): void {
        this.logger.log('Iniciando workers em background (Outbox & Pending References)...');

        // Despacho de outbox a cada 500ms
        this.outboxTimer = setInterval(async () => {
            try {
                await this.outbox.publishPendingBatch();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.error(`Erro no worker de outbox: ${msg}`);
            }
        }, 500);

        // Resolução de referências fora de ordem a cada 2000ms
        this.pendingTimer = setInterval(async () => {
            try {
                await this.pending.processPendingBatch();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.error(`Erro no worker de referências pendentes: ${msg}`);
            }
        }, 2000);
    }

    public onModuleDestroy(): void {
        if (this.outboxTimer) clearInterval(this.outboxTimer);
        if (this.pendingTimer) clearInterval(this.pendingTimer);
        this.logger.log('Workers em background finalizados.');
    }
}

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MikroOrmModule.forRoot({
            driver: PostgreSqlDriver,
            entities: ENTITIES,
            host: process.env.DB_HOST ?? '127.0.0.1',
            port: Number(process.env.DB_PORT ?? 5432),
            user: process.env.DB_USER ?? 'postgres',
            password: process.env.DB_PASSWORD ?? 'postgrespassword',
            dbName: process.env.DB_NAME ?? 'wagering_db',
            autoLoadEntities: false,
        }),
    ],
    controllers: [WalletsController, WageringController, HealthAndMetricsController],
    providers: [
        {
            provide: SQSClient,
            useFactory: () =>
                new SQSClient({
                    region: process.env.AWS_REGION ?? 'us-east-1',
                    endpoint: process.env.AWS_ENDPOINT ?? 'http://127.0.0.1:4566',
                    credentials: {
                        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
                        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
                    },
                }),
        },
        SubmitWagerTransactionService,
        MetricsService,
        NoopAuthGuard,
        IdempotencyValidationInterceptor,
        OutboxPublisherWorker,
        SqsWagerConsumerService, // O consumer inicia seu próprio polling via OnModuleInit
        PendingReferenceWorker,
        BackgroundPollersBootstrap,
    ],
})
export class AppModule { }