import { Decimal } from 'decimal.js';
import {
    CurrencyMismatchError,
    InvalidMoneyFormatError,
    NegativeMoneyError,
} from '../errors/domain.error';

// Configuração padrão para Decimal: precisão contábil e arredondamento padrão
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_EVEN });

export interface MoneyProps {
    amount: string; // Exemplo: "25.00"
    currency: string; // ISO-4217, exemplo: "BRL"
}

export class Money {
    private constructor(
        private readonly value: Decimal,
        public readonly currency: string,
    ) { }

    public static from(props: MoneyProps): Money {
        if (!props.amount || typeof props.amount !== 'string') {
            throw new InvalidMoneyFormatError('O montante deve ser uma string decimal não vazia.');
        }

        if (!props.currency || typeof props.currency !== 'string' || props.currency.trim().length !== 3) {
            throw new InvalidMoneyFormatError('A moeda deve ser um código ISO-4217 de 3 letras (ex: BRL).');
        }

        // Aceita apenas inteiros ou decimais com exatamente 1 ou 2 casas decimais (ex: "10", "10.5", "10.50")
        // Rejeita notação científica (1e5), vírgulas e múltiplos pontos
        const decimalPattern = /^\d+(\.\d{1,2})?$/;
        if (!decimalPattern.test(props.amount)) {
            throw new InvalidMoneyFormatError(
                `Formato monetário inválido: "${props.amount}". Esperado decimal positivo com até 2 casas (ex: "25.00").`,
            );
        }

        const decimalValue = new Decimal(props.amount);

        if (decimalValue.isNaN() || !decimalValue.isFinite()) {
            throw new InvalidMoneyFormatError('Valor monetário inválido (NaN ou Infinity).');
        }

        if (decimalValue.isNegative()) {
            throw new NegativeMoneyError();
        }

        return new Money(decimalValue, props.currency.toUpperCase());
    }

    public static zero(currency: string): Money {
        return new Money(new Decimal('0.00'), currency.toUpperCase());
    }

    /**
     * Reconstrução a partir de BIGINT do PostgreSQL.
     * Aceita apenas bigint|string — nunca `number` (IEEE-754) para dinheiro.
     */
    public static fromCents(cents: bigint | string, currency: string): Money {
        const decimal = new Decimal(cents.toString()).dividedBy(100);
        return new Money(decimal, currency.toUpperCase());
    }

    public add(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.value.plus(other.value), this.currency);
    }

    public subtract(other: Money): Money {
        this.assertSameCurrency(other);
        const result = this.value.minus(other.value);
        if (result.isNegative()) {
            throw new NegativeMoneyError('A subtração resultaria em valor monetário negativo.');
        }
        return new Money(result, this.currency);
    }

    public negate(): Money {
        return new Money(this.value.negated(), this.currency);
    }

    public isZero(): boolean {
        return this.value.isZero();
    }

    public isPositive(): boolean {
        return this.value.isPositive() && !this.value.isZero();
    }

    public isNegative(): boolean {
        return this.value.isNegative();
    }

    public isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.value.lessThan(other.value);
    }

    public equals(other: Money): boolean {
        return this.currency === other.currency && this.value.equals(other.value);
    }

    public toCents(): bigint {
        return BigInt(this.value.times(100).toFixed(0));
    }

    public toJSON(): MoneyProps {
        return {
            amount: this.value.toFixed(2),
            currency: this.currency,
        };
    }

    public toString(): string {
        return `${this.currency} ${this.value.toFixed(2)}`;
    }

    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new CurrencyMismatchError(this.currency, other.currency);
        }
    }
}