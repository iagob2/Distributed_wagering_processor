import { describe, expect, it } from 'bun:test';
import {
    CurrencyMismatchError,
    InvalidMoneyFormatError,
    NegativeMoneyError,
} from '../../src/domain/errors/domain.error';
import { Money } from '../../src/domain/value-objects/money.vo';

describe('Value Object: Money', () => {
    it('deve instanciar Money com formato válido de 2 casas decimais', () => {
        const money = Money.from({ amount: '25.00', currency: 'BRL' });
        expect(money.toString()).toBe('BRL 25.00');
        expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
        expect(money.toCents()).toBe(2500n);
    });

    it('deve converter centavos corretamente para Money', () => {
        const money = Money.fromCents(1050n, 'BRL');
        expect(money.toString()).toBe('BRL 10.50');
        expect(money.toCents()).toBe(1050n);
    });

    it('deve rejeitar valores com mais de 2 casas decimais', () => {
        expect(() => Money.from({ amount: '25.005', currency: 'BRL' })).toThrow(
            InvalidMoneyFormatError,
        );
    });

    it('deve rejeitar notação científica, valores negativos e strings inválidas', () => {
        expect(() => Money.from({ amount: '1e5', currency: 'BRL' })).toThrow(InvalidMoneyFormatError);
        expect(() => Money.from({ amount: '-10.00', currency: 'BRL' })).toThrow(InvalidMoneyFormatError);
        expect(() => Money.from({ amount: 'abc', currency: 'BRL' })).toThrow(InvalidMoneyFormatError);
    });

    it('deve somar valores monetários preservando a imutabilidade', () => {
        const m1 = Money.from({ amount: '10.50', currency: 'BRL' });
        const m2 = Money.from({ amount: '4.50', currency: 'BRL' });
        const result = m1.add(m2);

        expect(result.toString()).toBe('BRL 15.00');
        expect(m1.toString()).toBe('BRL 10.50'); // m1 não foi mutado
        expect(m2.toString()).toBe('BRL 4.50');  // m2 não foi mutado
    });

    it('deve subtrair valores monetários corretamente', () => {
        const m1 = Money.from({ amount: '50.00', currency: 'BRL' });
        const m2 = Money.from({ amount: '20.00', currency: 'BRL' });
        const result = m1.subtract(m2);

        expect(result.toString()).toBe('BRL 30.00');
    });

    it('deve lançar erro se a subtração resultar em valor negativo', () => {
        const m1 = Money.from({ amount: '10.00', currency: 'BRL' });
        const m2 = Money.from({ amount: '20.00', currency: 'BRL' });

        expect(() => m1.subtract(m2)).toThrow(NegativeMoneyError);
    });

    it('deve impedir operações entre moedas distintas', () => {
        const brl = Money.from({ amount: '10.00', currency: 'BRL' });
        const usd = Money.from({ amount: '10.00', currency: 'USD' });

        expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
        expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
        expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    });

    it('deve validar igualdade e comparação de grandezas', () => {
        const a = Money.from({ amount: '10.00', currency: 'BRL' });
        const b = Money.from({ amount: '10.00', currency: 'BRL' });
        const c = Money.from({ amount: '20.00', currency: 'BRL' });

        expect(a.equals(b)).toBe(true);
        expect(a.equals(c)).toBe(false);
        expect(a.isLessThan(c)).toBe(true);
    });
});