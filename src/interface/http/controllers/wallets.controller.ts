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
import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/postgresql';
import { CreateWalletDto } from '../dto/wallet.dto';
import { WalletDbEntity } from '../../../infrastructure/database/entities/wallet.db-entity';
import { WalletLedgerEntryDbEntity } from '../../../infrastructure/database/entities/wallet-ledger-entry.db-entity';
import { WagerTransactionDbEntity } from '../../../infrastructure/database/entities/wager-transaction.db-entity';
import { Money } from '../../../domain/value-objects/money.vo';
import { Wallet } from '../../../domain/entities/wallet.entity';
import { LedgerDirection } from '../../../domain/entities/wallet-ledger-entry.entity';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/entities/wager-transaction.entity';
import { randomUUID } from 'crypto';

@Controller('wallets')
export class WalletsController {
    constructor(private readonly em: EntityManager) { }

    @Post()
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

            // 2. Abertura com saldo positivo gera transação OPENING e crédito no ledger na mesma transação
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

                txEm.persist([txDb, ledgerDb]);
            }

            txEm.persist(walletDb);

            return {
                id: wallet.id,
                playerId: wallet.playerId,
                balance: wallet.balance.toJSON(),
                version: wallet.version,
            };
        });
    }

    @Get(':walletId')
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
    public async getLedger(
        @Param('walletId') walletId: string,
        @Query('cursor') cursor?: string,
        @Query('limit') limit = 50,
    ) {
        const take = Math.min(Number(limit) || 50, 100);
        const knex = this.em.getKnex();

        let query = knex('ledger_entries')
            .where({ wallet_id: walletId })
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .limit(take + 1);

        // Decodifica cursor opaco (Base64 de createdAt + id)
        if (cursor) {
            try {
                const decoded = Buffer.from(cursor, 'base64').toString('utf8');
                const [createdAtIso, lastId] = decoded.split('#');
                query = query.whereRaw('(created_at, id) < (?, ?)', [new Date(createdAtIso), lastId]);
            } catch {
                // Ignora cursor malformado e reinicia do topo
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

        return {
            items: items.map((r: any) => ({
                id: r.id,
                transactionId: r.transaction_id,
                direction: r.direction,
                amount: Money.fromCents(r.amount, 'BRL').toJSON(),
                balanceBefore: Money.fromCents(r.balance_before, 'BRL').toJSON(),
                balanceAfter: Money.fromCents(r.balance_after, 'BRL').toJSON(),
                createdAt: r.created_at,
            })),
            nextCursor,
        };
    }

    @Post(':walletId/reconciliation')
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