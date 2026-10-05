import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { AnimatedCounter } from './ui/animated-counter';

/** Splits a byte count into a value + unit so the number can animate while the unit stays put. */
export function bytesParts(bytes: number): { value: number; decimals: number; unit: string } {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const decimals = unit === 0 || value >= 10 ? 0 : 1;
  return { value: Number(value.toFixed(decimals)), decimals, unit: units[unit]! };
}

/** A headline number. Pass `value` for an animated count, or `text` for non-numeric values. */
export function StatTile({
  label,
  value,
  decimals = 0,
  suffix,
  text,
  hint,
  to,
  linkTitle,
}: {
  label: string;
  value?: number;
  decimals?: number;
  suffix?: string;
  text?: ReactNode;
  hint?: ReactNode;
  /** Makes the tile a link to where these items are listed. */
  to?: string;
  linkTitle?: string;
}) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className={value === undefined ? 'value value-text' : 'value'}>
        {value !== undefined ? (
          <AnimatedCounter
            value={value}
            decimals={decimals}
            suffix={suffix ? <span className="stat-unit">{suffix}</span> : undefined}
          />
        ) : (
          text
        )}
      </div>
      {hint && (
        <div className="hint" title={typeof hint === 'string' ? hint : undefined}>
          {hint}
        </div>
      )}
    </>
  );
  return to ? (
    <Link to={to} className="stat stat-link" title={linkTitle}>
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}

export function BytesTile({
  label,
  bytes,
  hint,
}: {
  label: string;
  bytes: number;
  hint?: ReactNode;
}) {
  const { value, decimals, unit } = bytesParts(bytes);
  return <StatTile label={label} value={value} decimals={decimals} suffix={unit} hint={hint} />;
}
