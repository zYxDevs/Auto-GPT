import AutoGPTServerAPI from "@/lib/autogpt-server-api";
import { useCallback, useEffect, useMemo, useState } from "react";

export type SubscriptionStatus = {
  tier: string;
  monthly_cost: number;
  tier_costs: Record<string, number>;
};

export function useSubscriptionTierSection() {
  const api = useMemo(() => new AutoGPTServerAPI(), []);

  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const fetchSubscription = useCallback(async () => {
    try {
      const sub = await api.getSubscription();
      setSubscription(sub);
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
      setIsPending(true);
      try {
        const successUrl = `${window.location.origin}${window.location.pathname}?subscription=success`;
        const cancelUrl = `${window.location.origin}${window.location.pathname}?subscription=cancelled`;
        const result = await api.setSubscriptionTier(
          tier,
          successUrl,
          cancelUrl,
        );
        if (result.url) {
          window.location.href = result.url;
          return null;
        }
        await fetchSubscription();
        return null;
      } catch (e: unknown) {
        const msg =
          e instanceof Error ? e.message : "Failed to change subscription tier";
        return msg;
      } finally {
        setIsPending(false);
      }
    },
    [api, fetchSubscription],
  );

  return {
    subscription,
    isLoading,
    error,
    isPending,
    changeTier,
    refetch: fetchSubscription,
  };
}
