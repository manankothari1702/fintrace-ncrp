/**
 * ModalShell tests — the shared portal-based modal shell that fixed the
 * "transparent" User Management / Backups modals. Guards the behaviour that was
 * missing before: the dialog is portalled to <body> (escaping the top-bar
 * stacking context) and carries the opaque .modal-panel class on a .modal-overlay
 * scrim; Esc and backdrop-click close it, a click inside the panel does not.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ModalShell from '../components/ModalShell.jsx';

describe('ModalShell', () => {
  test('portals an opaque panel onto <body> over a scrim', () => {
    render(
      <div data-testid="page">
        <p>Drag &amp; drop your NCRP file here</p>
        <ModalShell onClose={() => {}} ariaLabel="Test modal" panelClassName="um-modal">
          <p>modal content</p>
        </ModalShell>
      </div>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Test modal' });
    // Opaque panel (var(--card-bg)) + caller sizing class, on the scrim overlay.
    expect(dialog).toHaveClass('modal-panel');
    expect(dialog).toHaveClass('um-modal');
    expect(dialog.closest('.modal-overlay')).not.toBeNull();
    // Portalled to <body>, NOT nested inside the page container that rendered it.
    expect(document.body.contains(dialog)).toBe(true);
    expect(screen.getByTestId('page').contains(dialog)).toBe(false);
  });

  test('Esc and backdrop-click close it; a click inside the panel does not', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ModalShell onClose={onClose} ariaLabel="Test modal">
        <p>modal content</p>
      </ModalShell>,
    );

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    // Click inside the panel — must NOT close.
    fireEvent.mouseDown(screen.getByText('modal content'));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Mousedown on the backdrop itself — closes.
    fireEvent.mouseDown(screen.getByRole('dialog').closest('.modal-overlay'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
