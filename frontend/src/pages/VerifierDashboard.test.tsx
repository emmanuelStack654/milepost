import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Buffer } from 'buffer';
import { VerifierDashboard } from './VerifierDashboard';
import { AttestationRevoke } from '../components/verifier/AttestationRevoke';
import type { VerifierAttestation } from '../fixtures/verifierFixtures';
import { explainCode } from '../lib/errors';

const PROGRAMME_A = `C${'A'.repeat(55)}`;
const PROGRAMME_B = `C${'B'.repeat(55)}`;
const REVIEWER = `G${'A'.repeat(55)}`;
const APPLICANT = `G${'B'.repeat(55)}`;

const hoisted = vi.hoisted(() => {
  const clients = new Map<string, unknown>();
  const state = {
    param: '',
    reviewer: true,
    review: vi.fn(),
  };
  const attestMocks = {
    attest: vi.fn(),
    revoke: vi.fn(),
  };
  return { clients, state, attestMocks };
});

function makeClient(id: string, overrides: { reviewer?: boolean; phase?: string; requested?: bigint } = {}) {
  return {
    is_reviewer: vi.fn(async () => ({ result: overrides.reviewer ?? hoisted.state.reviewer })),
    get_phase: vi.fn(async () => ({
      result: { unwrap: () => ({ tag: overrides.phase ?? 'Review' }) },
    })),
    get_application: vi.fn(async () => ({
      result: {
        unwrap: () => ({
          applicant: APPLICANT,
          finalized: false,
          metadata_hash: Buffer.alloc(32),
          requested: overrides.requested ?? 1_000_000_000n,
          submitted_at: 1n,
          votes: [],
          withdrawn: false,
        }),
      },
    })),
    review: hoisted.state.review,
    options: { contractId: id },
  };
}

vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    address: `G${'A'.repeat(55)}`,
    status: 'connected',
    connect: vi.fn(),
    signTransaction: vi.fn(async () => ({ signedTxXdr: 'xdr', signerAddress: `G${'A'.repeat(55)}` })),
  }),
}));

vi.mock('../context/useAnnouncer', () => ({ useAnnouncer: () => vi.fn() }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: vi.fn() }));

vi.mock('../hooks/useProgrammeParam', () => ({
  useProgrammeParam: () => ({
    raw: hoisted.state.param,
    programmeId: hoisted.state.param,
    status: 'valid',
    active: true,
    blocksProgramme: false,
    loading: false,
    error: null,
    message: null,
    clear: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock('../context/useSoroban', () => ({
  useSoroban: () => ({
    attest: {
      attest: hoisted.attestMocks.attest,
      revoke: hoisted.attestMocks.revoke,
    },
    programmeAt: (id: string) => hoisted.clients.get(id),
  }),
}));

function client(id: string) {
  return hoisted.clients.get(id) as ReturnType<typeof makeClient>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/verifiers']}>
      <VerifierDashboard />
    </MemoryRouter>,
  );
}

async function chooseApplicant() {
  fireEvent.change(screen.getByLabelText('Applicant address'), {
    target: { value: APPLICANT },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Load applicant' }));
  await screen.findByLabelText('Approved amount');
}

describe('VerifierDashboard reviewer programme picker', () => {
  beforeEach(() => {
    hoisted.state.param = PROGRAMME_A;
    hoisted.state.reviewer = true;
    hoisted.state.review.mockReset().mockImplementation(() =>
      Promise.resolve({
        result: { unwrap: () => undefined },
        signAndSend: vi.fn().mockResolvedValue({ result: { unwrap: () => undefined } }),
      }),
    );
    hoisted.attestMocks.attest.mockReset().mockImplementation(async () => ({
      signAndSend: vi.fn(async () => ({
        result: { unwrap: () => Buffer.alloc(32) },
      })),
    }));
    hoisted.attestMocks.revoke.mockReset().mockImplementation(async () => ({
      signAndSend: vi.fn(async () => ({
        result: { unwrap: () => undefined },
      })),
    }));
    hoisted.clients.clear();
    hoisted.clients.set(PROGRAMME_A, makeClient(PROGRAMME_A));
    hoisted.clients.set(PROGRAMME_B, makeClient(PROGRAMME_B));
  });

  it('runs reviewer reads against two different programmes', async () => {
    renderPage();
    await waitFor(() => expect(client(PROGRAMME_A).is_reviewer).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Programme address'), {
      target: { value: PROGRAMME_B },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use programme' }));

    await waitFor(() => expect(client(PROGRAMME_B).is_reviewer).toHaveBeenCalled());
    await chooseApplicant();
    expect(client(PROGRAMME_B).get_application).toHaveBeenCalledWith({
      applicant: APPLICANT,
    });
    expect(client(PROGRAMME_A).get_application).not.toHaveBeenCalled();
  });

  it('explains when the wallet is not a reviewer for the chosen programme', async () => {
    hoisted.clients.set(PROGRAMME_A, makeClient(PROGRAMME_A, { reviewer: false }));
    renderPage();

    await screen.findByText(/not a registered reviewer for this programme/);
    expect(screen.getByText('Not a reviewer')).toBeTruthy();
  });

  it('sends the vote to the chosen programme', async () => {
    renderPage();
    await screen.findByText('Reviewer wallet');
    await chooseApplicant();

    fireEvent.change(screen.getByLabelText('Approved amount'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit review vote' }));

    await waitFor(() =>
      expect(hoisted.state.review).toHaveBeenCalledWith({
        reviewer: REVIEWER,
        applicant: APPLICANT,
        approved: 100_000_000n,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// AttestationRevoke component tests
// ---------------------------------------------------------------------------

const ATTESTER = `G${'A'.repeat(55)}`;
const RAW_UID = 'a'.repeat(64); // valid 64-char hex → 32-byte Buffer

const baseAttestation: VerifierAttestation = {
  uid: 'att_aaaaaaaaaaaa…aaaa',
  rawUid: RAW_UID,
  programme: 'Secondary school bursaries 2026',
  programmeId: 'CBQ4SCHOOLBURSARY2026XK3ZP7M2QWJ5T8VN4RD6HY',
  subject: ATTESTER,
  schema: 'condition-met/v1',
  ledger: 4846120,
  used: false,
};

vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    address: ATTESTER,
    status: 'connected',
    connect: vi.fn(),
    signTransaction: vi.fn(async () => ({ signedTxXdr: 'xdr', signerAddress: ATTESTER })),
  }),
}));

function renderRevoke(overrides: Partial<VerifierAttestation> = {}, onRevoked = vi.fn()) {
  return render(
    <MemoryRouter>
      <AttestationRevoke
        attestation={{ ...baseAttestation, ...overrides }}
        onRevoked={onRevoked}
        sampleDelayMs={0}
      />
    </MemoryRouter>,
  );
}

describe('AttestationRevoke', () => {
  beforeEach(() => {
    hoisted.attestMocks.revoke.mockReset().mockImplementation(async () => ({
      signAndSend: vi.fn(async () => ({
        result: { unwrap: () => undefined },
      })),
    }));
  });

  it('shows a Revoke button for a revocable, non-revoked attestation', () => {
    renderRevoke();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeDefined();
  });

  it('shows "Cannot revoke" when revocable is explicitly false', () => {
    renderRevoke({ revocable: false });
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(screen.getByText('Cannot revoke')).toBeDefined();
  });

  it('shows "Revoked" status when already revoked', () => {
    renderRevoke({ revoked: true });
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(screen.getByText('Revoked')).toBeDefined();
  });

  it('asks for confirmation before revoking', () => {
    renderRevoke();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByText(/Revoking stops this proof being used again/i)).toBeDefined();
    expect(screen.getByText(/Any tranche already released stays released/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /yes, revoke/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDefined();
  });

  it('cancel hides the confirmation without calling the contract', () => {
    renderRevoke();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByText(/Revoking stops this proof/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeDefined();
    expect(hoisted.attestMocks.revoke).not.toHaveBeenCalled();
  });

  it('real: calls attest.revoke with the correct Buffer uid and attester', async () => {
    const onRevoked = vi.fn();
    renderRevoke({}, onRevoked);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: /yes, revoke/i }));

    expect(await screen.findByText('Attestation revoked')).toBeDefined();
    expect(hoisted.attestMocks.revoke).toHaveBeenCalledWith({
      attester: ATTESTER,
      uid: expect.any(Buffer),
    });
    const { uid: calledUid } = hoisted.attestMocks.revoke.mock.calls[0][0] as { uid: Buffer };
    expect(calledUid.toString('hex')).toBe(RAW_UID);
    expect(onRevoked).toHaveBeenCalledWith(baseAttestation.uid);
  });

  it('sample: uses the stand-in path when rawUid is absent', async () => {
    renderRevoke({ rawUid: undefined });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: /yes, revoke/i }));

    expect(await screen.findByText('Attestation revoked')).toBeDefined();
    expect(hoisted.attestMocks.revoke).not.toHaveBeenCalled();
  });

  it('surfaces NotRevocable (error 4) through explain() when the schema forbids it', async () => {
    hoisted.attestMocks.revoke.mockImplementation(async () => ({
      signAndSend: vi.fn(async () => {
        throw new Error('Error(Contract, #4)');
      }),
    }));

    renderRevoke();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: /yes, revoke/i }));

    const err4 = explainCode('attest', 4);
    expect(await screen.findByText(err4.message)).toBeDefined();
  });

  it('surfaces NotAttester (error 5) through explain()', async () => {
    hoisted.attestMocks.revoke.mockImplementation(async () => ({
      signAndSend: vi.fn(async () => {
        throw new Error('Error(Contract, #5)');
      }),
    }));

    renderRevoke();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: /yes, revoke/i }));

    const err5 = explainCode('attest', 5);
    expect(await screen.findByText(err5.message)).toBeDefined();
  });

  it('surfaces AlreadyRevoked (error 6) through explain()', async () => {
    hoisted.attestMocks.revoke.mockImplementation(async () => ({
      signAndSend: vi.fn(async () => {
        throw new Error('Error(Contract, #6)');
      }),
    }));

    renderRevoke();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: /yes, revoke/i }));

    const err6 = explainCode('attest', 6);
    expect(await screen.findByText(err6.message)).toBeDefined();
  });

  it('dashboard: Revoke button appears on each signed attestation', async () => {
    renderPage();
    await screen.findByText(/Signed by you/i);
    const revokeBtns = screen.getAllByRole('button', { name: 'Revoke' });
    // FIXTURE_MY_ATTESTATIONS has 2 entries; both should have a Revoke button
    // (fixture entries have no rawUid — sample path — but the button still renders).
    expect(revokeBtns.length).toBeGreaterThanOrEqual(2);
  });
});
