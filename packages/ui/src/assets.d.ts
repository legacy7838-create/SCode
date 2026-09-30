declare module "*.css";
declare module "*.mp3";
declare module "*.png";
declare module "*.svg";
declare module "*.webp";

// Vite's `?url` resource import (such as pdf.js worker) returns the packaged resource URL string.
declare module "*?url" {
  const src: string;
  export default src;
}
