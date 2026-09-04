// esbuild alias target: Ink imports react-devtools-core only when DEV=true,
// but single-file bundling hoists the external import into a hard one. The
// released cli never runs the devtools, so the module is stubbed out whole.
export default { connectToDevTools() {}, initialize() {} };
