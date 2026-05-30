import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PrivyProvider,
  useLoginWithEmail,
  useLoginWithOAuth,
  useOAuthTokens,
  usePrivy,
  useWallets
} from "@privy-io/react-auth";
import { bsc, bscTestnet, sepolia } from "viem/chains";

const config = {
  appId: import.meta.env.VITE_APP_PRIVY_APP_ID,
  clientId: import.meta.env.VITE_APP_PRIVY_CLIENT_ID,
  redirectUri: import.meta.env.VITE_APP_PRIVY_REDIRECT_URI,
  logoutRedirectUri: import.meta.env.VITE_APP_PRIVY_LOGOUT_REDIRECT_URI,
  loginRedirectUri: import.meta.env.VITE_APP_PRIVY_LOGIN_REDIRECT_URI
};

const customBsc = {
  ...bsc,
  rpcUrls: {
    default: {
      http: [
        "https://bsc-dataseed.binance.org",
        "https://rpc.ankr.com/bsc",
        "https://bsc.rpc.blxrbdn.com",
        "https://56.rpc.thirdweb.com"
      ]
    }
  }
};

function emitStatus(message) {
  window.dispatchEvent(new CustomEvent("buidlai:account-status", { detail: { message } }));
}

function getEmbeddedEthWallet(wallets) {
  return wallets.find(
    (wallet) =>
      wallet.walletClientType === "privy" &&
      wallet.type === "ethereum" &&
      wallet.connectorType === "embedded"
  );
}

function errorMessage(error, fallback) {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  return error.message || error.privyErrorCode || error.error || fallback;
}

function isExitedAuthFlow(error) {
  const message = errorMessage(error, "");
  return message === "exited_auth_flow" || message.includes("exited_auth_flow");
}

function TagaiPrivyBridge() {
  const { state: oauthState, loading: oauthLoading, initOAuth } = useLoginWithOAuth();
  const { authenticated, getAccessToken, logout } = usePrivy();
  const { wallets, ready } = useWallets();
  const [email, setEmail] = useState("");
  const sessionRef = useRef(null);
  const bondConsumedRef = useRef(false);

  const { sendCode, loginWithCode } = useLoginWithEmail({
    onComplete: async () => {
      const privyAccessToken = await getAccessToken();
      if (!privyAccessToken || !email) {
        emitStatus("Privy email login missing token or email.");
        return;
      }
      const account = await window.BUIDLaiAccount?.completePrivyEmailLogin({
        privyAccessToken,
        email
      });
      sessionRef.current = account;
      bondConsumedRef.current = false;
    },
    onError: (error) => {
      console.error("Email login failed:", error);
      emitStatus("Email login failed.");
    }
  });

  const { reauthorize } = useOAuthTokens({
    onOAuthTokenGrant: async ({ oAuthTokens }) => {
      try {
        const privyAccessToken = await getAccessToken();
        if (!privyAccessToken) {
          emitStatus("Privy access token missing.");
          return;
        }
        const account = await window.BUIDLaiAccount?.completePrivyTwitterLogin({
          privyAccessToken,
          accessToken: oAuthTokens.accessToken,
          refreshToken: oAuthTokens.refreshToken
        });
        sessionRef.current = account;
        bondConsumedRef.current = false;
      } catch (error) {
        console.error("Twitter OAuth token grant error:", error);
        emitStatus(`Twitter login failed: ${errorMessage(error, "TagAI account sync error")}`);
      }
    }
  });

  useEffect(() => {
    if (oauthState.status === "error") {
      const error = oauthState.error;
      console.error("Twitter OAuth failed:", error);
      if (isExitedAuthFlow(error)) {
        emitStatus("Twitter login was cancelled. Please click Log in with Twitter again.");
        return;
      }
      emitStatus(`Twitter login failed: ${errorMessage(error, "Privy OAuth error")}`);
    }
    if (oauthState.status === "loading" || oauthLoading) {
      emitStatus("Opening Twitter authorization...");
    }
    if (oauthState.status === "success") {
      emitStatus("Twitter authorized. Syncing TagAI account...");
    }
  }, [oauthLoading, oauthState]);

  useEffect(() => {
    if (!ready || !sessionRef.current || bondConsumedRef.current) return;
    const wallet = getEmbeddedEthWallet(wallets);
    if (!wallet) return;
    const account = sessionRef.current;
    const backendAddr = account.ethAddr ? String(account.ethAddr).toLowerCase() : "";
    const needBond = (!account.ethAddr || account.walletType === 1) && backendAddr !== wallet.address.toLowerCase();
    if (!needBond) return;
    bondConsumedRef.current = true;
    getAccessToken()
      .then((privyAccessToken) =>
        window.BUIDLaiAccount?.bondEthByPrivyAccessToken({
          privyAccessToken,
          ethAddr: wallet.address
        })
      )
      .catch((error) => {
        console.error("Privy embedded wallet bond failed:", error);
        emitStatus("Privy embedded wallet bond failed.");
      });
  }, [ready, wallets, getAccessToken]);

  useEffect(() => {
    window.BUIDLaiPrivy = {
      loginWithTwitter: async () => {
        emitStatus("");
        window.localStorage.setItem("lastLoginTime", "0");
        if (authenticated) {
          await reauthorize({ provider: "twitter" });
          return;
        }
        await logout();
        await initOAuth({ provider: "twitter" });
      },
      loginWithEmail: async (nextEmail) => {
        emitStatus("");
        setEmail(nextEmail);
        window.localStorage.setItem("lastLoginTime", "0");
        await logout();
        await sendCode({ email: nextEmail });
        const code = window.prompt("Input Privy email code");
        if (code) await loginWithCode({ code });
      },
      logout: async () => {
        await logout();
      }
    };
    window.dispatchEvent(new CustomEvent("buidlai:privy-ready"));
  }, [authenticated, initOAuth, loginWithCode, logout, reauthorize, sendCode]);

  return null;
}

function PrivyAdapter() {
  if (!config.appId) {
    console.warn("VITE_APP_PRIVY_APP_ID is not configured.");
    return null;
  }

  return (
    <PrivyProvider
      appId={config.appId}
      clientId={config.clientId}
      config={{
        customOAuthRedirectUrl: window.location.origin,
        embeddedWallets: {
          ethereum: {
            createOnLogin: "all-users"
          }
        },
        supportedChains: [customBsc, bscTestnet, sepolia]
      }}
    >
      <TagaiPrivyBridge />
    </PrivyProvider>
  );
}

const rootNode = document.createElement("div");
rootNode.id = "buidlai-privy-root";
document.body.appendChild(rootNode);
createRoot(rootNode).render(<PrivyAdapter />);
