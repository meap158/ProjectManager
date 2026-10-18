import { expect, it } from 'vitest';
import { gitIdentityEnv, validateGitIdentity } from './gitIdentity.js';

it('validates a commit identity: both parts or neither, a real address', () => {
  expect(validateGitIdentity({ name: ' Ada ', email: ' ada@example.com ' })).toEqual({
    ok: true,
    value: { name: 'Ada', email: 'ada@example.com' },
  });
  expect(validateGitIdentity({ name: '', email: null })).toEqual({
    ok: true,
    value: { name: null, email: null },
  });
  expect(validateGitIdentity({ name: 'Ada', email: null }).ok).toBe(false);
  expect(validateGitIdentity({ name: 'Ada', email: 'not-an-email' }).ok).toBe(false);
  expect(validateGitIdentity({ name: 'A<da>', email: 'ada@example.com' }).ok).toBe(false);
});

it('sets the author, committer and gh credentials only for what is configured', () => {
  expect(gitIdentityEnv({ name: null, email: null }, null, {})).toEqual({});
  expect(gitIdentityEnv({ name: 'Ada', email: 'ada@example.com' }, null, {})).toEqual({
    GIT_AUTHOR_NAME: 'Ada',
    GIT_COMMITTER_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
  });
  const withToken = gitIdentityEnv({ name: null, email: null }, 'tok', {});
  expect(withToken.GH_TOKEN).toBe('tok');
  expect(withToken.GIT_CONFIG_COUNT).toBe('2');
  expect(withToken.GIT_CONFIG_VALUE_1).toBe('!gh auth git-credential');
});

it('appends to git config the user already passes through the environment', () => {
  const env = gitIdentityEnv({ name: null, email: null }, 'tok', { GIT_CONFIG_COUNT: '3' });
  expect(env.GIT_CONFIG_COUNT).toBe('5');
  expect(env.GIT_CONFIG_KEY_3).toBe('credential.https://github.com.helper');
  expect(env.GIT_CONFIG_VALUE_4).toBe('!gh auth git-credential');
  expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
});
