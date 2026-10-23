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

it('searches long lists without changing selection until a result is chosen', () => {
  const options = Array.from({ length: 9 }, (_, index) => ({
    value: String(index),
    label: `Project ${index}`,
  }));
  function Picker() {
    const [value, setValue] = useState('0');
    return <Dropdown label="Project" value={value} options={options} onChange={setValue} />;
  }
  render(<Picker />);
  fireEvent.click(screen.getByRole('button', { name: 'Project' }));
  const search = screen.getByRole('searchbox', { name: 'Search Project' });
  expect(document.activeElement).toBe(search);
  fireEvent.change(search, { target: { value: 'PROJECT 7' } });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Project' }).textContent).toContain('Project 0');
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Project 7' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('button', { name: 'Project' }).textContent).toContain('Project 7');
  fireEvent.click(screen.getByRole('button', { name: 'Project' }));
  expect(screen.getAllByRole('option')).toHaveLength(9);
});

it('keeps empty searches and disabled results from selecting another value', () => {
  render(
    <Dropdown
      label="Project"
      value="a"
      searchable
      onChange={() => {
        throw new Error('Must not select');
      }}
      options={[
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Blocked', disabled: true },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Project' }));
  const search = screen.getByRole('searchbox');
  fireEvent.change(search, { target: { value: 'missing' } });
  expect(screen.getByRole('status').textContent).toBe('No matching options');
  fireEvent.keyDown(search, { key: 'Enter' });
  fireEvent.change(search, { target: { value: 'Blocked' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Project' }));
});
it('does not focus the search field when a phone dropdown opens', () => {
  const previous = window.matchMedia;
  window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
  try {
    render(
      <Dropdown
        label="Project"
        value="0"
        onChange={() => {}}
        options={Array.from({ length: 9 }, (_, i) => ({ value: String(i), label: `Project ${i}` }))}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    const search = screen.getByRole('searchbox');
    expect(document.activeElement).not.toBe(search);
    search.focus();
    expect(document.activeElement).toBe(search);
  } finally {
    window.matchMedia = previous;
  }
});
