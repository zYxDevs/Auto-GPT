"""
Tests for Stripe-based subscription tier billing.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from prisma.enums import SubscriptionTier
from prisma.models import User

from backend.data.credit import (
    create_subscription_checkout,
    set_subscription_tier,
    sync_subscription_from_stripe,
)


@pytest.mark.asyncio
async def test_set_subscription_tier_updates_db():
    with (
        patch(
            "backend.data.credit.User.prisma",
            return_value=MagicMock(update=AsyncMock()),
        ) as mock_prisma,
        patch("backend.data.credit.get_user_by_id"),
    ):
        await set_subscription_tier("user-1", SubscriptionTier.PRO)
        mock_prisma.return_value.update.assert_awaited_once_with(
            where={"id": "user-1"},
            data={"subscriptionTier": SubscriptionTier.PRO},
        )


@pytest.mark.asyncio
async def test_set_subscription_tier_downgrade():
    with (
        patch(
            "backend.data.credit.User.prisma",
            return_value=MagicMock(update=AsyncMock()),
        ),
        patch("backend.data.credit.get_user_by_id"),
    ):
        # Downgrade to FREE should not raise
        await set_subscription_tier("user-1", SubscriptionTier.FREE)


@pytest.mark.asyncio
async def test_sync_subscription_from_stripe_active():
    mock_user = MagicMock(spec=User)
    mock_user.id = "user-1"
    stripe_sub = {
        "customer": "cus_123",
        "status": "active",
        "items": {"data": [{"price": {"id": "price_pro_monthly"}}]},
    }

    async def mock_price_id(tier: SubscriptionTier) -> str | None:
        if tier == SubscriptionTier.PRO:
            return "price_pro_monthly"
        if tier == SubscriptionTier.BUSINESS:
            return "price_biz_monthly"
        return None

    with (
        patch(
            "backend.data.credit.User.prisma",
            return_value=MagicMock(find_first=AsyncMock(return_value=mock_user)),
        ),
        patch(
            "backend.data.credit.get_subscription_price_id",
            side_effect=mock_price_id,
        ),
        patch(
            "backend.data.credit.set_subscription_tier", new_callable=AsyncMock
        ) as mock_set,
    ):
        await sync_subscription_from_stripe(stripe_sub)
        mock_set.assert_awaited_once_with("user-1", SubscriptionTier.PRO)


@pytest.mark.asyncio
async def test_sync_subscription_from_stripe_cancelled():
    mock_user = MagicMock(spec=User)
    mock_user.id = "user-1"
    stripe_sub = {
        "customer": "cus_123",
        "status": "canceled",
        "items": {"data": []},
    }
    with (
        patch(
            "backend.data.credit.User.prisma",
            return_value=MagicMock(find_first=AsyncMock(return_value=mock_user)),
        ),
        patch(
            "backend.data.credit.set_subscription_tier", new_callable=AsyncMock
        ) as mock_set,
    ):
        await sync_subscription_from_stripe(stripe_sub)
        mock_set.assert_awaited_once_with("user-1", SubscriptionTier.FREE)


@pytest.mark.asyncio
async def test_sync_subscription_from_stripe_unknown_customer():
    stripe_sub = {
        "customer": "cus_unknown",
        "status": "active",
        "items": {"data": []},
    }
    with patch(
        "backend.data.credit.User.prisma",
        return_value=MagicMock(find_first=AsyncMock(return_value=None)),
    ):
        # Should not raise even if user not found
        await sync_subscription_from_stripe(stripe_sub)


@pytest.mark.asyncio
async def test_create_subscription_checkout_returns_url():
    mock_session = MagicMock()
    mock_session.url = "https://checkout.stripe.com/pay/cs_test_abc123"
    with (
        patch(
            "backend.data.credit.get_subscription_price_id",
            new_callable=AsyncMock,
            return_value="price_pro_monthly",
        ),
        patch(
            "backend.data.credit.get_stripe_customer_id",
            new_callable=AsyncMock,
            return_value="cus_123",
        ),
        patch("stripe.checkout.Session.create", return_value=mock_session),
    ):
        url = await create_subscription_checkout(
            user_id="user-1",
            tier=SubscriptionTier.PRO,
            success_url="https://app.example.com/success",
            cancel_url="https://app.example.com/cancel",
        )
        assert url == "https://checkout.stripe.com/pay/cs_test_abc123"


@pytest.mark.asyncio
async def test_create_subscription_checkout_no_price_raises():
    with patch(
        "backend.data.credit.get_subscription_price_id",
        new_callable=AsyncMock,
        return_value=None,
    ):
        with pytest.raises(ValueError, match="not available"):
            await create_subscription_checkout(
                user_id="user-1",
                tier=SubscriptionTier.PRO,
                success_url="https://app.example.com/success",
                cancel_url="https://app.example.com/cancel",
            )
