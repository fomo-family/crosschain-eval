import "./App.css";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import {
  useSolanaWallets,
  useSendTransaction,
} from "@privy-io/react-auth/solana";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { useState } from "react";

const connection = new Connection(import.meta.env.VITE_SOLANA_RPC_URL, {
  commitment: "confirmed",
});

function App() {
  const { ready, authenticated, user, login, logout } = usePrivy();

  // Wait until the Privy client is ready before taking any actions
  if (!ready) {
    return null;
  }

  return (
    <div className="App">
      <header className="App-header">
        {/* If the user is not authenticated, show a login button */}
        {/* If the user is authenticated, show the user object and a logout button */}
        {ready && authenticated ? (
          <div>
            {/* <textarea
              readOnly
              value={JSON.stringify(user, null, 2)}
              style={{ width: "600px", height: "250px", borderRadius: "6px" }}
            /> */}
            <UserInfo />
            <br />
            <button
              onClick={logout}
              style={{
                marginTop: "20px",
                padding: "12px",
                backgroundColor: "#069478",
                color: "#FFF",
                border: "none",
                borderRadius: "6px",
              }}
            >
              Log Out
            </button>
          </div>
        ) : (
          <button
            onClick={login}
            style={{
              padding: "12px",
              backgroundColor: "#069478",
              color: "#FFF",
              border: "none",
              borderRadius: "6px",
            }}
          >
            Log In
          </button>
        )}
      </header>
    </div>
  );
}

function UserInfo() {
  const { user } = usePrivy();
  const ethWallets = useWallets();
  const solanaWallets = useSolanaWallets();
  const { sendTransaction } = useSendTransaction();
  const [quote, setQuote] = useState(null);

  const ethWallet = ethWallets.wallets[0];
  const solanaWallet = solanaWallets.wallets[0];

  return (
    <div>
      <div>
        <h3>Email</h3>
        <p>{user?.email?.address || "No email"}</p>
      </div>
      <div>
        <h3>EVM Wallet</h3>
        <p>{ethWallet?.address || "No wallet"}</p>
      </div>
      <div>
        <h3>Solana Wallet</h3>
        <p>{solanaWallet?.address || "No wallet"}</p>
      </div>
      <div>
        <button
          onClick={() => {
            getRelayQuote(solanaWallet?.address, ethWallet?.address).then(
              (quote) => {
                setQuote(quote);
              }
            );
          }}
        >
          Get Relay Quote
        </button>
      </div>
      {quote && (
        <div>
          <button
            onClick={() =>
              sendTransactionHelper(
                quote,
                solanaWallet?.address,
                sendTransaction
              )
            }
          >
            Send Transaction
          </button>
        </div>
      )}
    </div>
  );
}

const RELAY_SOLANA_CHAIN_ID = 792703809;
const RELAY_BASE_CHAIN_ID = 8453;

async function getRelayQuote(solAddress, baseAddress) {
  const response = await withTiming(
    "getRelayQuote",
    async () =>
      await fetch("https://api.relay.link/quote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user: solAddress,
          recipient: baseAddress,
          originChainId: RELAY_SOLANA_CHAIN_ID,
          destinationChainId: RELAY_BASE_CHAIN_ID,
          originCurrency: "11111111111111111111111111111111",
          destinationCurrency: "0x0000000000000000000000000000000000000000",
          amount: "10000000", // 0.01 SOL in lamports
          tradeType: "EXACT_INPUT",
        }),
      })
  );

  return await response.json();
}

async function createTransactionFromStep(stepItem, solAddress) {
  const instructions =
    stepItem?.data?.instructions?.map(
      (i) =>
        new TransactionInstruction({
          keys: i.keys.map((k) => ({
            isSigner: k.isSigner,
            isWritable: k.isWritable,
            pubkey: new PublicKey(k.pubkey),
          })),
          programId: new PublicKey(i.programId),
          data: Buffer.from(i.data, "hex"),
        })
    ) ?? [];

  const messageV0 = new TransactionMessage({
    payerKey: new PublicKey(solAddress),
    instructions,
    recentBlockhash: await connection
      .getLatestBlockhash()
      .then((b) => b.blockhash),
  }).compileToV0Message(
    await Promise.all(
      stepItem?.data?.addressLookupTableAddresses?.map(
        async (address) =>
          await connection
            .getAddressLookupTable(new PublicKey(address))
            .then((res) => res.value)
      ) ?? []
    )
  );

  const transaction = new VersionedTransaction(messageV0);

  return transaction;
}

async function sendTransactionHelper(quote, solAddress, sendTransaction) {
  if (quote.steps.length !== 1 || quote.steps[0].items.length !== 1) {
    console.error("Invalid quote");
    return;
  }
  if (quote.steps[0].kind !== "transaction") {
    console.error("Step is not a transaction");
    return;
  }

  const requestId = quote.steps[0].requestId;

  const transaction = await withTiming(
    "createTransactionFromStep",
    async () =>
      await createTransactionFromStep(quote.steps[0].items[0], solAddress)
  );

  const signature = await withTiming(
    "sendTransaction",
    async () =>
      await sendTransaction({
        transaction: transaction,
        connection: connection,
        address: solAddress,
      })
  );
  console.log("Transaction sent", signature);

  const status = await withTiming(
    "waitForSwapToComplete",
    async () => await waitForSwapToComplete(requestId)
  );
  console.log("Swap completed", status);

  return signature;
}

async function withTiming(name, fn) {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();
  console.log(`${name} took ${end - start} milliseconds`);
  return result;
}

const checkSwapStatus = async (requestId) => {
  const response = await fetch(
    `https://api.relay.link/intents/status/v2?requestId=${requestId}`
  );

  if (!response.ok) {
    throw new Error(`Status check failed: ${response.statusText}`);
  }

  const data = await response.json();
  console.log("Swap status", data.status);
  return data;
};

const waitForSwapToComplete = async (requestId) => {
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      const status = await checkSwapStatus(requestId);
      if (status.status === "success") {
        clearInterval(interval);
        resolve(status);
      }
    }, 200);
    setTimeout(() => {
      clearInterval(interval);
      reject(new Error("Swap timed out"));
    }, 60000);
  });
};

export default App;
