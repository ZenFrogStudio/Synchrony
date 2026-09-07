const esbuild = require('esbuild');
const { version } = require('./package.json');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/**
 * Reports build state on single lines that a plain VS Code problem matcher can
 * read. esbuild's own pretty output spreads one error over several lines with a
 * blank line in the middle, which no inline matcher can follow — that is why
 * the usual advice is to install the esbuild-problem-matchers extension. Doing
 * it here instead keeps F5 working on a clean machine.
 */
const problemMatcherLog = {
  name: 'chronos-log',
  setup(build) {
    build.onStart(() => console.log('[build] started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(
          location
            ? `${location.file}:${location.line}:${location.column}: error: ${text}`
            : `error: ${text}`
        );
      }
      for (const { text, location } of result.warnings) {
        console.error(
          location
            ? `${location.file}:${location.line}:${location.column}: warning: ${text}`
            : `warning: ${text}`
        );
      }
      console.log(`[build] finished with ${result.errors.length} error(s)`);
    });
  }
};

const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  // Stamped into both bundles, so the version the MCP server announces to a
  // client is the one in package.json rather than a literal nobody remembers
  // to change.
  define: { 'process.env.CHRONOS_VERSION': JSON.stringify(version) },
  plugins: [problemMatcherLog]
};

async function main() {
  const contexts = await Promise.all([
    esbuild.context({
      ...shared,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
      external: ['vscode']
    }),
    /**
     * The MCP server: a plain Node process an agent spawns, bundled separately
     * because it is a second entry point rather than a second copy of the first.
     *
     * Deliberately *no* `external: ['vscode']`. There is no extension host here
     * to provide that module, so if this build ever resolves it, something on
     * this side has imported the wrong thing and the failure is the check.
     */
    esbuild.context({
      ...shared,
      entryPoints: ['src/mcp-server.ts'],
      outfile: 'dist/mcp-server.js'
    }),
    /**
     * The hub: the same rule as the MCP server — a plain Node process, no
     * `vscode` external, so a stray import fails the build rather than the run.
     */
    esbuild.context({
      ...shared,
      entryPoints: ['src/hub.ts'],
      outfile: 'dist/hub.js'
    })
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[chronos] watching...');
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
