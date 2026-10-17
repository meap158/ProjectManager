// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Dropdown } from './Dropdown';
afterEach(cleanup);
it('keeps multi-select open, toggles choices, summarizes and clears them', () => {
  function Filter() {
    const [values, setValues] = useState<string[]>([]);
    return (
      <Dropdown
        label="Agent"
        value="all"
        onChange={() => {}}
        multiple={{ values, allValue: 'all', onChange: setValues }}
        options={[
          { value: 'all', label: 'All agents' },
          { value: 'claude', label: 'Claude' },
          { value: 'codex', label: 'Codex' },
        ]}
      />
    );
  }
  render(<Filter />);
  fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Claude' }));
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');
  expect(screen.getByRole('button', { name: 'Agent' }).textContent).toContain('Agent (2)');
  expect(screen.getAllByRole('option', { selected: true })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Claude' }));
  expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'All agents' }));
  expect(screen.getByRole('button', { name: 'Agent' }).textContent).toContain('All agents');
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('Ctrl+click selects only the clicked item in a multi-select dropdown', () => {
  function Filter() {
    const [values, setValues] = useState<string[]>(['claude', 'codex']);
    return (
      <Dropdown
        label="Agent"
        value="all"
        onChange={() => {}}
        multiple={{ values, allValue: 'all', onChange: setValues }}
        options={[
          { value: 'all', label: 'All agents' },
          { value: 'claude', label: 'Claude' },
          { value: 'codex', label: 'Codex' },
          { value: 'opencode', label: 'OpenCode' },
        ]}
      />
    );
  }
  render(<Filter />);
  fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
  expect(screen.getAllByRole('option', { selected: true })).toHaveLength(2);
  // Ctrl+click on OpenCode should exclusively select OpenCode only
  fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }), { ctrlKey: true });
  expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1);
  expect(screen.getByRole('option', { name: /OpenCode/i }).getAttribute('aria-selected')).toBe(
    'true',
  );
  expect(screen.getByRole('button', { name: 'Agent' }).textContent).toContain('OpenCode');
});
