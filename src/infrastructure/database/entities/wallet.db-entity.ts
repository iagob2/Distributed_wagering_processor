import {
    Entity,
    PrimaryKey,
    Property,
    Unique,
    Check,
} from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
@Check({ expression: 'balance >= 0' })
export class WalletDbEntity {
    @PrimaryKey({ type: 'uuid' })
    id!: string;

    @Property({ type: 'varchar', length: 64 })
    playerId!: string;

    @Property({ type: 'varchar', length: 3 })
    currency!: string;

    @Property({ type: 'bigint' })
    balance!: string; // BIGINT do postgres mapeado de forma segura como string/bigint

    @Property({ type: 'integer', default: 1 })
    version: number = 1;

    @Property({ type: 'timestamptz' })
    createdAt: Date = new Date();

    @Property({ type: 'timestamptz', onUpdate: () => new Date() })
    updatedAt: Date = new Date();
}