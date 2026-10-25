// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoadingMark } from './LoadingMark';

// The animated logo (PM-253): decorative, sized by the caller, three columns like the real logo.

describe('LoadingMark', () => {
  it('is decorative, so the caption beside it is what assistive tech announces', () => {
    const html = renderToStaticMarkup(<LoadingMark />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
  });

  it('draws the tile and the three board columns', () => {
    const html = renderToStaticMarkup(<LoadingMark />);
    expect(html.match(/loading-mark-tile/g)).toHaveLength(1);
    expect(html.match(/loading-mark-bar/g)).toHaveLength(3);
  });

  it('takes its size from the caller', () => {
    expect(renderToStaticMarkup(<LoadingMark size={40} />)).toContain('width:40px;height:40px');
  });
});
