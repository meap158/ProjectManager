import { describe, expect, it } from 'vitest';
import { iconFor } from './fileIcons';

const file = (name: string) => ({ name, kind: 'file' as const });
const dir = (name: string) => ({ name, kind: 'dir' as const });

describe('iconFor', () => {
  it('matches exact names before extensions', () => {
    expect(iconFor(file('package.json')).glyph).toBe('json');
    expect(iconFor(file('package.json')).tone).toBe('danger');
    expect(iconFor(file('data.json')).tone).toBe('data');
    expect(iconFor(file('pnpm-lock.yaml')).glyph).toBe('lock');
    expect(iconFor(file('.gitignore')).glyph).toBe('git');
    expect(iconFor(file('Dockerfile')).glyph).toBe('config');
    expect(iconFor(file('README.md')).glyph).toBe('markdown');
    expect(iconFor(file('LICENSE')).glyph).toBe('text');
  });

  it('is case-insensitive and treats env variants as config', () => {
    expect(iconFor(file('README.MD')).glyph).toBe('markdown');
    expect(iconFor(file('.env.local')).glyph).toBe('config');
    expect(iconFor(file('.env.example')).glyph).toBe('config');
  });

  it('chooses by extension, tests first, then a plain page for the unknown', () => {
    expect(iconFor(file('app.tsx')).glyph).toBe('code');
    expect(iconFor(file('server.test.ts')).glyph).toBe('test');
    expect(iconFor(file('styles.css')).glyph).toBe('style');
    expect(iconFor(file('run.sh')).glyph).toBe('shell');
    expect(iconFor(file('photo.JPG')).glyph).toBe('image');
    expect(iconFor(file('trace.log')).glyph).toBe('text');
    expect(iconFor(file('mystery.xyz')).glyph).toBe('file');
    expect(iconFor(file('noextension')).glyph).toBe('file');
    // A leading dot alone is a name, not an extension.
    expect(iconFor(file('.profile')).glyph).toBe('file');
  });

  it('shows open and closed folders, and marks the well-known ones', () => {
    expect(iconFor(dir('src'), false).glyph).toBe('folder');
    expect(iconFor(dir('src'), true).glyph).toBe('folder-open');
    expect(iconFor(dir('node_modules'), false).glyph).toBe('folder-special');
    expect(iconFor(dir('.GitHub')).glyph).toBe('folder-special');
  });
});
