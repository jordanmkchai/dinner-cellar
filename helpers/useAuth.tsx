import React, { createContext, useContext, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { getSession } from "../endpoints/auth/session_GET.schema";
import { postLogout } from "../endpoints/auth/logout_POST.schema";
import { User } from "./User";
import { resetPrivateCart } from "./cartStore";

export const AUTH_QUERY_KEY = ["auth", "session"] as const;

type AuthState =
  | { type: "loading" }
  | { type: "authenticated"; user: User }
  | { type: "unauthenticated"; errorMessage?: string };

type AuthContextType = {
  authState: AuthState;
  onLogin: (user: User) => void;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function clearCellarPrivateQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: ["host-checkouts"] });
  queryClient.removeQueries({ queryKey: ["host-telegram"] });
  queryClient.removeQueries({ queryKey: ["checkout-receipt"] });
  queryClient.removeQueries({ queryKey: ["cellar-summary"] });
  queryClient.removeQueries({ queryKey: ["guest-links"] });
  queryClient.removeQueries({ queryKey: ["wine-catalog"] });
  queryClient.removeQueries({ queryKey: ["inventory-options"] });
  queryClient.removeQueries({ queryKey: ["host-inventory"] });
  queryClient.removeQueries({ queryKey: ["host-contacts"] });
  queryClient.removeQueries({ queryKey: ["cart-context"] });
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();
  const { data, error, status } = useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: async () => {
      const result = await getSession();
      if ("error" in result) throw new Error(result.error);
      return result.user;
    },
    retry: 1,
    enabled: true,
    staleTime: Infinity,
  });

  const authState: AuthState =
    status === "pending"
      ? { type: "loading" }
      : status === "error"
        ? {
            type: "unauthenticated",
            errorMessage: error instanceof Error ? error.message : "Session check failed",
          }
        : data
          ? { type: "authenticated", user: data }
          : { type: "unauthenticated" };

  const resetPrivateState = useCallback(() => {
    resetPrivateCart();
    clearCellarPrivateQueries(queryClient);
  }, [queryClient]);

  const logout = useCallback(async () => {
    const previousUser = queryClient.getQueryData<User>(AUTH_QUERY_KEY);
    queryClient.setQueryData(AUTH_QUERY_KEY, null);
    try {
      await postLogout();
      resetPrivateState();
    } catch (error) {
      if (previousUser) queryClient.setQueryData(AUTH_QUERY_KEY, previousUser);
      throw error;
    }
  }, [queryClient, resetPrivateState]);

  const onLogin = useCallback(
    (user: User) => {
      resetPrivateState();
      queryClient.setQueryData(AUTH_QUERY_KEY, user);
    },
    [queryClient, resetPrivateState],
  );

  return (
    <AuthContext.Provider value={{ authState, logout, onLogin }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error("useAuth must be used within a AuthProvider");
  return context;
};

