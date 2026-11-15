/// <reference types="astro/client" />

declare namespace astroHTML.JSX {
  interface InputHTMLAttributes {
    webkitdirectory?: boolean;
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_BUILD_COMMIT: string;
}
