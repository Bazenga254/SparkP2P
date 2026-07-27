"""
What a merchant pays I&M Automation, per buy order it pays out.

    Gold   (pro_max,  active)  KES  7
    B2C    (advanced, active)  KES  5
    Silver (pro,      active)  KES  5
    Bronze (starter,  active)  KES  4
    SparkP2P account, NO active subscription:
        first 100 payouts      KES 10   <- an allowance, not a rate (see below)
        payout 101 onward      KES 12
    Not a SparkP2P client at all (bot-only)    KES 12

THE 10 IS AN ALLOWANCE, NOT A RATE. A registered-but-unsubscribed trader gets
100 payouts at 10 to try the bot; from the 101st they pay 12 — the same as
someone who never signed up — because by then they are one. The moment they
subscribe they move to their plan's rate (Bronze 4 / Silver 5 / Gold 7 / B2C 5) and the counter stops
mattering. So "10" is a state a trader passes THROUGH, and any code that caches
a trader's rate is wrong: it changes underneath you at payout 101.

The counter is LIFETIME payouts-billed-while-unsubscribed, and it does NOT reset
if a subscription later lapses — the 100 is a one-time introduction to the bot,
not a renewable discount. (Resetting it would let a trader subscribe for one
month, cancel, and buy another 100 cheap payouts forever.)

Two rules this file exists to hold, because both silently mis-bill real money:

1. NEVER ASK billing_active(). Its name sounds exactly like what we want, and it
   is the wrong question:

       if not settings.ENFORCEMENT_ENABLED:
           return True          # <- EVERYONE looks subscribed

   With the enforcement switch off (as it may be), billing_active() says yes for
   every trader alive, and every merchant would be charged 7/8/9 instead of 10 —
   under-charging silently and forever. It answers "may this trader automate?",
   not "have they paid?". We ask active_plan(), which checks a real ACTIVE,
   unexpired subscription and returns None otherwise.

   Same trap as binance_merchant_tier (Binance's OWN gold/silver/bronze badge,
   nothing to do with a SparkP2P plan) — do not price off that either.

2. THREE POPULATIONS, NOT TWO. "no subscription" and "not a SparkP2P client" are
   different people who converge on 12 from different directions. Keep them
   apart: the admin must see who is a lapsed trader worth selling a plan to, and
   who only ever wanted the bot.

WHAT IS NOT BILLED (decided, deliberate — both are our failure, not theirs):
  - a payout refused for zero balance  -> no charge
  - a payout that FAILED               -> no charge
Only money that actually left the bank is billed. See should_bill().
"""

from app.models.subscription import SubscriptionPlan

# Bot-only: registered here, never a SparkP2P client.
ACCOUNT_BOT_ONLY = "bot_only"
# Has a SparkP2P trader account (subscribed or not).
ACCOUNT_SPARKP2P = "sparkp2p"

RATE_INTRO = 10             # SparkP2P account, no plan, within the allowance
RATE_NO_SUBSCRIPTION = 12   # SparkP2P account, no plan, allowance spent
RATE_BOT_ONLY = 12          # never a SparkP2P client

# How many payouts an unsubscribed trader gets at RATE_INTRO, lifetime.
INTRO_ALLOWANCE = 100

# Only ACTIVE, unexpired plans appear here.
RATE_BY_PLAN = {
    SubscriptionPlan.ADVANCED: 5,   # B2C  (KES 15,000/mo)
    SubscriptionPlan.PRO_MAX:  7,   # Gold (KES 13,000/mo)
    SubscriptionPlan.PRO:      5,   # Silver (was 8)
    SubscriptionPlan.STARTER:  4,   # Bronze (was 9)
}

# A payout is billed only if the money actually moved.
OUTCOME_PAID = "PAID"
OUTCOME_FAILED = "FAILED"
OUTCOME_UNKNOWN = "UNKNOWN"
OUTCOME_REFUSED_NO_BALANCE = "REFUSED_NO_BALANCE"


def should_bill(outcome: str) -> bool:
    """Only a payout that actually moved money is charged.

    UNKNOWN is NOT billed. We may well have paid — but an UNKNOWN is our
    inability to tell, and we will not take a merchant's money on a maybe. It
    already alerts a human; the charge can be made by hand once someone knows.
    Being wrong here costs us cents and costs them trust.
    """
    return outcome == OUTCOME_PAID


def rate_for(account_type: str, plan=None, intro_used: int = 0) -> int:
    """The KES charged for one buy-order payout. Pure — takes the ALREADY
    resolved active plan and the ALREADY counted intro usage, so it can be
    tested without a database.

    plan        MUST come from active_plan() (a real, unexpired subscription).
                None means no active subscription, NOT "unknown".
    intro_used  payouts already billed to this trader while unsubscribed.
                Ignored when they have a plan.
    """
    if account_type == ACCOUNT_BOT_ONLY:
        return RATE_BOT_ONLY
    if plan is None:
        return RATE_INTRO if intro_used < INTRO_ALLOWANCE else RATE_NO_SUBSCRIPTION
    # An unrecognised plan must not silently fall to the cheapest rate: charge
    # the unsubscribed rate and let it be visible, rather than guess a discount.
    return RATE_BY_PLAN.get(plan, RATE_NO_SUBSCRIPTION)


def intro_remaining(plan=None, intro_used: int = 0) -> int:
    """Payouts left at RATE_INTRO. 0 once they subscribe (it no longer applies)."""
    if plan is not None:
        return 0
    return max(0, INTRO_ALLOWANCE - intro_used)


def label_for(account_type: str, plan=None, intro_used: int = 0) -> str:
    """How the rate is explained to a merchant / in the admin."""
    if account_type == ACCOUNT_BOT_ONLY:
        return "Not a SparkP2P client"
    if plan is None:
        left = intro_remaining(None, intro_used)
        if left:
            return f"No subscription — {left} intro payouts left"
        return "No subscription — intro used up"
    from app.services.plans import plan_label
    return plan_label(plan)


async def rate_for_trader(db, trader_id: int) -> dict:
    """Resolve a SparkP2P trader's rate from their REAL subscription state.

    Deliberately calls active_plan(), never billing_active() — see the note at
    the top of this file.
    """
    from app.services.plans import active_plan
    plan = await active_plan(db, trader_id)
    used = 0 if plan is not None else await intro_used_for_trader(db, trader_id)
    return {
        "rate": rate_for(ACCOUNT_SPARKP2P, plan, used),
        "plan": getattr(plan, "value", None),
        "label": label_for(ACCOUNT_SPARKP2P, plan, used),
        "account_type": ACCOUNT_SPARKP2P,
        "intro_used": used,
        "intro_remaining": intro_remaining(plan, used),
    }


async def intro_used_for_trader(db, trader_id: int) -> int:
    """Payouts already billed at RATE_INTRO, lifetime.

    Counts rows on the charge ledger rather than a column on the trader, so the
    number is always reconstructable from what we actually charged — a counter
    that can drift from the ledger is a counter that will.
    """
    from sqlalchemy import select, func
    from app.models.im_charge import ImCharge
    return (await db.execute(
        select(func.count()).select_from(ImCharge).where(
            ImCharge.trader_id == trader_id,
            ImCharge.rate == RATE_INTRO,
        )
    )).scalar_one()


def rate_for_bot_only() -> dict:
    return {
        "rate": RATE_BOT_ONLY,
        "plan": None,
        "label": label_for(ACCOUNT_BOT_ONLY),
        "account_type": ACCOUNT_BOT_ONLY,
        "intro_used": 0,
        "intro_remaining": 0,
    }
