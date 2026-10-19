import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { RecipientApplicationFixture } from '../../fixtures/recipientFixtures';
import { FIXTURE_APPLICATIONS } from '../../fixtures/recipientFixtures';
import { formatAmount } from '../../lib/amount';
import { ApplicationWithdraw } from './ApplicationWithdraw';
import './ApplicationTimelineList.css';

interface ApplicationTimelineListProps {
  applications?: RecipientApplicationFixture[];
  onWithdrawn?: (programmeId: string) => void;
}

export function ApplicationTimelineList({
  applications = FIXTURE_APPLICATIONS,
  onWithdrawn,
}: ApplicationTimelineListProps) {
  // Track locally-withdrawn programmes so the card reflects the action
  // immediately without waiting for a list refetch.
  const [locallyWithdrawn, setLocallyWithdrawn] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const handleWithdrawn = (programmeId: string) => {
    setLocallyWithdrawn((prev) => new Set(prev).add(programmeId));
    onWithdrawn?.(programmeId);
  };

  if (applications.length === 0) {
    return (
      <div className="timeline-empty">
        No applications submitted yet.
      </div>
    );
  }

  return (
    <div className="timeline-grid">
      {applications.map((ap) => {
        const isWithdrawn = ap.withdrawn || locallyWithdrawn.has(ap.programmeId);
        const isFinalized = ap.finalized;
        const votesCount = ap.votes.length;
        // Quorum is capped at 16 per protocol specification
        const effectiveQuorum = Math.min(16, Math.max(1, ap.quorum));

        // Calculate median vote
        let medianFormatted = '';
        if (votesCount > 0) {
          const sorted = ap.votes.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          const medianBigInt =
            votesCount % 2 === 1
              ? sorted[(votesCount - 1) / 2]
              : (sorted[votesCount / 2 - 1] + sorted[votesCount / 2]) / 2n;
          medianFormatted = formatAmount(medianBigInt, { asset: 'USDC' });
        }

        const isReviewCurrent = ap.phase === 'Review' && !isWithdrawn;
        const isAwardSetDone = (votesCount >= effectiveQuorum && !isWithdrawn) || isFinalized;

        const steps = isWithdrawn
          ? [
              {
                title: 'Applied',
                status: 'done' as const,
                tag: 'Done',
                desc: `Asked for ${formatAmount(BigInt(ap.requested), { asset: 'USDC' })} · ledger ${ap.submittedLedger.toLocaleString()}`,
              },
              {
                title: 'Withdrawn',
                status: 'current' as const,
                tag: 'Done',
                desc: 'Withdrawn — you cancelled this application, so it will not be reviewed or finalised.',
              },
              {
                title: 'Award set',
                status: 'pending' as const,
                tag: 'Next',
                desc: 'No award will be set.',
              },
              {
                title: 'Tranches',
                status: 'pending' as const,
                tag: 'Next',
                desc: 'No tranches will be released.',
              },
            ]
          : [
              {
                title: 'Applied',
                status: 'done' as const,
                tag: 'Done',
                desc: `Asked for ${formatAmount(BigInt(ap.requested), { asset: 'USDC' })} · ledger ${ap.submittedLedger.toLocaleString()}`,
              },
              {
                title: 'Review',
                status: isReviewCurrent ? ('current' as const) : ('pending' as const),
                tag: isReviewCurrent ? 'Now' : 'Next',
                desc:
                  ap.phase === 'Open'
                    ? 'Starts when applications close.'
                    : isFinalized
                    ? `Finalised — your award is ${medianFormatted}, the median of ${votesCount} reviewer votes.`
                    : `${votesCount} of ${effectiveQuorum} reviewer votes in.`,
              },
              {
                title: 'Award set',
                status: isAwardSetDone ? ('done' as const) : ('pending' as const),
                tag: isAwardSetDone ? 'Done' : 'Next',
                desc: isAwardSetDone
                  ? `Median of the votes: ${medianFormatted}`
                  : `Needs ${effectiveQuorum} votes. The award will be the median, not the lowest or the average.`,
              },
              {
                title: 'Tranches',
                status: 'pending' as const,
                tag: 'Next',
                desc: 'Released one at a time as a verifier confirms each condition.',
              },
            ];

        const phaseClass =
          ap.phase === 'Open'
            ? 'timeline-card__phase-badge--open'
            : ap.phase === 'Review'
            ? 'timeline-card__phase-badge--review'
            : ap.phase === 'Cancelled'
            ? 'timeline-card__phase-badge--cancelled'
            : 'timeline-card__phase-badge--settled';

        return (
          <article
            key={ap.programmeId}
            className={`timeline-card${isWithdrawn ? ' timeline-card--withdrawn' : ''}`}
            aria-labelledby={`timeline-app-${ap.programmeId}`}
          >
            <div className="timeline-card__header">
              <Link
                id={`timeline-app-${ap.programmeId}`}
                to={`/programme/${encodeURIComponent(ap.programmeId)}`}
                className="timeline-card__title"
              >
                {ap.programmeName}
              </Link>

              <div className="timeline-card__badges">
                {ap.sample && (
                  <span className="timeline-card__sample">Sample data</span>
                )}
                <span className={`timeline-card__phase-badge ${phaseClass}`}>
                  {ap.phase}
                </span>
              </div>
            </div>

            <ol className="timeline-card__steps" aria-label="Application progress">
              {steps.map((s, idx) => {
                const markerClass =
                  s.status === 'done'
                    ? 'timeline-step__marker--done'
                    : s.status === 'current'
                    ? 'timeline-step__marker--current'
                    : 'timeline-step__marker--pending';

                const isEmphasized = s.status === 'current';

                return (
                  <li key={idx} className="timeline-step">
                    <span className={`timeline-step__marker ${markerClass}`} aria-hidden="true" />
                    <div className="timeline-step__content">
                      <div
                        className={`timeline-step__title-row${
                          isEmphasized ? ' timeline-step__title-row--emphasized' : ''
                        }`}
                      >
                        <span>{s.title}</span>
                        <span className="timeline-step__status-tag">· {s.tag}</span>
                      </div>
                      <span className="timeline-step__desc">{s.desc}</span>
                    </div>
                  </li>
                );
              })}
            </ol>

            {/* Withdraw action — only shown when withdrawal is still possible */}
            {!isWithdrawn && !isFinalized && (
              <ApplicationWithdraw
                application={{ ...ap, withdrawn: isWithdrawn }}
                onWithdrawn={handleWithdrawn}
              />
            )}
          </article>
        );
      })}
    </div>
  );
}
