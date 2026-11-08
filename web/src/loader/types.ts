export interface ReadOptions {
  signal?: AbortSignal;
}

export interface DiscSource {
  name: string;
  size: number;
  read(offset: number, length: number, options?: ReadOptions): Promise<Uint8Array<ArrayBuffer>>;
}

export type DiscSources = Map<string, DiscSource>;

export interface CueTrack {
  number: number;
  audio: boolean;
  file: string;
  index: number;
}

export interface DiscTrack extends CueTrack {
  source: DiscSource | undefined;
  start: number;
  end: number;
  toc: number;
}

export interface DiscReference {
  executable: { name: string; sha256: string };
  tracks: (CueTrack & { size: number })[];
}

export interface DiscAssets {
  files: Map<string, Uint8Array<ArrayBuffer>>;
  tracks: DiscTrack[];
  leadout: number;
  readAudio(track: number): Promise<Uint8Array<ArrayBuffer>>;
  readMovie(name: string, options?: ReadOptions): Promise<Uint8Array<ArrayBuffer>>;
}

export interface LoaderProgress {
  progress?: (message: string) => void;
  warn?: (message: string) => void;
}
