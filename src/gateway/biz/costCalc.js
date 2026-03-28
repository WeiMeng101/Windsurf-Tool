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

// ---------------------------------------------------------------------------
// Budget Tracker
// ---------------------------------------------------------------------------

class BudgetTracker {
  constructor() {
    this._dailyLimit = null;
    this._monthlyLimit = null;
    this._dailySpend = new Decimal(0);
    this._monthlySpend = new Decimal(0);
    this._currentDay = this._todayKey();
    this._currentMonth = this._monthKey();
  }

  /** Return "YYYY-MM-DD" for today. */
  _todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  /** Return "YYYY-MM" for the current month. */
  _monthKey() {
    return new Date().toISOString().slice(0, 7);
  }

  /** Reset accumulators if the day or month has rolled over. */
  _rolloverIfNeeded() {
    const today = this._todayKey();
    const month = this._monthKey();

    if (today !== this._currentDay) {
      this._dailySpend = new Decimal(0);
      this._currentDay = today;
    }
    if (month !== this._currentMonth) {
      this._monthlySpend = new Decimal(0);
      this._currentMonth = month;
    }
  }

  /**
   * Set budget thresholds.
   * Pass null to remove a limit.
   */
  setBudget(dailyLimit, monthlyLimit) {
    this._dailyLimit = dailyLimit != null ? new Decimal(dailyLimit) : null;
    this._monthlyLimit = monthlyLimit != null ? new Decimal(monthlyLimit) : null;
  }

  /**
   * Check whether a cost is within budget.
   * Also records the cost into the running totals.
   * Returns { allowed, warning, usage }.
   */
  checkBudget(cost) {
    this._rolloverIfNeeded();

    const amount = new Decimal(cost);
    const projectedDaily = this._dailySpend.add(amount);
    const projectedMonthly = this._monthlySpend.add(amount);

    let allowed = true;
    let warning = null;

    // Hard block if either limit would be exceeded
    if (this._dailyLimit && projectedDaily.gt(this._dailyLimit)) {
      allowed = false;
      warning = 'Daily budget limit exceeded';
    }
    if (this._monthlyLimit && projectedMonthly.gt(this._monthlyLimit)) {
      allowed = false;
      warning = warning
        ? 'Daily and monthly budget limits exceeded'
        : 'Monthly budget limit exceeded';
    }

    // Threshold warnings (only if still allowed)
    if (allowed) {
      const warnings = [];
      if (this._dailyLimit) {
        const pctDaily = projectedDaily.div(this._dailyLimit).mul(100).toNumber();
        if (pctDaily >= 90) warnings.push('Daily spend at 90% of limit');
        else if (pctDaily >= 80) warnings.push('Daily spend at 80% of limit');
      }
      if (this._monthlyLimit) {
        const pctMonthly = projectedMonthly.div(this._monthlyLimit).mul(100).toNumber();
        if (pctMonthly >= 90) warnings.push('Monthly spend at 90% of limit');
        else if (pctMonthly >= 80) warnings.push('Monthly spend at 80% of limit');
      }
      if (warnings.length) warning = warnings.join('; ');
    }

    // Record spend regardless (caller decides whether to honour the block)
    if (allowed) {
      this._dailySpend = projectedDaily;
      this._monthlySpend = projectedMonthly;
    }

    return {
      allowed,
      warning,
      usage: {
        daily: this._dailySpend.toString(),
        monthly: this._monthlySpend.toString(),
      },
    };
  }

  /**
   * Get current spend vs limits with percentage used.
   */
  getBudgetStatus() {
    this._rolloverIfNeeded();

    const dailyPct = this._dailyLimit
      ? this._dailySpend.div(this._dailyLimit).mul(100).toNumber()
      : null;
    const monthlyPct = this._monthlyLimit
      ? this._monthlySpend.div(this._monthlyLimit).mul(100).toNumber()
      : null;

    return {
      daily: {
        spent: this._dailySpend.toString(),
        limit: this._dailyLimit ? this._dailyLimit.toString() : null,
        percentage: dailyPct,
      },
      monthly: {
        spent: this._monthlySpend.toString(),
        limit: this._monthlyLimit ? this._monthlyLimit.toString() : null,
        percentage: monthlyPct,
      },
    };
  }
}

const budgetTracker = new BudgetTracker();

module.exports = {
  computeUsageCost,
  computeItemSubtotal,
  PricingMode,
  PriceItemCode,
  BudgetTracker,
  budgetTracker,
};
