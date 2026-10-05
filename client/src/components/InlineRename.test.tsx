// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InlineRename } from './InlineRename';

describe('InlineRename', () => {
  it('saves a changed name on Enter', () => {
    const onSave = vi.fn(async () => undefined);
    render(<InlineRename value="Claude Code" label="session" onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    const box = screen.getByRole('textbox', { name: 'Session name' });
    fireEvent.change(box, { target: { value: '  Fix login  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('Fix login');
  });

  it('Escape cancels, and an unchanged or blank name is not saved', () => {
    const onSave = vi.fn(async () => undefined);
    const onEditingChange = vi.fn();
    render(
      <InlineRename
        value="Shell"
        label="session"
        onSave={onSave}
        onEditingChange={onEditingChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Shell' }));
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Other' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Shell' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Shell' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onSave).not.toHaveBeenCalled();
  });
});
