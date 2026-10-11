import { useEffect, useRef, useState } from 'react';

export function pairingQrUrl(data: string): string | null {
  try {
    const url = new URL(data);
    const host = url.hostname.toLowerCase();
    const octets = host.split('.').map(Number);
    const privateIp =
      octets.length === 4 &&
      octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31));
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (!host.endsWith('.local') && !privateIp) ||
      url.pathname !== '/' ||
      url.search ||
      !/^#pair=[A-Z0-9-]{4,9}$/.test(url.hash)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function decodePairingPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const { default: decode } = await import('jsqr');
  const result = decode(pixels, width, height);
  return result ? pairingQrUrl(result.data) : null;
}

export function LanQrScanner() {
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function scan(file: File) {
    setBusy(true);
    setError('');
    setUrl(null);
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Could not read this photo. Try a JPG or PNG.'));
      });
      image.src = objectUrl;
      await loaded;
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context)
        throw new Error(
          'Photo scanning is unavailable in this browser. Use your phone Camera app to scan the code.',
        );
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const pairing = await decodePairingPixels(pixels.data, canvas.width, canvas.height);
      canvas.width = canvas.height = 0;
      if (!pairing)
        throw new Error(
          'No ProjectManager pairing QR found. Take a clear photo of the QR shown in Settings on your computer.',
        );
      if (active.current) setUrl(pairing);
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      URL.revokeObjectURL(objectUrl);
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="lan-scan">
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        aria-label="Pairing QR photo"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void scan(file);
        }}
      />
      <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Reading QR…' : 'Scan pairing QR'}
      </button>
      <p className="faint">
        Take a photo of the QR on your computer, or choose a saved image. Photos are processed on
        this device.
      </p>
      {error && <p role="alert">{error}</p>}
      {url && (
        <div>
          <p>Connect to {new URL(url).host}</p>
          <a className="btn btn-primary" href={url}>
            Open sign-in page
          </a>
        </div>
      )}
    </div>
  );
}
