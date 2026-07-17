"""
What a merchant pays I&M Automation, per buy order it pays out.

    Gold   (pro_max, active)   KES  7
    Silver (pro,     active)   KES  8
    Bronze (starter, active)   KES  9
    B2C    (advanced, active)  KES  7   <- see B2C note below
    SparkP2P account, NO active subscription   KES 10  (whatever their tier)
    Not a SparkP2P client at all (bot-only)    KES 12

Two rules this file exists to hold, because both are easy to get wrong and both
silently mis-bill real money:

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

2. THREE POPULATIONS, NOT TWO. "no subscription" (10) and "not a SparkP2P
   client" (12) are different people. A trader who registered and never paid is
   NOT the same as someone who only ever used this bot.

B2C NOTE: SubscriptionPlan.ADVANCED is the hidden B2C plan — KES 15,000/mo,
MORE than Gold's 13,000. It is a real, active, paid subscription that is neither
gold, silver nor bronze, so the four published rates do not cover it. Billing it
at the no-subscription rate would charge our most expensive customer as though
they had never paid, so it gets the best rate (7) until told otherwise.
"""

from app.models.subscription import SubscriptionPlan

# Bot-only: registered here, never a SparkP2P client.
ACCOUNT_BOT_ONLY = "bot_only"
# Has a SparkP2P trader account (subscribed or not).
ACCOUNT_SPARKP2P = "sparkp2p"

RATE_NO_SUBSCRIPTION = 10   # SparkP2P account, nothing paid — any tier
RATE_BOT_ONLY = 12          # never a SparkP2P client

# Only ACTIVE, unexpired plans appear here.
RATE_BY_PLAN = {
    SubscriptionPlan.PRO_MAX:  7,   # Gold
    SubscriptionPlan.PRO:      8,   # Silver
    SubscriptionPlan.STARTER:  9,   # Bronze
    SubscriptionPlan.ADVANCED: 7,   # B2C (KES 15k — pays more than Gold)
}


def rate_for(account_type: str, plan=None) -> int:
    """The KES charged for one buy-order payout. Pure — takes the ALREADY
    resolved active plan, so it can be tested without a database.

    `plan` MUST come from active_plan() (a real, unexpired subscription) — None
    means no active subscription, NOT "unknown".
    """
    if account_type == ACCOUNT_BOT_ONLY:
        return RATE_BOT_ONLY
    if plan is None:
        return RATE_NO_SUBSCRIPTION
    # An unrecognised plan must not silently fall to the cheapest rate: charge
    # the no-subscription rate and let it be visible, rather than guess.
    return RATE_BY_PLAN.get(plan, RATE_NO_SUBSCRIPTION)


def label_for(account_type: str, plan=None) -> str:
    """How the rate is explained to a merchant / in the admin."""
    if account_type == ACCOUNT_BOT_ONLY:
        return "Not a SparkP2P client"
    if plan is None:
        return "No active subscription"
    from app.services.plans import plan_label
    return plan_label(plan)


async def rate_for_trader(db, trader_id: int) -> dict:
    """Resolve a SparkP2P trader's rate from their REAL subscription state.

    Deliberately calls active_plan(), never billing_active() — see the note at
    the top of this file.
    """
    from app.services.plans import active_plan
    plan = await active_plan(db, trader_id)
    return {
        "rate": rate_for(ACCOUNT_SPARKP2P, plan),
        "plan": getattr(plan, "value", None),
        "label": label_for(ACCOUNT_SPARKP2P, plan),
        "account_type": ACCOUNT_SPARKP2P,
    }


def rate_for_bot_only() -> dict:
    return {
        "rate": RATE_BOT_ONLY,
        "plan": None,
        "label": label_for(ACCOUNT_BOT_ONLY),
        "account_type": ACCOUNT_BOT_ONLY,
    }
