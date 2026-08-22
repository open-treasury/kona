/**
 * Bun's bundler turns a side-effect CSS import into a stylesheet asset. TypeScript 7 has no
 * knowledge of that, and `types` defaults to `[]`, so the declaration has to be ours.
 */
declare module "*.css";
