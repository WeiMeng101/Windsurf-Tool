'use strict';

const Decimal = require('decimal.js');

const PricingMode = {
  FLAT_FEE: 'flat_fee',
  USAGE_PER_UNIT: 'usage_per_unit',
  TIERED: 'tiered',
};

const PriceItemCode = {
  USAGE: 'usage',
  COMPLETION: 'completion',
  CACHED_TOKEN: 'prompt_cached_token',
  WRITE_CACHED: 'write_cached_tokens',
};

function unitsInMillionTokens(units) {
  if (units <= 0) return new Decimal(0);
  return new Decimal(units).div(1_000_000);
}

function computeItemSubtotal(quantity, pricing) {
  const item = { quantity, subtotal: '0' };

  switch (pricing.mode) {
    case PricingMode.FLAT_FEE:
      if (pricing.flat_fee) {
        item.subtotal = new Decimal(pricing.flat_fee).toString();
        return { item, subtotal: new Decimal(pricing.flat_fee) };
      }
      return { item, subtotal: new Decimal(0) };

    case PricingMode.USAGE_PER_UNIT:
      if (pricing.usage_per_unit) {
        const sub = new Decimal(pricing.usage_per_unit).mul(unitsInMillionTokens(quantity));
        item.subtotal = sub.toString();
        return { item, subtotal: sub };
      }
      return { item, subtotal: new Decimal(0) };

    case PricingMode.TIERED:
      if (pricing.usage_tiered?.tiers) {
        let total = new Decimal(0);
        let prevUpTo = 0;
        item.tier_breakdown = [];

        for (const tier of pricing.usage_tiered.tiers) {
          let tierUnits;
          if (tier.up_to != null) {
            tierUnits = quantity <= tier.up_to
              ? Math.max(quantity - prevUpTo, 0)
              : Math.max(tier.up_to - prevUpTo, 0);
          } else {
            tierUnits = Math.max(quantity - prevUpTo, 0);
          }

          if (tierUnits > 0) {
            const sub = new Decimal(tier.price_per_unit).mul(unitsInMillionTokens(tierUnits));
            total = total.add(sub);
            item.tier_breakdown.push({
              up_to: tier.up_to,
              units: tierUnits,
              subtotal: sub.toString(),
            });
          }
          prevUpTo = tier.up_to || prevUpTo;
          if (tier.up_to != null && quantity <= tier.up_to) break;
        }

        item.subtotal = total.toString();
        return { item, subtotal: total };
      }
      return { item, subtotal: new Decimal(0) };

    default:
      return { item, subtotal: new Decimal(0) };
  }
}

function computeUsageCost(usage, price) {
  const items = [];
  let total = new Decimal(0);

  if (!price || !price.items) return { items, total: '0' };

  for (const priceItem of price.items) {
    let quantity = 0;

    switch (priceItem.item_code) {
      case PriceItemCode.USAGE: {
        quantity = usage.prompt_tokens || 0;
        if (usage.prompt_tokens_details) {
          quantity -= usage.prompt_tokens_details.cached_tokens || 0;
          quantity -= usage.prompt_tokens_details.write_cached_tokens || 0;
        }
        quantity = Math.max(0, quantity);
        break;
      }
      case PriceItemCode.COMPLETION:
        quantity = usage.completion_tokens || 0;
        break;
      case PriceItemCode.CACHED_TOKEN:
        quantity = usage.prompt_tokens_details?.cached_tokens || 0;
        break;
      case PriceItemCode.WRITE_CACHED:
        quantity = usage.prompt_tokens_details?.write_cached_tokens || 0;
        break;
      default:
        quantity = 0;
    }

    const { item, subtotal } = computeItemSubtotal(quantity, priceItem.pricing || {});
    item.item_code = priceItem.item_code;
    items.push(item);
    total = total.add(subtotal);
  }

  return { items, total: total.toString() };
}

module.exports = { computeUsageCost, computeItemSubtotal, PricingMode, PriceItemCode };
