import {
    Entity,
    PrimaryKey,
    Property,
    Unique,
    Index,
} from '@mikro-orm/core';

@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
export class WagerTransactionDbEntity {
    @PrimaryKey({ type: 'uuid' })
    id!: string;

    @Property({ type: 'varchar', length: 64 })
    providerId!: string;

    @Property({ type: 'varchar', length: 128 })
    externalTransactionId!: string;

    @Property({ type: 'varchar', length: 255 })
    idempotencyKey!: string;

    @Property({ type: 'varchar', length: 64 })
    payloadHash!: string;

    @Index()
    @Property({ type: 'uuid' })
    walletId!: string;

    @Property({ type: 'varchar', length: 64 })
    playerId!: string;

    @Index()
    @Property({ type: 'varchar', length: 128 })
    roundId!: string;

    @Property({ type: 'varchar', length: 64 })
    gameId!: string;

    @Property({ type: 'varchar', length: 20 })
    kind!: string;

    @Property({ type: 'bigint' })
    amount!: string;

    @Property({ type: 'varchar', length: 3 })
    currency!: string;

    @Property({ type: 'varchar', length: 128, nullable: true })
    referenceExternalTransactionId?: string;

    @Property({ type: 'uuid', nullable: true })
    referenceTransactionId?: string;

    @Index()
    @Property({ type: 'varchar', length: 25 })
    status!: string;

    @Property({ type: 'varchar', length: 50, nullable: true })
    failureCode?: string;

    @Property({ type: 'timestamptz' })
    createdAt: Date = new Date();

    @Property({ type: 'timestamptz', nullable: true })
    processedAt?: Date;
}