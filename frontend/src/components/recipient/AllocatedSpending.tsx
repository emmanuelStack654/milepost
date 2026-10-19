import { useMemo, useState } from 'react';
import { useSoroban } from '../../context/useSoroban';
import { useWallet } from '../../context/useWallet';
import { useContractRead, useTransaction } from '../../hooks';
import { formatAmount, validateAmount } from '../../lib/amount';
import { explain, explainCode, type Explained } from '../../lib/errors';
import { looksLikeContractId, truncateAddress } from '../../lib/format';
import { sampleSendable, SAMPLE_TX_DELAY_MS } from '../../lib/fundingTx';
import { AmountField, Button, Field } from '../ui';
import { ErrorPanel, TransactionOutcome } from '../state/AsyncStates';
import type { RecipientAwardFixture } from '../../fixtures/recipientFixtures';
import './AllocatedSpending.css';

/** A payee is a Stellar account — a `G` address. */
const PAYEE_ADDRESS = /^G[A-Z2-7]{55}$/;
const ASSET = 'USDC';

type PayeeCheck =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'verified' }
  | { status: 'unverified' }
  | { status: 'error'; explained: Explained };

export interface AllocatedSpendingProps {
  award: RecipientAwardFixture;
  /** Stand-in transaction delay for sample programmes, overridable for tests. */
  sampleDelayMs?: number;
}

/**
 * The Allocated spending section: directing escrowed funds to a verified payee.
 *
 * In Allocated mode the money waits in escrow until the recipient chooses a
 * payee. `program` keeps no payee list, so the recipient enters or pastes an
 * address and we check it with `is_payee` before anything is signed. The
 * available amount is `allocation_of(recipient)`, read on-chain and re-read
 * after a successful `spend`. Every failure renders through `explain()`.
 *
 * Sample programmes — those whose id is not a real contract address — fall
 * back to the fixture escrow and a stand-in send, so the layout is still
 * demonstrable without a contract behind it.
 */
export function AllocatedSpending({ award, sampleDelayMs = SAMPLE_TX_DELAY_MS }: AllocatedSpendingProps) {
  const wallet = useWallet();
  const { programmeAt } = useSoroban();

  const isReal = looksLikeContractId(award.programmeId);
  const recipient = wallet.address;

  const client = useMemo(
    () => (isReal ? programmeAt(award.programmeId) : null),
    [isReal, programmeAt, award.programmeId],
  );

  // Escrow this recipient may still direct. `allocation_of` is infallible —
  // returns i128 directly, no Result wrapper, so use useContractRead not
  // useContractResult.
  const allocationRead = useContractRead<bigint>(
    () => client!.allocation_of({ recipient: recipient! }),
    [client, recipient],
    { enabled: isReal && Boolean(recipient), contract: 'program' },
  );

  const sampleAllocation = award.escrow ? BigInt(award.escrow) : 0n;
  const allocation = isReal ? (allocationRead.data ?? 0n) : sampleAllocation;

  const [payeeAddress, setPayeeAddress] = useState('');
  const [payeeCheck, setPayeeCheck] = useState<PayeeCheck>({ status: 'idle' });
  const [amount, setAmount] = useState('');
  const [sentInfo, setSentInfo] = useState<{ payee: string; amount: bigint } | null>(null);

  const tx = useTransaction<bigint>({
    contract: 'program',
    onSuccess: () => {
      // Re-read escrow after a successful spend so the balance updates.
      if (isReal) allocationRead.refetch();
      setPayeeAddress('');
      setAmount('');
      setPayeeCheck({ status: 'idle' });
    },
  });

  const amountResult = validateAmount(amount, { balance: allocation, asset: ASSET });
  const amountValue = amountResult.ok ? amountResult.value : null;

  const trimmedPayee = payeeAddress.trim();
  const payeeFieldError =
    trimmedPayee === '' || PAYEE_ADDRESS.test(trimmedPayee)
      ? null
      : 'Enter a valid Stellar address (starts with G).';
  const canCheckPayee = PAYEE_ADDRESS.test(trimmedPayee) && payeeCheck.status !== 'checking';
  const canSend =
    payeeCheck.status === 'verified' &&
    amountValue !== null &&
    !tx.busy &&
    Boolean(recipient);

  const receipt = sentInfo
    ? `${formatAmount(sentInfo.amount, { asset: ASSET })} to ${truncateAddress(sentInfo.payee)}`
    : undefined;

  const handlePayeeChange = (value: string) => {
    setPayeeAddress(value);
    // Clear the previous check result whenever the address changes so the
    // user cannot send to an address that was verified but then edited.
    setPayeeCheck({ status: 'idle' });
  };

  const handleCheckPayee = async () => {
    const addr = payeeAddress.trim();
    if (!PAYEE_ADDRESS.test(addr)) return;
    setPayeeCheck({ status: 'checking' });
    try {
      if (isReal) {
        const { result } = await client!.is_payee({ payee: addr });
        if (result) {
          setPayeeCheck({ status: 'verified' });
        } else {
          setPayeeCheck({ status: 'unverified' });
        }
      } else {
        // Sample stand-in: a valid address reads as verified for the demo.
        setPayeeCheck({ status: 'verified' });
      }
    } catch (caught) {
      setPayeeCheck({ status: 'error', explained: explain(caught, 'program') });
    }
  };

  const handleSend = async () => {
    if (payeeCheck.status !== 'verified' || amountValue === null || !recipient) return;
    const payee = payeeAddress.trim();
    setSentInfo({ payee, amount: amountValue });
    tx.reset();
    await tx.send(async () => {
      if (!isReal) {
        return sampleSendable(() => allocation - amountValue, sampleDelayMs);
      }
      const assembled = await client!.spend({ recipient, payee, amount: amountValue });
      return {
        signAndSend: async (options: Parameters<typeof assembled.signAndSend>[0]) => {
          const sent = await assembled.signAndSend(options);
          const remaining = sent.result.unwrap();
          return { result: remaining };
        },
      };
    });
  };

  return (
    <div className="allocated-spending">
      <div className="allocated-spending__header">
        <span className="allocated-spending__title">Held for you in escrow</span>
        <span className="allocated-spending__amount">
          {formatAmount(allocation, { asset: ASSET })}
        </span>
      </div>

      {!isReal && <span className="allocated-spending__sample">Sample data</span>}

      {allocation > 0n && (
        <div className="allocated-spending__form">
          <p className="allocated-spending__note">
            Enter or paste the address of the payee you want to receive the funds.
            Only addresses the programme creator verified are accepted — check
            before signing so you do not lose your submission fee to a refused
            transaction.
          </p>

          <Field
            label="Payee address"
            placeholder="G…"
            value={payeeAddress}
            onChange={(event) => handlePayeeChange(event.target.value)}
            error={payeeFieldError}
            autoComplete="off"
            spellCheck={false}
          />

          <Button
            variant="secondary"
            className="allocated-spending__check-btn"
            onClick={() => void handleCheckPayee()}
            loading={payeeCheck.status === 'checking'}
            disabled={!canCheckPayee}
          >
            Check payee
          </Button>

          {payeeCheck.status === 'verified' && (
            <p className="allocated-spending__verified" role="status">
              Verified — this payee can receive escrow.
            </p>
          )}

          {payeeCheck.status === 'unverified' && (
            <ErrorPanel explained={explainCode('program', 30)} live={false} />
          )}

          {payeeCheck.status === 'error' && (
            <ErrorPanel explained={(payeeCheck as { status: 'error'; explained: Explained }).explained} live={false} />
          )}

          <AmountField
            label="Amount"
            value={amount}
            onChange={setAmount}
            asset={ASSET}
            balance={allocation}
          />

          <Button
            className="allocated-spending__send-btn"
            onClick={() => void handleSend()}
            disabled={!canSend}
            loading={tx.busy}
          >
            Send to payee
          </Button>

          <TransactionOutcome
            phase={tx.phase}
            error={tx.error}
            successTitle="Sent to payee"
            successDescription={receipt}
            onDismiss={() => tx.reset()}
            onRetry={() => void handleSend()}
          />
        </div>
      )}

      {allocation === 0n && !tx.busy && tx.phase !== 'success' && (
        <p className="allocated-spending__empty">Nothing held in escrow right now.</p>
      )}
    </div>
  );
}
