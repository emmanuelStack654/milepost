import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Buffer } from 'buffer';
import { FIXTURE_ATTESTATIONS } from '../fixtures/attestationFixtures';
import { AttestationLookup } from './AttestationLookup';
import { explainCode } from '../lib/errors';

// Issue #408 — the used/unused state comes from `program.is_spent` for the
// selected programme, never from a fixture flag. Without a programme the page
// says the check needs one.

const PROGRAMME = `C${'A'.repeat(55)}`;
const sample = FIXTURE_ATTESTATIONS.find((a) => !a.revoked)!;

const state = vi.hoisted(() => {
  const programme = {
    is_spent: (...args: unknown[]) => state.isSpent(...args),
  };
  const programmeAt = () => programme;
  const attestMocks = {
    verify: vi.fn(),
    get: vi.fn(),
  };
  return { isSpent: vi.fn(), programmeAt, attestMocks };
});

vi.mock('../context/useSoroban', () => ({
  useSoroban: () => ({
    programmeAt: state.programmeAt,
    attest: {
      verify: state.attestMocks.verify,
      get: state.attestMocks.get,
    },
  }),
}));

function renderPage() {
  return render(<AttestationLookup />);
}

function lookUpSample() {
  fireEvent.click(screen.getByRole('button', { name: sample.uid }));
}

function selectProgramme() {
  fireEvent.change(
    screen.getByLabelText('Programme (to check whether a proof was used)'),
    { target: { value: PROGRAMME } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Use programme' }));
}

describe('AttestationLookup spent status', () => {
  beforeEach(() => {
    state.isSpent = vi.fn(() => Promise.resolve({ result: true }));
  });

  it('asks for a programme instead of guessing the used state', () => {
    renderPage();
    lookUpSample();

    expect(screen.getByText('Select a programme to check usage')).toBeTruthy();
    expect(state.isSpent).not.toHaveBeenCalled();
  });

  it('shows a proof already spent in the selected programme', async () => {
    state.isSpent = vi.fn(() => Promise.resolve({ result: true }));
    renderPage();
    lookUpSample();
    selectProgramme();

    await screen.findByText('Already released a tranche here');
    // The status names the programme it was checked against.
    expect(screen.getByText(PROGRAMME)).toBeTruthy();
    expect(state.isSpent).toHaveBeenCalled();
    expect(state.isSpent.mock.calls[0][0].attestation.toString('hex')).toBe(sample.uid);
  });

  it('shows a proof that is still unused in the selected programme', async () => {
    state.isSpent = vi.fn(() => Promise.resolve({ result: false }));
    renderPage();
    lookUpSample();
    selectProgramme();

    await screen.findByText('Not used in this programme');
  });

  it('does not claim the proof is unused when the read fails', async () => {
    state.isSpent = vi.fn(() => Promise.reject(new Error('rpc down')));
    renderPage();
    lookUpSample();
    selectProgramme();

    await screen.findByText('Could not check this programme');
  });
});

// ---------------------------------------------------------------------------
// "Check a claim" — on-chain verify + get
// ---------------------------------------------------------------------------

const VALID_UID     = 'a'.repeat(64);   // 64-char hex → valid uid
const VALID_SCHEMA  = 'b'.repeat(64);   // 64-char hex → valid schema uid
const SUBJECT       = `G${'A'.repeat(55)}`;
const ATTESTER      = `G${'B'.repeat(55)}`;

/** Minimal Attestation record as the contract returns it. */
function makeAttestation(overrides: Record<string, unknown> = {}) {
  return {
    uid: Buffer.from(VALID_UID, 'hex'),
    schema: Buffer.from(VALID_SCHEMA, 'hex'),
    attester: ATTESTER,
    subject: SUBJECT,
    created_at: 1_000_000n,
    data_hash: Buffer.alloc(32),
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function openClaimTab() {
  fireEvent.click(screen.getByRole('tab', { name: 'Check a claim' }));
}

function fillClaimForm(opts: { uid?: string; subject?: string; schema?: string; attester?: string } = {}) {
  fireEvent.change(screen.getByLabelText('Attestation uid (hex)'), {
    target: { value: opts.uid ?? VALID_UID },
  });
  fireEvent.change(screen.getByLabelText('Subject address'), {
    target: { value: opts.subject ?? SUBJECT },
  });
  fireEvent.change(screen.getByLabelText('Schema uid (hex)'), {
    target: { value: opts.schema ?? VALID_SCHEMA },
  });
  fireEvent.change(screen.getByLabelText('Attester address'), {
    target: { value: opts.attester ?? ATTESTER },
  });
}

function submitClaimForm() {
  fireEvent.click(screen.getByRole('button', { name: 'Check claim' }));
}

describe('AttestationLookup — Check a claim (on-chain)', () => {
  beforeEach(() => {
    state.attestMocks.verify.mockReset();
    state.attestMocks.get.mockReset();
  });

  it('validates that uid and schema must be 64-char hex before calling the contract', () => {
    renderPage();
    openClaimTab();
    fillClaimForm({ uid: 'not-hex', schema: 'also-not-hex' });
    submitClaimForm();

    expect(screen.getByText('Enter the 64-character hex attestation uid.')).toBeDefined();
    expect(screen.getByText('Enter the 64-character hex schema uid.')).toBeDefined();
    expect(state.attestMocks.verify).not.toHaveBeenCalled();
    expect(state.attestMocks.get).not.toHaveBeenCalled();
  });

  it('shows "Yes" when verify returns true', async () => {
    state.attestMocks.get.mockResolvedValue({
      result: { unwrap: () => makeAttestation() },
    });
    state.attestMocks.verify.mockResolvedValue({ result: true });

    renderPage();
    openClaimTab();
    fillClaimForm();
    submitClaimForm();

    expect(await screen.findByText('Yes')).toBeDefined();
    expect(screen.getByText(/This subject holds a valid claim/i)).toBeDefined();

    expect(state.attestMocks.get).toHaveBeenCalledWith({
      uid: expect.any(Buffer),
    });
    const { uid } = state.attestMocks.get.mock.calls[0][0] as { uid: Buffer };
    expect(uid.toString('hex')).toBe(VALID_UID);

    expect(state.attestMocks.verify).toHaveBeenCalledWith({
      uid: expect.any(Buffer),
      subject: SUBJECT,
      schema: expect.any(Buffer),
      attester: ATTESTER,
    });
  });

  it('shows "No" with a reason when verify returns false (revoked)', async () => {
    state.attestMocks.get.mockResolvedValue({
      result: { unwrap: () => makeAttestation({ revoked_at: 2_000_000n }) },
    });
    state.attestMocks.verify.mockResolvedValue({ result: false });

    renderPage();
    openClaimTab();
    fillClaimForm();
    submitClaimForm();

    expect(await screen.findByText('No')).toBeDefined();
    expect(screen.getByText(/revoked by its attester/i)).toBeDefined();
  });

  it('shows "No" with a reason when verify returns false (wrong subject)', async () => {
    const otherSubject = `G${'C'.repeat(55)}`;
    state.attestMocks.get.mockResolvedValue({
      result: { unwrap: () => makeAttestation({ subject: otherSubject }) },
    });
    state.attestMocks.verify.mockResolvedValue({ result: false });

    renderPage();
    openClaimTab();
    fillClaimForm();
    submitClaimForm();

    expect(await screen.findByText('No')).toBeDefined();
    expect(screen.getByText(/not about the subject you gave/i)).toBeDefined();
  });

  it('shows "No — no attestation exists" when get throws AttestationNotFound (error 3)', async () => {
    state.attestMocks.get.mockRejectedValue(new Error('Error(Contract, #3)'));

    renderPage();
    openClaimTab();
    fillClaimForm();
    submitClaimForm();

    expect(await screen.findByText('No')).toBeDefined();
    expect(screen.getByText(/No attestation exists with this id/i)).toBeDefined();
    // verify should not be called if get fails
    expect(state.attestMocks.verify).not.toHaveBeenCalled();
  });

  it('shows an error panel when the network call fails', async () => {
    state.attestMocks.get.mockRejectedValue(new Error('fetch error'));

    renderPage();
    openClaimTab();
    fillClaimForm();
    submitClaimForm();

    // A network error surfaces through explain() — "Could not reach the network."
    expect(await screen.findByText(/could not reach the network/i)).toBeDefined();
    expect(screen.queryByText('Yes')).toBeNull();
    expect(screen.queryByText('No')).toBeNull();
  });
});
