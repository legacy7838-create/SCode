/**
 * The ui package runs its own typecheck, and the side-effect CSS imports in the component sources
 * are parsed directly too. Previously only web/desktop declared *.css, which made third-party
 * styles imported inside ui report TS2882 in this project. Declaring ui's own styles here keeps the
 * type check consistent with how the real bundler handles them.
 */
declare module "*.css";
