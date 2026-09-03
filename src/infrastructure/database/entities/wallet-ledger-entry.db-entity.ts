import {
    Entity,
    PrimaryKey,
    Property,
    Index,
} from '@mikro-orm/core';

@Entity({ tableName: 'ledger_entries' })
export class WalletLedgerEntryDbEntity {
    @PrimaryKey({ type: 'uuid' })
    id!: string;

    @Index()
    @Property({ type: 'uuid' })
    walletId!: string;

    @Index()
    @Property({ type: 'uuid' })
    transactionId!: string;

    @Property({ type: 'varchar', length: 6 })
    direction!: string; // 'DEBIT' | 'CREDIT'

    @Property({ type: 'bigint' })
    amount!: string;

    @Property({ type: 'bigint' })
    balanceBefore!: string;

    @Property({ type: 'bigint' })
    balanceAfter!: string;

    @Index()
    @Property({ type: 'timestamptz' })
    createdAt: Date = new Date();
}