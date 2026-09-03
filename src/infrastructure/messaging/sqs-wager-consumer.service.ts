import {
    Injectable,
    OnModuleInit,
    OnModuleDestroy,
    Logger,
} from '@nestjs/common';
import {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand,
    ChangeMessageVisibilityCommand,
    Message,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { SubmitWagerTransactionService } from '../../application/services/submit-wager-transaction.service';
import { InboxMessageDbEntity } from '../database/entities/inbox-message.db-entity';
import { CanonicalJsonHasher } from '../../common/utils/canonical-json-hasher.util';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction.entity';

export interface SqsMessageEnvelope {
    messageId: string;
    type: string;
    occurredAt: string;
    data: {
        providerId: string;
        externalTransactionId: string;
        idempotencyKey: string;
        playerId: string;
        walletId: string;
        roundId: string;
        gameId: string;
        kind: WagerTransactionKind;
        money: {
            amount: string;
            currency: string;
        };
        referenceExternalTransactionId?: string;
    };
}

@Injectable()
export class SqsWagerConsumerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SqsWagerConsumerService.name);
    private readonly consumerName = 'wager-engine-sqs-consumer';
    private readonly queueUrl =
        process.env.SQS_MAIN_QUEUE_URL ||
        'http://localhost:4566/000000000000/wager-transactions.fifo';

    private isRunning = false;
    private activeJobs = 0;

    constructor(
        private readonly sqsClient: SQSClient,
        private readonly em: EntityManager,
        private readonly submitService: SubmitWagerTransactionService,
    ) { }

    public onModuleInit(): void {
        this.isRunning = true;
        this.poll();
    }

    public async onModuleDestroy(): Promise<void> {
        this.isRunning = false;
        const deadline = Date.now() + 10000;
        while (this.activeJobs > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
    }

    private async poll(): Promise<void> {
        while (this.isRunning) {
            try {
                const response = await this.sqsClient.send(
                    new ReceiveMessageCommand({
                        QueueUrl: this.queueUrl,
                        MaxNumberOfMessages: 5,
                        WaitTimeSeconds: 10,
                        VisibilityTimeout: 30,
                    }),
                );

                if (response.Messages && response.Messages.length > 0) {
                    await Promise.all(response.Messages.map((msg) => this.handleMessage(msg)));
                }
            } catch (err: unknown) {
                if (this.isRunning) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.logger.error(`Erro no loop SQS: ${message}`);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
            }
        }
    }

    private async handleMessage(message: Message): Promise<void> {
        this.activeJobs++;
        try {
            if (!message.Body || !message.ReceiptHandle) return;

            let envelope: SqsMessageEnvelope;
            try {
                envelope = JSON.parse(message.Body);
            } catch {
                // Se for um JSON inválido ou evento sem o formato esperado, descarta (ACK)
                this.logger.warn(`Mensagem malformada ${message.MessageId}. Descartando.`);
                await this.sqsClient.send(
                    new DeleteMessageCommand({
                        QueueUrl: this.queueUrl,
                        ReceiptHandle: message.ReceiptHandle,
                    }),
                );
                return;
            }

            if (!envelope.data || !envelope.data.walletId) {
                // Mensagem de evento outbox publicada por engano na fila de entrada de apostas -> ACK
                this.logger.warn(`Mensagem sem dados de aposta ${message.MessageId}. Descartando.`);
                await this.sqsClient.send(
                    new DeleteMessageCommand({
                        QueueUrl: this.queueUrl,
                        ReceiptHandle: message.ReceiptHandle,
                    }),
                );
                return;
            }

            const payloadHash = CanonicalJsonHasher.hash(
                envelope.data as unknown as Record<string, unknown>,
            );

            const forkEm = this.em.fork();

            await forkEm.transactional(async (txEm) => {
                const existingInbox = await txEm.findOne(InboxMessageDbEntity, {
                    messageId: envelope.messageId,
                    consumerName: this.consumerName,
                });

                if (existingInbox) {
                    return;
                }

                await this.submitService.execute(envelope.data.idempotencyKey, envelope.data);

                const inboxDb = txEm.create(InboxMessageDbEntity, {
                    messageId: envelope.messageId,
                    consumerName: this.consumerName,
                    payloadHash,
                    receivedAt: new Date(),
                    processedAt: new Date(),
                });

                txEm.persist(inboxDb);
            });

            await this.sqsClient.send(
                new DeleteMessageCommand({
                    QueueUrl: this.queueUrl,
                    ReceiptHandle: message.ReceiptHandle,
                }),
            );
        } catch (err: unknown) {
            const error = err as { code?: string; status?: number; message?: string };
            this.logger.error(`Falha ao processar mensagem ${message.MessageId}: ${error.message}`);

            // Erros de negócio, carteira não encontrada (404) ou conflitos sofrem ACK para não travar a fila
            if (this.isTerminalBusinessError(error)) {
                await this.sqsClient.send(
                    new DeleteMessageCommand({
                        QueueUrl: this.queueUrl,
                        ReceiptHandle: message.ReceiptHandle!,
                    }),
                );
            } else {
                await this.sqsClient.send(
                    new ChangeMessageVisibilityCommand({
                        QueueUrl: this.queueUrl,
                        ReceiptHandle: message.ReceiptHandle!,
                        VisibilityTimeout: 10,
                    }),
                );
            }
        } finally {
            this.activeJobs--;
        }
    }

    private isTerminalBusinessError(error: { code?: string; status?: number }): boolean {
        const terminalCodes = [
            'INSUFFICIENT_FUNDS',
            'INSUFFICIENT_FUNDS_FOR_REVERSAL',
            'INVALID_REFERENCE_METADATA',
            'REFERENCE_ALREADY_REVERSED',
            'INVALID_REFUND_TARGET',
            'INVALID_ROLLBACK_TARGET',
            'CURRENCY_MISMATCH',
            'IDEMPOTENCY_PAYLOAD_MISMATCH',
        ];

        return (
            (error.code !== undefined && terminalCodes.includes(error.code)) ||
            error.status === 404 ||
            error.status === 409 ||
            error.status === 422
        );
    }
}