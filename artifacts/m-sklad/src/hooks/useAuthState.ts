import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, useGetMe } from "@workspace/api-client-react";

export const BRAND_NAME = "Luna Garden";

/** Session state from the local server: signed in = /api/auth/me answers 200. */
export function useAuthState() {
  const me = useGetMe({ query: { queryKey: ["/api/auth/me"], retry: false, staleTime: 30_000 } });
  const status = useQuery<{ needsSetup: boolean }>({
    queryKey: ["/api/auth/status"],
    queryFn: () => customFetch<{ needsSetup: boolean }>("/api/auth/status"),
    enabled: me.isError,
    retry: false,
    staleTime: 0,
  });
  const isLoading = me.isLoading || (me.isError && status.isLoading);
  return {
    isLoading,
    isSignedIn: !!me.data,
    needsSetup: !!status.data?.needsSetup,
    user: me.data,
  };
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return async () => {
    try {
      await customFetch("/api/auth/logout", { method: "POST" });
    } finally {
      queryClient.clear();
    }
  };
}
