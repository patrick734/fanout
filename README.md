# Fanout — batch sender on BOT Chain

Send BOT or any ERC-20 token to up to 300 wallets in one transaction: payroll,
contributor rewards, refunds, community payouts. Paste `address, amount` lines
(or load a CSV) and the site validates every line before anything is sent.

- **All-or-nothing:** if any single transfer fails, the whole batch reverts and nothing is sent.
- **No custody:** tokens go straight from the sender's wallet to each recipient. BOT passes
  through in the same transaction. The contract only ever holds the per-batch fee.
- **Fee:** a flat 0.05 BOT per batch (hard-capped at 1 BOT), pushed to the treasury by `collectFees()`.

## What the contract owner can and can't do
The owner can set the fee (≤ 1 BOT), set the treasury and pause sending.
There is no function that moves anyone's funds; a test checks the full list.

## Security properties (covered by tests)
- Exact `msg.value` required (sum + fee for BOT, fee for tokens)
- Rejects empty batches, mismatched lists, zero addresses, zero amounts and more than 300 recipients
- ReentrancyGuard on every send; SafeERC20 for tokens; two-step ownership
- Works with fee-on-transfer tokens (recipients get what the token delivers)

## Run
```bash
npm install
npx hardhat test               # if the solc CDN is blocked: USE_SOLCJS=1 npx hardhat test
cp .env.example .env           # PRIVATE_KEY, BOT_RPC_URL, OWNER_ADDRESS, TREASURY_ADDRESS
npx hardhat run scripts/deploy.js --network botMainnet
```
Then put the printed address in `docs/index.html` → `CONFIG.contract` and deploy to Vercel
(Framework Preset: Other).

BOT Chain mainnet: chain ID 677, gas token BOT, explorer https://scan.botchain.ai.
