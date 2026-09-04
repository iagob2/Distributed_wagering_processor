import {
    Controller,
    Post,
    Get,
    Param,
    Query,
    Body,
    HttpStatus,
    HttpCode,
    ConflictException,
    NotFoundException,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';
import { CreateWalletDto } from '../dto/wallet.dto';
import { WalletDbEntity } from '../../../infrastructure/database/entities/wallet.db-entity';
import { WalletLedgerEntryDbEntity } from '../../../infrastructure/database/entities/wallet-ledger-entry.db-entity';
import { WagerTransactionDbEntity } from '../../../infrastructure/database/entities/wager-transaction.db-entity';
import { OutboxEventDbEntity } from '../../../infrastructure/database/entities/outbox-event.db-entity';
import { Money } from '../../../domain/value-objects/money.vo';
import { Wallet } from '../../../domain/entities/wallet.entity';
import { LedgerDirection } from '../../../domain/entities/wallet-ledger-entry.entity';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/entities/wager-transaction.entity';
import { WagerTransaction } from '../../../domain/entities/wager-transaction.entity';
import { WagerTransactionProcessed } from '../../../domain/events/integration-event';
import { randomUUID } from 'crypto';

import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';

@ApiTags('Wallets')
@ApiBearerAuth('bearer-token')


@Controller('wallets')
export class WalletsController {
    constructor(private readonly em: EntityManager) { }

    @Post()
    @ApiOperation({
        summary: 'Criar nova carteira',
        description: 'Cria uma carteira única para o jogador com saldo inicial.',
    })
    @HttpCode(HttpStatus.CREATED)
    public async createWallet(@Body() dto: CreateWalletDto) {
        const forkEm = this.em.fork();

        return await forkEm.transactional(async (txEm) => {
            // 1. Barramento contra duplicatas com base no par (playerId, currency)
            const existing = await txEm.findOne(WalletDbEntity, {
                playerId: dto.playerId,
                currency: dto.initialBalance.currency,
            });

            if (existing) {
                throw new ConflictException('Já existe uma carteira cadastrada para este jogador nesta moeda.');
            }

            const initialMoney = Money.from(dto.initialBalance);
            const walletId = randomUUID();
            const wallet = Wallet.open({ id: walletId, playerId: dto.playerId, initialBalance: initialMoney });

            const walletDb = txEm.create(WalletDbEntity, {
                id: wallet.id,
                playerId: wallet.playerId,
                currency: wallet.currency,
                balance: wallet.balance.toCents().toString(),
                version: wallet.version,
                createdAt: wallet.createdAt,
                updatedAt: wallet.updatedAt,
            });

            // Ordem FK: wallet → wager_transactions → ledger_entries (mesma TX SQL).
            txEm.persist(walletDb);
            await txEm.flush();

            // Saldo inicial > 0 ⇒ OPENING interno + CREDIT no ledger (Seção 9).
            if (initialMoney.isPositive()) {
                const txId = randomUUID();
                const txDb = txEm.create(WagerTransactionDbEntity, {
                    id: txId,
                    providerId: 'INTERNAL',
                    externalTransactionId: `OPENING-${walletId}`,
                    idempotencyKey: `internal:opening:${walletId}`,
                    payloadHash: 'internal_opening',
                    walletId: wallet.id,
                    playerId: wallet.playerId,
                    roundId: `round-${walletId}`,
                    gameId: 'system',
                    kind: WagerTransactionKind.Opening,
                    amount: initialMoney.toCents().toString(),
                    currency: initialMoney.currency,
                    status: WagerTransactionStatus.Processed,
                    createdAt: new Date(),
                    processedAt: new Date(),
                });

                txEm.persist(txDb);
                await txEm.flush();

                const ledgerDb = txEm.create(WalletLedgerEntryDbEntity, {
                    id: randomUUID(),
                    walletId: wallet.id,
                    transactionId: txId,
                    direction: LedgerDirection.Credit,
                    amount: initialMoney.toCents().toString(),
                    balanceBefore: '0',
                    balanceAfter: initialMoney.toCents().toString(),
                    createdAt: new Date(),
                });

                txEm.persist(ledgerDb);

                // A abertura também é uma transação aplicada: seu evento entra na
                // Outbox antes do commit, sem publicar diretamente no SQS.
                const opening = WagerTransaction.rehydrate({
                    id: txId,
                    providerId: 'INTERNAL',
                    externalTransactionId: `OPENING-${walletId}`,
                    idempotencyKey: `internal:opening:${walletId}`,
                    payloadHash: 'internal_opening',
                    walletId: wallet.id,
                    playerId: wallet.playerId,
                    roundId: `round-${walletId}`,
                    gameId: 'system',
                    kind: WagerTransactionKind.Opening,
                    money: initialMoney,
                    createdAt: wallet.createdAt,
                    status: WagerTransactionStatus.Processed,
                    processedAt: wallet.createdAt,
                });
                const openingEvent = WagerTransactionProcessed.from(
                    opening,
                    wallet,
                    { correlationId: wallet.id, causationId: txId },
                ).toJSON();
                txEm.persist(
                    txEm.create(OutboxEventDbEntity, {
                        id: openingEvent.eventId,
                        aggregateId: openingEvent.aggregateId,
                        eventType: openingEvent.eventType,
                        payload: openingEvent as unknown as Record<string, unknown>,
                        occurredAt: wallet.createdAt,
                        attempts: 0,
                        nextAttemptAt: wallet.createdAt,
                        createdAt: wallet.createdAt,
                    }),
                );
            }

            return {
                id: wallet.id,
                playerId: wallet.playerId,
                balance: wallet.balance.toJSON(),
                version: wallet.version,
            };
        });
    }

    @Get(':walletId')
    @ApiOperation({
        summary: 'Consultar saldo da carteira',
        description: 'Retorna o saldo materializado atual da carteira informada.',
    })
    @ApiParam({
        name: 'walletId',
        description: 'UUID da carteira criada anteriormente',
        example: 'e9da796b-4bcb-4326-bc5d-8a4cb6601304',
        required: true,
    })
    public async getWallet(@Param('walletId') walletId: string) {
        const walletDb = await this.em.findOne(WalletDbEntity, { id: walletId });
        if (!walletDb) throw new NotFoundException(`Carteira ${walletId} não encontrada.`);

        return {
            id: walletDb.id,
            playerId: walletDb.playerId,
            balance: Money.fromCents(walletDb.balance, walletDb.currency).toJSON(),
            version: walletDb.version,
        };
    }

    @Get(':walletId/ledger')
    @ApiOperation({
        summary: 'Consultar extrato do Livro-Razão (Ledger)',
        description: 'Retorna o histórico imutável de créditos e débitos com suporte a paginação por cursor.',
    })
    @ApiParam({
        name: 'walletId',
        description: 'UUID da carteira auditada',
        example: 'e9da796b-4bcb-4326-bc5d-8a4cb6601304',
        required: true,
    })

    @ApiQuery({
        name: 'cursor',
        description: 'Token Base64 para paginação. DEIXE EM BRANCO para buscar a primeira página do extrato.',
        example: '',
        required: false, // <-- Torna opcional no Swagger
    })

    public async getLedger(
        @Param('walletId') walletId: string,
        @Query('cursor') cursor?: string,
        @Query('limit') limit = 50,
    ) {
        const wallet = await this.em.findOne(WalletDbEntity, { id: walletId });
        if (!wallet) throw new NotFoundException(`Carteira ${walletId} não encontrada.`);

        const take = Math.min(Number(limit) || 50, 100);
        const knex = this.em.getKnex();

        let query = knex('ledger_entries')
            .where({ wallet_id: walletId })
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .limit(take + 1);

        // Cursor opaco estável (Base64 de createdAt#id) — não depende de offset volátil.
        if (cursor) {
            try {
                const decoded = Buffer.from(cursor, 'base64').toString('utf8');
                const [createdAtIso, lastId] = decoded.split('#');
                query = query.whereRaw('(created_at, id) < (?, ?)', [new Date(createdAtIso), lastId]);
            } catch {
                // Cursor malformado: reinicia do topo
            }
        }

        const rows = await query;
        const hasNextPage = rows.length > take;
        const items = hasNextPage ? rows.slice(0, take) : rows;

        let nextCursor: string | null = null;
        if (hasNextPage && items.length > 0) {
            const last = items[items.length - 1];
            nextCursor = Buffer.from(`${new Date(last.created_at).toISOString()}#${last.id}`).toString('base64');
        }

        const currency = wallet.currency;
        return {
            items: items.map((r: Record<string, unknown>) => ({
                id: r.id,
                transactionId: r.transaction_id,
                direction: r.direction,
                amount: Money.fromCents(String(r.amount), currency).toJSON(),
                balanceBefore: Money.fromCents(String(r.balance_before), currency).toJSON(),
                balanceAfter: Money.fromCents(String(r.balance_after), currency).toJSON(),
                createdAt: r.created_at,
            })),
            nextCursor,
        };
    }

    @Post(':walletId/reconciliation')
    @ApiOperation({
        summary: 'Reconciliação matemática da carteira',
        description: 'Executa a prova real: Saldo Armazenado == Soma(Créditos) - Soma(Débitos).',
    })
    @ApiParam({
        name: 'walletId',
        description: 'UUID da carteira para conferência contábil',
        example: 'e9da796b-4bcb-4326-bc5d-8a4cb6601304',
        required: true,
    })
    @HttpCode(HttpStatus.OK)
    public async reconcile(@Param('walletId') walletId: string) {
        const wallet = await this.em.findOne(WalletDbEntity, { id: walletId });
        if (!wallet) throw new NotFoundException(`Carteira ${walletId} não encontrada.`);

        const entries = await this.em.find(
            WalletLedgerEntryDbEntity,
            { walletId },
            { orderBy: { createdAt: 'ASC', id: 'ASC' } },
        );

        let calculatedCents = 0n;
        for (const entry of entries) {
            if (entry.direction === LedgerDirection.Credit) {
                calculatedCents += BigInt(entry.amount);
            } else {
                calculatedCents -= BigInt(entry.amount);
            }
        }

        const storedCents = BigInt(wallet.balance);
        const diffCents = storedCents - calculatedCents;
        const diffAbsolute = diffCents < 0n ? -diffCents : diffCents;

        return {
            walletId,
            storedBalance: Money.fromCents(storedCents, wallet.currency).toJSON(),
            calculatedBalance: Money.fromCents(calculatedCents, wallet.currency).toJSON(),
            difference: Money.fromCents(diffAbsolute, wallet.currency).toJSON(),
            consistent: storedCents === calculatedCents,
            checkedEntries: entries.length,
        };
    }
}