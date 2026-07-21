/**
 * Vite resolves CSS imports (`import './app.css'`) into the bundle; `tsc` needs
 * to be told they exist. Side-effect only — nothing is read from the module.
 */
declare module '*.css';
