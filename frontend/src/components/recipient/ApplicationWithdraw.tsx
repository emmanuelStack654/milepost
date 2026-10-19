import { useState } from 'react';
import { useWallet } from '../../context/useWallet';
import { useSoroban } from '../../context/useSoroban';
import { useTransaction } from '../../hooks/useTransaction';
import { useAnnouncer } from '../../context/useAnnouncer';
import { looksLikeContractId } from '../../lib/format';
import { sampleSendable, SAMPLE_TX_DELAY_MS } from '../../lib/fundingTx';
import { ErrorPanel, TransactionOutcome } from '../state/AsyncStates';
import type { RecipientApplicationFixture } from '../../fixtures/recipientFixtures';
import './ApplicationWithdraw.css';

export interface ApplicationWithdrawProps {
  application: RecipientApplicationFixture;
  /** Called after a confirmed withdrawal so the parent can refresh the list. */
  onWithdrawn?: (programmeId: string) => void;
  sampleDelayMs?: number;
}

/**
 * Withdraw an open application.
 *
 * `withdraw(applicant)` works only before the application is finalised; once
 * it has been settled into an award the contract returns error 13
 * (AlreadyFinalized). A withdrawn application cannot be reviewed, finalised
 * or re-submitted (error 37 — Withdrawn).
 *
 * For real programmes the action goes through `useTransaction`; for sample
 * programmes `sampleSendable` keeps the stand-in path so the layout can be
 * judged without a wallet.
 *
 * The button opens a confirmation step before signing — withdrawal is
 * irreversible, so "are you sure?" is genuinely useful here.
 */
export function ApplicationWithdraw({
  application,
  onWithdrawn,
  sampleDelayMs = SAMPLE_TX_DELAY_MS,
}: ApplicationWithdrawProps) {
  const announce = useAnnouncer();
  const { address } = useWallet();
  const { programmeAt } = useSoroban();

  const isReal = looksLikeContractId(application.programmeId);
  const isSample = !isReal;

  const [confirming, setConfirming] = useState(false);

  const tx = useTransaction<void>({
    contract: 'program',
    onSuccess: () => {
      announce('Application withdrawn.');
      onWithdrawn?.(application.programmeId);
    },
  });

  // Gate: already finalised or already withdrawn — no action offered.
  if (application.finalized || application.withdrawn) return null;

  const handleWithdraw = async () => {
    const applicant = address ?? '';
    await tx.send(async () => {
      if (isSample) {
        return sampleSendable(() => undefined, sampleDelayMs);
      }
      const client = programmeAt(application.programmeId);
      const assembled = await client.withdraw({ applicant });
      return {
        signAndSend: async (
          options: Parameters<typeof assembled.signAndSend>[0],
        ) => {
          const sent = await assembled.signAndSend(options);
          sent.result.unwrap();
          return { result: undefined as void };
        },
      };
    });
  };

  return (
    <div className="app-withdraw">
      {!confirming && tx.phase !== 'success' && (
        <button
          type="button"
          className="app-withdraw__trigger"
          onClick={() => setConfirming(true)}
          disabled={tx.busy}
        >
          Withdraw application
        </button>
      )}

      {confirming && !tx.busy && tx.phase !== 'success' && (
        <div className="app-withdraw__confirm" role="region" aria-label="Confirm withdrawal">
          <p className="app-withdraw__warning">
            <strong>This cannot be undone.</strong> Withdrawing removes your application from
            review. You will not be able to re-apply to this programme.
          </p>
          <div className="app-withdraw__actions">
            <button
              type="button"
              className="app-withdraw__confirm-btn"
              onClick={() => void handleWithdraw()}
              disabled={tx.busy}
            >
              Yes, withdraw
            </button>
            <button
              type="button"
              className="app-withdraw__cancel-btn"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <TransactionOutcome
        phase={tx.phase}
        error={tx.error}
        successTitle="Application withdrawn"
        successDescription="Your application has been removed from review."
        pendingTitle="Withdrawing application…"
        onRetry={() => void handleWithdraw()}
        onDismiss={() => tx.reset()}
      />

      {tx.phase === 'error' && tx.error && (
        <ErrorPanel explained={tx.error} onRetry={() => void handleWithdraw()} live={false} />
      )}
    </div>
  );
}
