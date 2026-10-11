import { gzipSync } from 'node:zlib';

// Compare identical production builds without altering sources or a running dev server.
process.env.NODE_ENV = 'production';
const { build } = await import('vite');
for (const eager of [true, false]) {
  const result = await build({
    logLevel: 'error',
    build: { write: false },
    plugins: eager
      ? [
          {
            name: 'benchmark-eager-routes',
            enforce: 'pre',
            transform(source, id) {
              if (!id.replaceAll('\\', '/').endsWith('/client/src/App.tsx')) return;
              return source.replace(
                /const (\w+) = lazy\([\s\S]*?\);/g,
                (_, name) => `import { ${name} } from './pages/${name}';`,
              );
            },
          },
        ]
      : [],
  });
  const output = result.output;
  const entry = output.find((item) => item.type === 'chunk' && item.isEntry);
  const initial = new Set();
  const visit = (name) => {
    if (initial.has(name)) return;
    initial.add(name);
    const chunk = output.find((item) => item.type === 'chunk' && item.fileName === name);
    for (const dependency of chunk?.imports ?? []) visit(dependency);
  };
  visit(entry.fileName);
  const chunks = output.filter((item) => item.type === 'chunk' && initial.has(item.fileName));
  console.log(
    JSON.stringify({
      routes: eager ? 'eager' : 'lazy',
      initialJsBytes: chunks.reduce((n, item) => n + Buffer.byteLength(item.code), 0),
      initialJsGzipBytes: chunks.reduce((n, item) => n + gzipSync(item.code).length, 0),
      chunks: chunks.map((item) => item.fileName),
    }),
  );
}
