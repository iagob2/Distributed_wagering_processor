import {
    Entity,
    PrimaryKey,
    Property,
    Unique,
} from '@mikro-orm/core';

@Entity({ tableName: 'idempotency_keys' })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
export class IdempotencyKeyDbEntity {
    @PrimaryKey({ type: 'varchar', length: 255 })
    key!: string;

    @Property({ type: 'varchar', length: 64 })
    providerId!: string;

    @Property({ type: 'varchar', length: 128 })
    externalTransactionId!: string;

    @Property({ type: 'varchar', length: 64 })
    payloadHash!: string;

    @Property({ type: 'integer' })
    responseStatus!: number;

    @Property({ type: 'jsonb' })
    responseBody!: Record<string, unknown>;

    @Property({ type: 'timestamptz' })
    createdAt: Date = new Date();
}