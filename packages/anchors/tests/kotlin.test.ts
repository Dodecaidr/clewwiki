import { describe, expect, it } from 'vitest';

import { languageForPath, resolveAnchor } from '../src/index';
import { anchorFor, declarationsOf, find, indexFiles } from './helpers';

/**
 * The Kotlin table, on the same five outcomes the other languages promise, and
 * on the parts of Kotlin that have no counterpart in them: extensions, whose
 * receiver is part of the name; overloads; companions; and the several things
 * that are all spelled `class`.
 */

const FILE = 'app/src/main/kotlin/shop/Checkout.kt';

const ORIGINAL = `package shop

import kotlin.math.max

typealias Cents = Long

const val MAX_RETRIES = 3

/** Adds the prices up. */
fun total(items: List<Item>, discount: Int = 0): Cents {
    val sum = items.sumOf { it.price }
    return max(0, sum - discount)
}

fun List<Item>.cheapest(): Item? = minByOrNull { it.price }

val String.slug: String
    get() = lowercase().replace(' ', '-')

data class Item(val name: String, val price: Cents)

interface Gateway {
    val name: String
    fun charge(amount: Cents): Receipt
}

enum class Currency(val code: String) {
    EUR("EUR"), USD("USD");

    fun symbol(): String = if (this == EUR) "€" else "$"
}

object Registry {
    fun register(gateway: Gateway) {
        gateways[gateway.name] = gateway
    }
}

class Checkout(private val gateway: Gateway) {
    var attempts: Int = 0
        private set

    constructor(gateway: Gateway, attempts: Int) : this(gateway) {
        this.attempts = attempts
    }

    suspend fun pay(items: List<Item>): Receipt {
        attempts += 1
        val amount = total(items)
        return gateway.charge(amount)
    }

    fun pay(item: Item): Receipt = gateway.charge(item.price)

    companion object {
        const val VERSION = "1"

        fun create(gateway: Gateway): Checkout = Checkout(gateway)
    }
}
`;

const PAY = 'Checkout.pay(items)';

describe('kotlin declaration extraction', () => {
  it('reads .kt and .kts as Kotlin', () => {
    expect(languageForPath(FILE)).toBe('kotlin');
    expect(languageForPath('build.gradle.kts')).toBe('kotlin');
  });

  it('finds top-level declarations, containers and their members', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const names = declarations.map((entry) => `${entry.kind} ${entry.qualifiedName}`);

    expect(names).toEqual(
      expect.arrayContaining([
        'typealias Cents',
        'val MAX_RETRIES',
        'fun total(items, discount)',
        'class Item',
        'interface Gateway',
        'val Gateway.name',
        'fun Gateway.charge(amount)',
        'enum Currency',
        'fun Currency.symbol()',
        'object Registry',
        'fun Registry.register(gateway)',
        'class Checkout',
        'var Checkout.attempts',
        'constructor Checkout.constructor(gateway, attempts)',
      ]),
    );

    const pay = find(declarations, PAY);
    expect(pay.container).toBe('Checkout');
    expect(pay.endLine).toBeGreaterThan(pay.startLine);
  });

  it('keeps the receiver of an extension in its name', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const names = declarations.map((entry) => `${entry.kind} ${entry.qualifiedName}`);
    expect(names).toContain('fun List<Item>.cheapest()');
    expect(names).toContain('val String.slug');
  });

  it('tells overloads apart by their parameter names', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const overloads = declarations.filter((entry) => entry.qualifiedName.startsWith('Checkout.pay('));
    expect(overloads.map((entry) => entry.qualifiedName)).toEqual(['Checkout.pay(items)', 'Checkout.pay(item)']);
    expect(overloads[0]!.tokenHash).not.toBe(overloads[1]!.tokenHash);
  });

  it("reaches a companion's members as members of the class", async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const names = declarations.map((entry) => `${entry.kind} ${entry.qualifiedName}`);
    expect(names).toContain('val Checkout.VERSION');
    expect(names).toContain('fun Checkout.create(gateway)');
    expect(names.some((name) => name.includes('Companion'))).toBe(false);
  });

  it('skips what has no single name to anchor to', async () => {
    const declarations = await declarationsOf(
      'Pair.kt',
      'val (first, second) = pair\n\nclass Holder {\n    init {\n        check(true)\n    }\n}\n',
    );
    expect(declarations.map((entry) => entry.qualifiedName)).toEqual(['Holder']);
  });
});

describe('kotlin anchor resolution', () => {
  it('stays fresh through a formatting-only change', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, PAY), 'kotlin');

    const reformatted = ORIGINAL.replace(
      `    suspend fun pay(items: List<Item>): Receipt {
        attempts += 1
        val amount = total(items)
        return gateway.charge(amount)
    }`,
      `    suspend fun pay(
        items: List<Item>
    ): Receipt {
        // a new comment nobody should be told about
        attempts += 1

        /* and a block one */
        val amount = total(items)
        return gateway.charge(amount)
    }`,
    );
    expect(reformatted).not.toBe(ORIGINAL);

    const index = await indexFiles({ [FILE]: reformatted });
    expect(resolveAnchor(anchor, index)).toMatchObject({
      state: 'fresh',
      detail: { reason: 'identity_matched' },
    });
  });

  it('flags a body change as stale, and leaves the other overload alone', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const changed = anchorFor(FILE, find(declarations, PAY), 'kotlin');
    const untouched = anchorFor(FILE, find(declarations, 'Checkout.pay(item)'), 'kotlin');

    const edited = ORIGINAL.replace('attempts += 1', 'attempts += 2');
    const index = await indexFiles({ [FILE]: edited });

    const resolution = resolveAnchor(changed, index);
    expect(resolution.state).toBe('stale');
    expect(resolution.detail.reason).toBe('body_changed');
    expect(resolveAnchor(untouched, index).state).toBe('fresh');
  });

  it('reports a rename as moved-renamed', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, PAY), 'kotlin');

    const renamed = ORIGINAL.replace('suspend fun pay(items', 'suspend fun settle(items');
    const index = await indexFiles({ [FILE]: renamed });

    const resolution = resolveAnchor(anchor, index);
    expect(resolution.state).toBe('moved-renamed');
    expect(resolution.detail.reason).toBe('renamed');
    expect(resolution.detail.renamed_to).toBe('Checkout.settle(items)');
  });

  it('reports a move to another file as moved-renamed', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'total(items, discount)'), 'kotlin');

    const moved = 'app/src/main/kotlin/shop/Totals.kt';
    const index = await indexFiles({
      [FILE]: 'package shop\n\nclass Checkout\n',
      [moved]: ORIGINAL,
    });

    const resolution = resolveAnchor(anchor, index);
    expect(resolution.state).toBe('moved-renamed');
    expect(resolution.detail.reason).toBe('moved');
    expect(resolution.detail.moved_to).toBe(moved);
    expect(resolution.detail.body_changed).toBe(false);
  });

  it('reports a deletion as lost', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, PAY), 'kotlin');

    const index = await indexFiles({ [FILE]: 'package shop\n\nclass Checkout(private val gateway: Gateway)\n' });
    const resolution = resolveAnchor(anchor, index);
    expect(resolution.state).toBe('lost');
    expect(resolution.detail.reason).toBe('declaration_missing');
  });

  it('marks a container stale when one of its members changes', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'Checkout'), 'kotlin');

    const edited = ORIGINAL.replace('gateway.charge(item.price)', 'gateway.charge(item.price + 1)');
    const index = await indexFiles({ [FILE]: edited });
    expect(resolveAnchor(anchor, index).state).toBe('stale');
  });
});
