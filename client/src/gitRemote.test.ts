import { describe, expect, it } from 'vitest';
import { remoteWebUrl } from './gitRemote';

describe('remoteWebUrl', () => {
  it('turns common remote forms into the repo page', () => {
    expect(remoteWebUrl('git@github.com:meap158/TiemNet.git')).toBe(
      'https://github.com/meap158/TiemNet',
    );
    expect(remoteWebUrl('https://github.com/meap158/TiemNet.git')).toBe(
      'https://github.com/meap158/TiemNet',
    );
    expect(remoteWebUrl('ssh://git@gitlab.com/group/sub/repo')).toBe(
      'https://gitlab.com/group/sub/repo',
    );
    expect(remoteWebUrl('https://user@bitbucket.org/team/repo.git/')).toBe(
      'https://bitbucket.org/team/repo',
    );
  });

  it('returns null for local and unusable remotes', () => {
    expect(remoteWebUrl('C:\\repos\\thing.git')).toBeNull();
    expect(remoteWebUrl('file:///srv/git/thing.git')).toBeNull();
    expect(remoteWebUrl('../other')).toBeNull();
    expect(remoteWebUrl('')).toBeNull();
    expect(remoteWebUrl(null)).toBeNull();
  });
});
