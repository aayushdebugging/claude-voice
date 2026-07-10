/**
 * Ambient declarations for optional, untyped native dependencies.
 *
 * `speaker` and `node-record-lpcm16` are optionalDependencies loaded via
 * dynamic `import()` and cast to local interfaces at the call site. They ship
 * no types (and may not even be installed if their native build fails), so we
 * declare them here to keep the compiler happy without pulling in `any` at the
 * boundaries where it matters.
 */
declare module 'speaker';
declare module 'node-record-lpcm16';
declare module 'qrcode-terminal';
