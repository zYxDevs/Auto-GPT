import AutoGPTServerAPI from "@/lib/autogpt-server-api";
import { useCallback, useEffect, useMemo, useState } from "react";

export type SubscriptionStatus = {
  tier: string;
  monthly_cost: number;
  tier_costs: Record<string, number>;
};

export type AutoTopUpConfig = {
  amount: number;
  threshold: number;
};

export function useSubscriptionTierSection() {
  const api = useMemo(() => new AutoGPTServerAPI(), []);

  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(
    null,
  );
  const [autoTopUp, setAutoTopUp] = useState<AutoTopUpConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const fetchSubscription = useCallback(async () => {
    try {
      const [sub, topUp] = await Promise.all([
        api.getSubscription(),
        api.getAutoTopUpConfig(),
      ]);
      setSubscription(sub);
      setAutoTopUp(topUp);
    } catch (e) {
      setError("Failed to load subscription info");
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchSubscription();
  }, [fetchSubscription]);

  const changeTier = useCallback(
    async (tier: string): Promise<string | null> => {
      const targetCost = subscription?.tier_costs[tier] ?? 0;

      if (targetCost > 0 && (!autoTopUp || autoTopUp.amount < targetCost)) {
        return `Auto top-up amount must be at least $${(targetCost / 100).toFixed(2)} to subscribe to this tier. Configure it below first.`;
      }

      setIsPending(true);
      try {
        const updated = await api.setSubscriptionTier(tier);
        setSubscription(updated);
        return null;
      } catch (e: unknown) {
        const msg =
          e instanceof Error ? e.message : "Failed to change subscription tier";
        return msg;
      } finally {
        setIsPending(false);
      }
    },
    [api, subscription, autoTopUp],
  );

  return {
    subscription,
    autoTopUp,
    isLoading,
    error,
    isPending,
    changeTier,
    refetch: fetchSubscription,
  };
}
