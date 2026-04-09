"""
Tests for subscription tier billing: ensure_subscription_paid idempotency,
BetaUserCredit grant offset, and tier-change validation.
"""

from unittest.mock import AsyncMock, patch

import pytest
from prisma.enums import CreditTransactionType, SubscriptionTier
from prisma.models import CreditTransaction, User, UserBalance

from backend.data.credit import (
    BetaUserCredit,
    ensure_subscription_paid,
    set_subscription_tier,
)
from backend.data.user import get_user_by_id
from backend.util.test import SpinTestServer

SUB_TEST_USER_ID = "sub-test-user"
SUB_COST = 500  # $5.00 in cents


async def setup_sub_test_user(
    tier: SubscriptionTier = SubscriptionTier.FREE,
    balance: int = 1000,
    top_up_amount: int = 0,
    top_up_threshold: int = 0,
) -> None:
    await CreditTransaction.prisma().delete_many(where={"userId": SUB_TEST_USER_ID})
    await UserBalance.prisma().delete_many(where={"userId": SUB_TEST_USER_ID})
    await User.prisma().delete_many(where={"id": SUB_TEST_USER_ID})

    await User.prisma().create(
        data={
            "id": SUB_TEST_USER_ID,
            "email": f"{SUB_TEST_USER_ID}@example.com",
            "name": "Sub Test User",
            "subscriptionTier": tier,
            "topUpConfig": {
                "amount": top_up_amount,
                "threshold": top_up_threshold,
            },
        }
    )
    await UserBalance.prisma().create(
        data={"userId": SUB_TEST_USER_ID, "balance": balance}
    )
    get_user_by_id.cache_delete(SUB_TEST_USER_ID)  # type: ignore[attr-defined]


async def cleanup_sub_test_user() -> None:
    await CreditTransaction.prisma().delete_many(where={"userId": SUB_TEST_USER_ID})
    await UserBalance.prisma().delete_many(where={"userId": SUB_TEST_USER_ID})
    await User.prisma().delete_many(where={"id": SUB_TEST_USER_ID})
    get_user_by_id.cache_delete(SUB_TEST_USER_ID)  # type: ignore[attr-defined]


@pytest.mark.asyncio(loop_scope="session")
async def test_ensure_subscription_paid_idempotent(server: SpinTestServer):
    """Second call within the same month must not create a second transaction."""
    await setup_sub_test_user(tier=SubscriptionTier.PRO, balance=2000)

    with patch(
        "backend.data.credit.get_feature_flag_value",
        new=AsyncMock(return_value=SUB_COST),
    ):
        await ensure_subscription_paid(SUB_TEST_USER_ID)
        await ensure_subscription_paid(SUB_TEST_USER_ID)

    txns = await CreditTransaction.prisma().find_many(
        where={"userId": SUB_TEST_USER_ID, "type": CreditTransactionType.SUBSCRIPTION}
    )
    assert len(txns) == 1, f"Expected 1 SUBSCRIPTION txn, got {len(txns)}"
    assert txns[0].amount == -SUB_COST

    await cleanup_sub_test_user()


@pytest.mark.asyncio(loop_scope="session")
async def test_ensure_subscription_paid_free_tier_skips(server: SpinTestServer):
    """FREE tier (cost=0) must not create any subscription transaction."""
    await setup_sub_test_user(tier=SubscriptionTier.FREE, balance=500)

    with patch(
        "backend.data.credit.get_feature_flag_value",
        new=AsyncMock(return_value=0),
    ):
        await ensure_subscription_paid(SUB_TEST_USER_ID)

    txns = await CreditTransaction.prisma().find_many(
        where={"userId": SUB_TEST_USER_ID, "type": CreditTransactionType.SUBSCRIPTION}
    )
    assert len(txns) == 0

    await cleanup_sub_test_user()


@pytest.mark.asyncio(loop_scope="session")
async def test_beta_user_credit_grant_offsets_subscription(server: SpinTestServer):
    """BetaUserCredit grant must equal refill_amount + subscription_cost so the
    monthly subscription deduction does not reduce the user's effective usage budget."""
    from datetime import datetime, timezone

    refill = 1000
    beta_credit = BetaUserCredit(refill)

    await setup_sub_test_user(tier=SubscriptionTier.PRO, balance=0)

    # Force the balance updatedAt to old date so monthly refill triggers
    from datetime import timedelta

    old_date = datetime.now(timezone.utc) - timedelta(days=35)
    await UserBalance.prisma().update(
        where={"userId": SUB_TEST_USER_ID},
        data={"updatedAt": old_date, "balance": 0},
    )
    get_user_by_id.cache_delete(SUB_TEST_USER_ID)  # type: ignore[attr-defined]

    with patch(
        "backend.data.credit.get_feature_flag_value",
        new=AsyncMock(return_value=SUB_COST),
    ):
        balance = await beta_credit.get_credits(SUB_TEST_USER_ID)

    # The grant should cover refill + sub cost; balance should be at least refill_amount
    assert balance >= refill, (
        f"After grant+subscription deduction, balance {balance} < refill {refill}. "
        "Beta grant must offset subscription cost."
    )

    await cleanup_sub_test_user()


@pytest.mark.asyncio(loop_scope="session")
async def test_set_subscription_tier_requires_auto_top_up(server: SpinTestServer):
    """Upgrading to PRO without sufficient auto top-up must raise ValueError."""
    await setup_sub_test_user(
        tier=SubscriptionTier.FREE,
        balance=2000,
        top_up_amount=100,  # $1 — less than SUB_COST $5
        top_up_threshold=50,
    )

    with patch(
        "backend.data.credit.get_feature_flag_value",
        new=AsyncMock(return_value=SUB_COST),
    ):
        with pytest.raises(ValueError, match=r"\$5\.00/mo"):
            await set_subscription_tier(SUB_TEST_USER_ID, SubscriptionTier.PRO)

    await cleanup_sub_test_user()


@pytest.mark.asyncio(loop_scope="session")
async def test_set_subscription_tier_upgrade_charges_immediately(
    server: SpinTestServer,
):
    """Successful upgrade to PRO must immediately create a SUBSCRIPTION transaction."""
    await setup_sub_test_user(
        tier=SubscriptionTier.FREE,
        balance=2000,
        top_up_amount=SUB_COST + 100,  # Sufficient
        top_up_threshold=50,
    )

    # Patch auto top-up Stripe call so the test does not need Stripe credentials.
    with patch(
        "backend.data.credit.get_feature_flag_value",
        new=AsyncMock(return_value=SUB_COST),
    ), patch(
        "backend.data.credit.UserCredit._top_up_credits",
        new=AsyncMock(),
    ):
        await set_subscription_tier(SUB_TEST_USER_ID, SubscriptionTier.PRO)

    txns = await CreditTransaction.prisma().find_many(
        where={"userId": SUB_TEST_USER_ID, "type": CreditTransactionType.SUBSCRIPTION}
    )
    assert len(txns) == 1, f"Expected 1 SUBSCRIPTION txn on upgrade, got {len(txns)}"

    await cleanup_sub_test_user()
